use std::sync::Mutex;
use tauri::{Manager, Emitter};
use tauri_plugin_shell::ShellExt;

enum SidecarChild {
    Tauri(tauri_plugin_shell::process::CommandChild),
    Direct(std::process::Child),
}

impl SidecarChild {
    fn kill(self) {
        match self {
            SidecarChild::Tauri(c) => { let _ = c.kill(); }
            SidecarChild::Direct(mut c) => { let _ = c.kill(); }
        }
    }
}

struct SidecarState {
    child: Option<SidecarChild>,
}

// ─── macOS Permissions ──────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

#[tauri::command]
async fn request_screen_access() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let has = unsafe { CGPreflightScreenCaptureAccess() };
        if has { return Ok(true); }
        Ok(unsafe { CGRequestScreenCaptureAccess() })
    }
    #[cfg(not(target_os = "macos"))]
    { Ok(true) }
}

#[tauri::command]
async fn check_screen_access() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    { Ok(unsafe { CGPreflightScreenCaptureAccess() }) }
    #[cfg(not(target_os = "macos"))]
    { Ok(true) }
}

// ─── System Audio Capture (macOS CoreAudio Process Tap via cidre) ───────────
//
// Based on Meetily's proven implementation.
// Uses CoreAudio process tap (macOS 14.2+) via cidre crate.
// Permission dialog ("Audio Capture") appears automatically.
// No screen picker, no manual permission prompts.

#[cfg(target_os = "macos")]
mod system_audio {
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::{Arc, Mutex};
    use std::task::Waker;
    use cidre::{arc, av, cat, cf, core_audio as ca, os};
    use ringbuf::{
        traits::{Consumer, Producer, Split},
        HeapCons, HeapProd, HeapRb,
    };

    struct WakerState {
        waker: Option<Waker>,
        has_data: bool,
    }

    struct AudioContext {
        format: arc::R<av::AudioFormat>,
        producer: HeapProd<f32>,
        waker_state: Arc<Mutex<WakerState>>,
        current_sample_rate: Arc<AtomicU32>,
        consecutive_drops: Arc<AtomicU32>,
        should_terminate: Arc<AtomicBool>,
    }

    pub struct CoreAudioStream {
        consumer: HeapCons<f32>,
        _device: ca::hardware::StartedDevice<ca::AggregateDevice>,
        _ctx: Box<AudioContext>,
        _tap: ca::TapGuard,
    }

    fn create_tap_and_desc() -> Result<(ca::TapGuard, arc::Retained<cf::DictionaryOf<cf::String, cf::Type>>), String> {
        let output_device = ca::System::default_output_device()
            .map_err(|e| format!("Failed to get default output device: {:?}", e))?;

        let output_uid = output_device.uid()
            .map_err(|e| format!("Failed to get device UID: {:?}", e))?;

        // Create process tap (mono global tap, no excluded processes)
        let tap_desc = ca::TapDesc::with_mono_global_tap_excluding_processes(
            &cidre::ns::Array::new(),
        );
        let tap = tap_desc.create_process_tap()
            .map_err(|e| format!("Failed to create process tap: {:?}", e))?;

        println!("[system-audio] Process tap created");

        // Create sub-tap dictionary
        let sub_tap = cf::DictionaryOf::with_keys_values(
            &[ca::sub_device_keys::uid()],
            &[tap.uid().unwrap().as_type_ref()],
        );

        // Aggregate device: tap only (no output device → no echo)
        let agg_desc = cf::DictionaryOf::with_keys_values(
            &[
                ca::aggregate_device_keys::is_private(),
                ca::aggregate_device_keys::is_stacked(),
                ca::aggregate_device_keys::tap_auto_start(),
                ca::aggregate_device_keys::name(),
                ca::aggregate_device_keys::main_sub_device(),
                ca::aggregate_device_keys::uid(),
                ca::aggregate_device_keys::tap_list(),
            ],
            &[
                cf::Boolean::value_true().as_type_ref(),
                cf::Boolean::value_false(),
                cf::Boolean::value_true(),
                cf::str!(c"scribble-audio-tap").as_type_ref(),
                &output_uid,
                &cf::Uuid::new().to_cf_string(),
                &cf::ArrayOf::from_slice(&[sub_tap.as_ref()]),
            ],
        );

        Ok((tap, agg_desc))
    }

    fn process_audio_data(ctx: &mut AudioContext, data: &[f32]) {
        let pushed = ctx.producer.push_slice(data);

        if pushed < data.len() {
            let consecutive = ctx.consecutive_drops.fetch_add(1, Ordering::AcqRel) + 1;
            if consecutive > 10 {
                ctx.should_terminate.store(true, Ordering::Release);
                return;
            }
        } else {
            ctx.consecutive_drops.store(0, Ordering::Release);
        }

        if pushed > 0 {
            let should_wake = {
                let mut ws = ctx.waker_state.lock().unwrap();
                if !ws.has_data {
                    ws.has_data = true;
                    ws.waker.take()
                } else {
                    None
                }
            };
            if let Some(waker) = should_wake {
                waker.wake();
            }
        }
    }

    fn start_device(
        agg_desc: &cf::DictionaryOf<cf::String, cf::Type>,
        ctx: &mut Box<AudioContext>,
    ) -> Result<ca::hardware::StartedDevice<ca::AggregateDevice>, String> {
        extern "C" fn audio_proc(
            device: ca::Device,
            _now: &cat::AudioTimeStamp,
            input_data: &cat::AudioBufList<1>,
            _input_time: &cat::AudioTimeStamp,
            _output_data: &mut cat::AudioBufList<1>,
            _output_time: &cat::AudioTimeStamp,
            ctx: Option<&mut AudioContext>,
        ) -> os::Status {
            let ctx = ctx.unwrap();

            let after = device
                .nominal_sample_rate()
                .unwrap_or(ctx.format.absd().sample_rate) as u32;
            let before = ctx.current_sample_rate.load(Ordering::Acquire);
            if before != after {
                ctx.current_sample_rate.store(after, Ordering::Release);
            }

            if let Some(view) =
                av::AudioPcmBuf::with_buf_list_no_copy(&ctx.format, input_data, None)
            {
                if let Some(data) = view.data_f32_at(0) {
                    process_audio_data(ctx, data);
                }
            } else if ctx.format.common_format() == av::audio::CommonFormat::PcmF32 {
                let first_buffer = &input_data.buffers[0];
                let byte_count = first_buffer.data_bytes_size as usize;
                let float_count = byte_count / std::mem::size_of::<f32>();
                if float_count > 0 && first_buffer.data != std::ptr::null_mut() {
                    let data = unsafe {
                        std::slice::from_raw_parts(first_buffer.data as *const f32, float_count)
                    };
                    process_audio_data(ctx, data);
                }
            }

            os::Status::NO_ERR
        }

        let agg_device = ca::AggregateDevice::with_desc(agg_desc)
            .map_err(|e| format!("Failed to create aggregate device: {:?}", e))?;

        let proc_id = agg_device.create_io_proc_id(audio_proc, Some(ctx))
            .map_err(|e| format!("Failed to create IO proc: {:?}", e))?;

        let started = ca::device_start(agg_device, Some(proc_id))
            .map_err(|e| format!("Failed to start device: {:?}", e))?;

        println!("[system-audio] Aggregate device started");
        Ok(started)
    }

    pub fn create_stream() -> Result<(CoreAudioStream, u32), String> {
        let (tap, agg_desc) = create_tap_and_desc()?;

        let asbd = tap.asbd()
            .map_err(|e| format!("Failed to get tap ASBD: {:?}", e))?;

        let format = av::AudioFormat::with_asbd(&asbd)
            .ok_or_else(|| "Failed to create audio format".to_string())?;

        let sample_rate = asbd.sample_rate as u32;
        println!("[system-audio] Tap format: {} Hz, {} ch", asbd.sample_rate, asbd.channels_per_frame);

        let rb = HeapRb::<f32>::new(1024 * 128);
        let (producer, consumer) = rb.split();

        let waker_state = Arc::new(Mutex::new(WakerState {
            waker: None,
            has_data: false,
        }));

        let current_sample_rate = Arc::new(AtomicU32::new(sample_rate));

        let mut ctx = Box::new(AudioContext {
            format,
            producer,
            waker_state: waker_state.clone(),
            current_sample_rate: current_sample_rate.clone(),
            consecutive_drops: Arc::new(AtomicU32::new(0)),
            should_terminate: Arc::new(AtomicBool::new(false)),
        });

        let device = start_device(&agg_desc, &mut ctx)?;

        let stream = CoreAudioStream {
            consumer,
            _device: device,
            _ctx: ctx,
            _tap: tap,
        };

        println!("[system-audio] ✅ Capture started at {} Hz", sample_rate);
        Ok((stream, sample_rate))
    }

    impl CoreAudioStream {
        /// Drain available samples into the provided buffer
        pub fn drain_samples(&mut self, out: &mut Vec<f32>) {
            while let Some(s) = self.consumer.try_pop() {
                out.push(s);
            }
        }
    }

    impl Drop for CoreAudioStream {
        fn drop(&mut self) {
            println!("[system-audio] Stream dropped, stopping capture");
            self._ctx.should_terminate.store(true, Ordering::Release);
        }
    }

    // ─── Capture State for Tauri ────────────────────────────────────────────
    pub struct CaptureState {
        pub running: AtomicBool,
        stream: Mutex<Option<CoreAudioStream>>,
    }

    impl CaptureState {
        pub fn new() -> Self {
            Self {
                running: AtomicBool::new(false),
                stream: Mutex::new(None),
            }
        }
    }

    pub fn start_capture(state: &CaptureState) -> Result<u32, String> {
        if state.running.load(Ordering::Relaxed) {
            return Err("Already capturing".to_string());
        }

        let (audio_stream, sample_rate) = create_stream()?;
        *state.stream.lock().unwrap() = Some(audio_stream);
        state.running.store(true, Ordering::Relaxed);
        Ok(sample_rate)
    }

    pub fn drain_buffer(state: &CaptureState) -> Vec<f32> {
        let mut out = Vec::new();
        if let Ok(mut guard) = state.stream.lock() {
            if let Some(stream) = guard.as_mut() {
                stream.drain_samples(&mut out);
            }
        }
        out
    }

    pub fn stop_capture(state: &CaptureState) {
        *state.stream.lock().unwrap() = None; // Drop stops capture
        state.running.store(false, Ordering::Relaxed);
        println!("[system-audio] Capture stopped");
    }
}

// ─── System Audio Capture (Windows WASAPI Loopback) ─────────────────────────
//
// Captures system audio output using WASAPI loopback mode.
// Same API as macOS CoreAudio: CaptureState with start/drain/stop.

#[cfg(target_os = "windows")]
mod system_audio_windows {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use ringbuf::{
        traits::{Consumer, Producer, Split},
        HeapCons, HeapProd, HeapRb,
    };

    pub struct CaptureState {
        pub running: AtomicBool,
        consumer: Mutex<Option<HeapCons<f32>>>,
        stop_flag: Arc<AtomicBool>,
        capture_thread: Mutex<Option<std::thread::JoinHandle<()>>>,
        sample_rate: Mutex<u32>,
    }

    impl CaptureState {
        pub fn new() -> Self {
            Self {
                running: AtomicBool::new(false),
                consumer: Mutex::new(None),
                stop_flag: Arc::new(AtomicBool::new(false)),
                capture_thread: Mutex::new(None),
                sample_rate: Mutex::new(0),
            }
        }
    }

    pub fn start_capture(state: &CaptureState) -> Result<u32, String> {
        if state.running.load(Ordering::Relaxed) {
            return Err("Already capturing".to_string());
        }

        let rb = HeapRb::<f32>::new(1024 * 128);
        let (producer, consumer) = rb.split();
        *state.consumer.lock().unwrap() = Some(consumer);

        let stop_flag = state.stop_flag.clone();
        stop_flag.store(false, Ordering::Release);

        // Start WASAPI capture in a dedicated thread (COM must init per-thread)
        let (tx, rx) = std::sync::mpsc::channel::<Result<u32, String>>();

        let handle = std::thread::spawn(move || {
            match wasapi_capture_loop(producer, stop_flag, tx) {
                Ok(()) => println!("[system-audio-win] Capture thread exited cleanly"),
                Err(e) => eprintln!("[system-audio-win] Capture thread error: {}", e),
            }
        });

        // Wait for sample rate from capture thread
        let sample_rate = rx.recv()
            .map_err(|e| format!("Capture thread failed to start: {}", e))?
            .map_err(|e| format!("WASAPI init failed: {}", e))?;

        *state.sample_rate.lock().unwrap() = sample_rate;
        *state.capture_thread.lock().unwrap() = Some(handle);
        state.running.store(true, Ordering::Relaxed);

        println!("[system-audio-win] Capture started at {} Hz", sample_rate);
        Ok(sample_rate)
    }

    pub fn drain_buffer(state: &CaptureState) -> Vec<f32> {
        let mut out = Vec::new();
        if let Ok(mut guard) = state.consumer.lock() {
            if let Some(consumer) = guard.as_mut() {
                while let Some(s) = consumer.try_pop() {
                    out.push(s);
                }
            }
        }
        out
    }

    pub fn stop_capture(state: &CaptureState) {
        state.stop_flag.store(true, Ordering::Release);
        // Wait for capture thread to finish
        if let Some(handle) = state.capture_thread.lock().unwrap().take() {
            let _ = handle.join();
        }
        *state.consumer.lock().unwrap() = None;
        state.running.store(false, Ordering::Relaxed);
        println!("[system-audio-win] Capture stopped");
    }

    fn wasapi_capture_loop(
        mut producer: HeapProd<f32>,
        stop_flag: Arc<AtomicBool>,
        ready_tx: std::sync::mpsc::Sender<Result<u32, String>>,
    ) -> Result<(), String> {
        use windows::Win32::Media::Audio::*;
        use windows::Win32::System::Com::*;

        unsafe {
            // Initialize COM for this thread
            CoInitializeEx(None, COINIT_MULTITHREADED)
                .ok()
                .map_err(|e| format!("CoInitializeEx failed: {}", e))?;

            // Get default audio output device
            let enumerator: IMMDeviceEnumerator = CoCreateInstance(
                &MMDeviceEnumerator,
                None,
                CLSCTX_ALL,
            ).map_err(|e| format!("Failed to create device enumerator: {}", e))?;

            let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)
                .map_err(|e| format!("Failed to get default output device: {}", e))?;

            // Activate audio client
            let audio_client: IAudioClient = device.Activate(CLSCTX_ALL, None)
                .map_err(|e| format!("Failed to activate audio client: {}", e))?;

            // Get mix format
            let mix_format_ptr = audio_client.GetMixFormat()
                .map_err(|e| format!("Failed to get mix format: {}", e))?;
            let mix_format = &*mix_format_ptr;
            let sample_rate = mix_format.nSamplesPerSec;
            let channels = mix_format.nChannels as usize;
            let bits_per_sample = mix_format.wBitsPerSample;
            let block_align = mix_format.nBlockAlign as usize;

            println!("[system-audio-win] Mix format: {} Hz, {} ch, {} bits",
                sample_rate, channels, bits_per_sample);

            // Initialize in LOOPBACK mode (capture what speakers play)
            let buffer_duration: i64 = 2_000_000; // 200ms in 100-nanosecond units
            audio_client.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK,
                buffer_duration,
                0,
                mix_format_ptr,
                None,
            ).ok().map_err(|e| format!("Failed to initialize audio client: {}", e))?;

            // Get capture client
            let capture_client: IAudioCaptureClient = audio_client.GetService()
                .map_err(|e| format!("Failed to get capture client: {}", e))?;

            // Start capturing
            audio_client.Start()
                .ok().map_err(|e| format!("Failed to start audio client: {}", e))?;

            // Signal ready with sample rate
            let _ = ready_tx.send(Ok(sample_rate));

            // Capture loop
            while !stop_flag.load(Ordering::Acquire) {
                std::thread::sleep(std::time::Duration::from_millis(10));

                let mut packet_length = match capture_client.GetNextPacketSize() {
                    Ok(len) => len,
                    Err(_) => continue,
                };

                while packet_length > 0 {
                    let mut buffer_ptr = std::ptr::null_mut();
                    let mut num_frames = 0u32;
                    let mut flags = 0u32;

                    if capture_client.GetBuffer(
                        &mut buffer_ptr,
                        &mut num_frames,
                        &mut flags,
                        None,
                        None,
                    ).is_err() {
                        break;
                    }

                    if num_frames > 0 && !buffer_ptr.is_null() {
                        let silent = (flags & 0x2) != 0; // AUDCLNT_BUFFERFLAGS_SILENT = 0x2

                        if !silent {
                            let total_samples = num_frames as usize * channels;

                            // Handle float32 format (most common for WASAPI shared mode)
                            if bits_per_sample == 32 {
                                let float_samples: &[f32] = std::slice::from_raw_parts(
                                    buffer_ptr as *const f32, total_samples
                                );
                                for frame in float_samples.chunks(channels) {
                                    let mono: f32 = frame.iter().sum::<f32>() / channels as f32;
                                    let _ = producer.try_push(mono);
                                }
                            } else if bits_per_sample == 16 {
                                let i16_samples: &[i16] = std::slice::from_raw_parts(
                                    buffer_ptr as *const i16, total_samples
                                );
                                for frame in i16_samples.chunks(channels) {
                                    let mono: f32 = frame.iter()
                                        .map(|&s| s as f32 / 32768.0)
                                        .sum::<f32>() / channels as f32;
                                    let _ = producer.try_push(mono);
                                }
                            }
                        } else {
                            for _ in 0..num_frames {
                                let _ = producer.try_push(0.0f32);
                            }
                        }
                    }

                    let _ = capture_client.ReleaseBuffer(num_frames);
                    packet_length = capture_client.GetNextPacketSize().unwrap_or(0);
                }
            }

            // Cleanup
            let _ = audio_client.Stop();
            CoUninitialize();
            Ok(())
        }
    }
}

// ─── Tauri Commands ─────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
struct SystemAudioState(system_audio::CaptureState);

#[cfg(target_os = "windows")]
struct SystemAudioState(system_audio_windows::CaptureState);

#[tauri::command]
async fn start_system_audio(app: tauri::AppHandle, _draft_id: Option<i64>) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let state = app.state::<SystemAudioState>();
        let sample_rate = system_audio::start_capture(&state.0)?;
        let app_handle = app.clone();
        let meeting_id = _draft_id;
        tauri::async_runtime::spawn(async move {
            system_audio_ws_loop(&app_handle, sample_rate, meeting_id, |st| {
                system_audio::drain_buffer(&st.0)
            }).await;
        });
        Ok(format!("System audio started at {} Hz", sample_rate))
    }
    #[cfg(target_os = "windows")]
    {
        let state = app.state::<SystemAudioState>();
        let sample_rate = system_audio_windows::start_capture(&state.0)?;
        let app_handle = app.clone();
        let meeting_id = _draft_id;
        tauri::async_runtime::spawn(async move {
            system_audio_ws_loop(&app_handle, sample_rate, meeting_id, |st| {
                system_audio_windows::drain_buffer(&st.0)
            }).await;
        });
        Ok(format!("System audio started at {} Hz", sample_rate))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = app;
        Err("System audio not supported on this platform".to_string())
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
async fn system_audio_ws_loop<F>(
    app_handle: &tauri::AppHandle,
    capture_rate: u32,
    meeting_id: Option<i64>,
    drain_fn: F,
) where F: Fn(&SystemAudioState) -> Vec<f32> {
    use tokio_tungstenite::{connect_async, tungstenite::Message};
    use futures_util::{SinkExt, StreamExt};

    let mut url = "ws://127.0.0.1:8765/ws/nvidia-stream?source=system".to_string();
    if let Some(mid) = meeting_id {
        url.push_str(&format!("&meeting_id={}", mid));
    }
    let ws_stream = match connect_async(&url).await {
        Ok((stream, _)) => {
            println!("[system-audio] WebSocket connected to {}", url);
            stream
        }
        Err(e) => {
            eprintln!("[system-audio] WebSocket connection failed: {}", e);
            return;
        }
    };

    let (mut ws_tx, mut ws_rx) = ws_stream.split();
    let app_for_rx = app_handle.clone();

    let reader = tauri::async_runtime::spawn(async move {
        while let Some(msg) = ws_rx.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    let _ = app_for_rx.emit("system-audio-transcript", &text);
                }
                Ok(Message::Close(_)) => { println!("[system-audio] WebSocket closed"); break; }
                Err(e) => { eprintln!("[system-audio] WebSocket error: {}", e); break; }
                _ => {}
            }
        }
    });

    let ratio = capture_rate as f64 / 16000.0;

    loop {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        let state_ref = app_handle.state::<SystemAudioState>();
        if !state_ref.0.running.load(std::sync::atomic::Ordering::Relaxed) {
            break;
        }

        let chunk = drain_fn(&state_ref);
        if chunk.is_empty() { continue; }

        // High-quality downsample to 16kHz using Hanning-windowed sinc filter
        let output_len = (chunk.len() as f64 / ratio).floor() as usize;
        if output_len == 0 { continue; }

        let filter_half = (ratio.ceil() as usize) * 2 + 1;
        let cutoff = 1.0 / ratio;

        let mut pcm16 = Vec::with_capacity(output_len * 2);
        for i in 0..output_len {
            let center = i as f64 * ratio;
            let center_int = center.round() as i64;
            let mut sum = 0.0f64;
            let mut weight_sum = 0.0f64;

            for k in -(filter_half as i64)..=(filter_half as i64) {
                let idx = center_int + k;
                if idx < 0 || idx >= chunk.len() as i64 { continue; }
                let x = idx as f64 - center;
                let sinc = if x.abs() < 1e-10 { 1.0 } else {
                    let px = std::f64::consts::PI * x * cutoff;
                    (px).sin() / px
                };
                let t = (k as f64 + filter_half as f64) / (2.0 * filter_half as f64);
                let window = 0.5 * (1.0 - (2.0 * std::f64::consts::PI * t).cos());
                let w = sinc * window;
                sum += chunk[idx as usize] as f64 * w;
                weight_sum += w;
            }

            let val = if weight_sum.abs() > 1e-10 {
                (sum / weight_sum * 32767.0).clamp(-32768.0, 32767.0) as i16
            } else { 0i16 };
            pcm16.extend_from_slice(&val.to_le_bytes());
        }

        if ws_tx.send(Message::Binary(pcm16.into())).await.is_err() {
            eprintln!("[system-audio] WebSocket send failed, stopping");
            break;
        }
    }

    let _ = ws_tx.close().await;
    reader.abort();
    println!("[system-audio] Streaming stopped");
}



#[tauri::command]
async fn stop_system_audio(app: tauri::AppHandle) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let state = app.state::<SystemAudioState>();
        system_audio::stop_capture(&state.0);
        Ok("System audio stopped".to_string())
    }
    #[cfg(target_os = "windows")]
    {
        let state = app.state::<SystemAudioState>();
        system_audio_windows::stop_capture(&state.0);
        Ok("System audio stopped".to_string())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = app;
        Ok("System audio not supported".to_string())
    }
}

// ─── Sidecar Management ─────────────────────────────────────────────────────

#[tauri::command]
async fn start_sidecar(app: tauri::AppHandle) -> Result<String, String> {
    let state = app.state::<Mutex<SidecarState>>();
    let mut state = state.lock().map_err(|e| e.to_string())?;

    // Always kill old sidecar to ensure fresh start with latest code
    if let Some(child) = state.child.take() {
        child.kill();
        println!("[sidecar] Killed previous sidecar process");
        std::thread::sleep(std::time::Duration::from_millis(300));
    }

    // Kill any stale sidecar processes (handles crash leftovers)
    #[cfg(unix)]
    {
        let _ = std::process::Command::new("pkill")
            .args(["-9", "scribble-sidecar"])
            .output();
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/IM", "scribble-sidecar.exe"])
            .creation_flags(0x08000000)
            .output();
    }

    // --- Attempt 1: Tauri sidecar API (skip on Windows — silently fails with NSIS installs) ---
    #[cfg(not(windows))]
    {
        match app.shell().sidecar("scribble-sidecar") {
            Ok(cmd) => {
                match cmd.spawn() {
                    Ok((mut rx, child)) => {
                        state.child = Some(SidecarChild::Tauri(child));
                        tauri::async_runtime::spawn(async move {
                            use tauri_plugin_shell::process::CommandEvent;
                            while let Some(event) = rx.recv().await {
                                match event {
                                    CommandEvent::Stdout(line) => println!("[sidecar] {}", String::from_utf8_lossy(&line)),
                                    CommandEvent::Stderr(line) => eprintln!("[sidecar] {}", String::from_utf8_lossy(&line)),
                                    CommandEvent::Terminated(p) => { println!("[sidecar] terminated: {:?}", p); break; }
                                    _ => {}
                                }
                            }
                        });
                        return Ok("Sidecar started (tauri API)".to_string());
                    }
                    Err(e) => {
                        eprintln!("[sidecar] Tauri spawn failed: {}, trying direct spawn...", e);
                    }
                }
            }
            Err(e) => {
                eprintln!("[sidecar] Tauri sidecar command failed: {}, trying direct spawn...", e);
            }
        }
    }

    // --- Attempt 2: Direct spawn (resolves binary next to main exe) ---
    let exe_dir = std::env::current_exe()
        .map_err(|e| format!("Cannot find current exe: {}", e))?
        .parent()
        .ok_or("Cannot find exe parent dir")?
        .to_path_buf();

    #[cfg(windows)]
    let sidecar_name = "scribble-sidecar.exe";
    #[cfg(not(windows))]
    let sidecar_name = "scribble-sidecar";

    let sidecar_path = exe_dir.join(sidecar_name);

    // Write diagnostic log to ~/.voicescribe/ (visible on all platforms)
    let log_dir = dirs::home_dir().unwrap_or_default().join(".voicescribe");
    let _ = std::fs::create_dir_all(&log_dir);
    let log_path = log_dir.join("sidecar-launch.log");
    let log_msg = format!(
        "[{:?}] exe_dir={:?}, sidecar_path={:?}, exists={}, tauri_api_failed=true\n",
        std::time::SystemTime::now(),
        exe_dir, sidecar_path, sidecar_path.exists()
    );
    let _ = std::fs::write(&log_path, &log_msg);

    if !sidecar_path.exists() {
        let err = format!(
            "Sidecar binary not found at {:?}. Checked: {:?}",
            sidecar_path, exe_dir
        );
        let _ = std::fs::write(&log_path, format!("{}{}\n", log_msg, err));
        return Err(err);
    }

    // Redirect sidecar output to log file for diagnostics
    let sidecar_log = std::fs::File::create(log_dir.join("sidecar-output.log"))
        .map_err(|e| format!("Cannot create sidecar log: {}", e))?;
    let sidecar_err = sidecar_log.try_clone()
        .map_err(|e| format!("Cannot clone log handle: {}", e))?;

    let mut cmd = std::process::Command::new(&sidecar_path);
    cmd.stdout(sidecar_log)
       .stderr(sidecar_err);

    // Windows: CREATE_NO_WINDOW flag prevents console flash and some security blocks
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    match cmd.spawn() {
        Ok(child) => {
            let pid = child.id();
            let success_msg = format!("{}Sidecar spawned OK, pid={}\n", log_msg, pid);
            let _ = std::fs::write(&log_path, &success_msg);
            state.child = Some(SidecarChild::Direct(child));
            Ok(format!("Sidecar started (direct spawn, pid={})", pid))
        }
        Err(e) => {
            let err_msg = format!("{}Direct spawn FAILED: {}\n", log_msg, e);
            let _ = std::fs::write(&log_path, &err_msg);
            Err(format!("Direct spawn failed: {} (path: {:?})", e, sidecar_path))
        }
    }
}

#[tauri::command]
async fn stop_sidecar(app: tauri::AppHandle) -> Result<String, String> {
    let state = app.state::<Mutex<SidecarState>>();
    let mut state = state.lock().map_err(|e| e.to_string())?;
    if let Some(child) = state.child.take() {
        child.kill();
        Ok("Sidecar stopped".to_string())
    } else {
        Ok("No sidecar running".to_string())
    }
}

#[tauri::command]
async fn save_audio_file(bytes: Vec<u8>, filename: String) -> Result<String, String> {
    use std::path::PathBuf;
    // Save to Downloads folder
    let downloads_dir = dirs::download_dir()
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")));
    let save_path = downloads_dir.join(&filename);
    std::fs::write(&save_path, &bytes)
        .map_err(|e| format!("Failed to save audio: {}", e))?;
    println!("[save_audio] Saved {} bytes to {:?}", bytes.len(), save_path);
    Ok(save_path.to_string_lossy().to_string())
}

#[tauri::command]
async fn download_and_save_file(url: String, filename: String) -> Result<String, String> {
    use std::path::PathBuf;
    let downloads_dir = dirs::download_dir()
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")));
    let save_path = downloads_dir.join(&filename);

    let response = reqwest::get(&url)
        .await
        .map_err(|e| format!("Download failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Download failed with status: {}", response.status()));
    }

    let bytes = response.bytes()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))?;

    std::fs::write(&save_path, &bytes)
        .map_err(|e| format!("Failed to save file: {}", e))?;

    println!("[download] Saved {} bytes to {:?}", bytes.len(), save_path);
    Ok(save_path.to_string_lossy().to_string())
}

#[tauri::command]
async fn check_sidecar() -> Result<bool, String> {
    match reqwest::get("http://127.0.0.1:8765/health").await {
        Ok(resp) => Ok(resp.status().is_success()),
        Err(_) => Ok(false),
    }
}

// ─── App Entry ──────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .manage(Mutex::new(SidecarState { child: None }))
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                app.manage(SystemAudioState(system_audio::CaptureState::new()));
            }
            #[cfg(target_os = "windows")]
            {
                app.manage(SystemAudioState(system_audio_windows::CaptureState::new()));
            }

            // Kill ALL stale sidecar processes SYNCHRONOUSLY before frontend loads
            // Uses process name (not port) to kill both PyInstaller bootloader + worker
            #[cfg(unix)]
            {
                let _ = std::process::Command::new("pkill")
                    .args(["-9", "scribble-sidecar"])
                    .output();
            }
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                let _ = std::process::Command::new("taskkill")
                    .args(["/F", "/IM", "scribble-sidecar.exe"])
                    .creation_flags(0x08000000)
                    .output();
            }
            // Brief pause for port release
            std::thread::sleep(std::time::Duration::from_millis(500));

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match start_sidecar(handle).await {
                    Ok(msg) => println!("[setup] {}", msg),
                    Err(e) => eprintln!("[setup] Failed to start sidecar: {}", e),
                }
            });

            // Linux: auto-grant microphone permission (WebKitGTK denies getUserMedia by default)
            #[cfg(target_os = "linux")]
            {
                let main_window = app.get_webview_window("main");
                if let Some(window) = main_window {
                    let _ = window.with_webview(|webview| {
                        use webkit2gtk::WebViewExt;
                        use webkit2gtk::PermissionRequestExt;
                        let wv = webview.inner();
                        wv.connect_permission_request(|_wv, request: &webkit2gtk::PermissionRequest| {
                            if request.is::<webkit2gtk::UserMediaPermissionRequest>() {
                                println!("[linux] Auto-granting microphone permission");
                                request.allow();
                                return true;
                            }
                            false
                        });
                    });
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_sidecar,
            stop_sidecar,
            check_sidecar,
            save_audio_file,
            download_and_save_file,
            request_screen_access,
            check_screen_access,
            start_system_audio,
            stop_system_audio,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let handle = window.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    let _ = stop_sidecar(handle).await;
                });
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            // Kill ALL sidecar processes on app exit (Cmd+Q, force quit, etc.)
            #[cfg(unix)]
            {
                let _ = std::process::Command::new("pkill")
                    .args(["-9", "scribble-sidecar"])
                    .output();
            }
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                let _ = std::process::Command::new("taskkill")
                    .args(["/F", "/IM", "scribble-sidecar.exe"])
                    .creation_flags(0x08000000)
                    .output();
            }
            println!("[exit] Sidecar cleaned up");
        }
    });
}
