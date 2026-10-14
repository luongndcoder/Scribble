//! Soniox real-time STT over WebSocket.
//!
//! Ported from `src-python/stt.py::SonioxStreamingSTT`. The Python version used
//! the official `soniox` SDK; here we speak the wire protocol directly with
//! `tokio-tungstenite`, which keeps the same semantics:
//!
//!   - audio is queued as raw PCM s16le frames (16kHz, mono)
//!   - ONE sender task owns the WS and drains the audio queue, emitting
//!     `<keepalive>` during silence so Soniox never idle-closes the session
//!     (>20s with no audio AND no keepalive kills it, which resets speaker
//!     diarization and collapses every speaker onto "Speaker 1")
//!   - results are read on a separate task and forwarded to the client
//!   - per-token streaming with immediate speaker-change handling
//!   - automatic session reconnect on a server-side close, with a cumulative
//!     time offset so the timeline stays continuous
//!
//! Config mirrors `RealtimeSTTConfig(model="stt-rt-v5", audio_format="pcm_s16le",
//! sample_rate=16000, num_channels=1, enable_endpoint_detection=True,
//! enable_speaker_diarization=True, language_hints=[...])` plus the optional
//! one-way translation.

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

pub const SONIOX_RT_URL: &str = "wss://stt-rt.soniox.com/transcribe-websocket";

/// Soniox stt-rt-v5 has a server-side session duration cap. When it fires, or
/// the connection idle-closes, the server closes the WS and our event loop
/// exits. We auto-reconnect up to this many times.
pub const MAX_RECONNECT_ATTEMPTS: u32 = 8;

/// Send a keepalive after this many seconds of no audio (well under Soniox's
/// 20s idle-close window).
pub const KEEPALIVE_IDLE: std::time::Duration = std::time::Duration::from_secs(5);

#[derive(Debug, Clone, Default)]
pub struct SonioxConfig {
    pub api_key: String,
    pub language_hints: Vec<String>,
    /// Non-empty enables one-way translation to this language.
    pub translate_lang: String,
    pub model: String,
    pub sample_rate: i32,
    pub num_channels: i32,
    pub enable_endpoint_detection: bool,
    pub enable_speaker_diarization: bool,
}

impl SonioxConfig {
    pub fn new(api_key: impl Into<String>) -> Self {
        Self {
            api_key: api_key.into(),
            language_hints: vec!["vi".to_string()],
            translate_lang: String::new(),
            model: "stt-rt-v5".to_string(),
            sample_rate: 16000,
            num_channels: 1,
            enable_endpoint_detection: true,
            enable_speaker_diarization: true,
        }
    }

    /// First message sent after `start`, exactly like the SDK's session config.
    pub fn start_message(&self) -> Value {
        let mut msg = json!({
            "api_key": self.api_key,
            "model": self.model,
            "audio_format": "pcm_s16le",
            "sample_rate": self.sample_rate,
            "num_channels": self.num_channels,
            "enable_endpoint_detection": self.enable_endpoint_detection,
            "enable_speaker_diarization": self.enable_speaker_diarization,
            "language_hints": self.language_hints,
        });
        if !self.translate_lang.is_empty() {
            msg["translation"] = json!({
                "type": "one_way",
                "target_language": self.translate_lang,
            });
        }
        msg
    }
}

/// WS payload shape produced by `_build_segment_result` in Python.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct SonioxSegment {
    pub text: String,
    pub is_final: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chunk_id: Option<String>,
    pub speaker: String,
    pub speaker_id: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub translation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<bool>,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub msg_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub info: Option<bool>,
    /// Trailing part of `text` built from NON-final tokens (may still change).
    /// The UI renders it dimmed so users can tell settled words from guesses.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tentative: Option<String>,
}

/// Per-session accumulation state (reset on every (re)connect).
struct SessionState {
    accumulated_final: Vec<String>,
    accumulated_translation: Vec<String>,
    current_speaker: i64,
    current_chunk_id: String,
    segment_start_ms: Option<i64>,
    segment_end_ms: Option<i64>,
    session_max_total_ms: i64,
    /// True when `<end>` was seen on a chunk already >= `ROTATE_CHUNK_CHARS`.
    /// Deferred until the next non-translation speech token so trailing
    /// translation frames that arrive right after `<end>` still attach to the
    /// completed chunk instead of being dropped.
    pending_rotate: bool,
    /// Last non-final speech tokens for `current_speaker`, preserved across
    /// translation-only frames so cabin translation updates never wipe out the
    /// live tentative tail on screen.
    last_non_final: Vec<String>,
    last_non_final_end_ms: Option<i64>,
    /// Tracks whether `accumulated_final` / `accumulated_translation` changed
    /// or had a tentative tail since the last clean final emission, so a later
    /// speaker-change flush doesn't re-emit an already-settled chunk with a
    /// newer wall-clock timestamp.
    dirty_since_clean_emit: bool,
}

impl SessionState {
    fn new() -> Self {
        Self {
            accumulated_final: Vec::new(),
            accumulated_translation: Vec::new(),
            current_speaker: -1,
            current_chunk_id: new_chunk_id(),
            segment_start_ms: None,
            segment_end_ms: None,
            session_max_total_ms: 0,
            pending_rotate: false,
            last_non_final: Vec::new(),
            last_non_final_end_ms: None,
            dirty_since_clean_emit: false,
        }
    }

    fn reset(&mut self) {
        self.accumulated_final.clear();
        self.accumulated_translation.clear();
        self.segment_start_ms = None;
        self.segment_end_ms = None;
        self.current_chunk_id = new_chunk_id();
        self.pending_rotate = false;
        self.last_non_final.clear();
        self.last_non_final_end_ms = None;
        self.dirty_since_clean_emit = false;
    }
}

fn new_chunk_id() -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let uuid = uuid::Uuid::new_v4();
    format!("soniox-{millis}-{}", &uuid.simple().to_string()[..6])
}

/// Pack a segment into the WS payload shape, applying the cumulative
/// cross-session time offset so timestamps remain continuous after a reconnect.
#[allow(clippy::too_many_arguments)]
fn build_segment(
    state: &SessionState,
    text: &str,
    _is_final: bool,
    cumulative_offset_ms: i64,
    start_ms: Option<i64>,
    end_ms: Option<i64>,
    translation: &str,
) -> SonioxSegment {
    build_segment_for_speaker(
        state,
        text,
        state.current_speaker,
        cumulative_offset_ms,
        start_ms,
        end_ms,
        translation,
    )
}

/// Build a segment for an EXPLICIT speaker id.
///
/// Needed because Python flushes the old speaker's text with the value of
/// `current_speaker` *before* it is reassigned to the new speaker; reading the
/// live field at that point would label the flushed text with the wrong speaker.
#[allow(clippy::too_many_arguments)]
fn build_segment_for_speaker(
    state: &SessionState,
    text: &str,
    speaker_id: i64,
    cumulative_offset_ms: i64,
    start_ms: Option<i64>,
    end_ms: Option<i64>,
    translation: &str,
) -> SonioxSegment {
    let speaker_label = if speaker_id >= 0 {
        format!("Speaker {}", speaker_id + 1)
    } else {
        "Speaker 1".to_string()
    };
    SonioxSegment {
        text: text.to_string(),
        // Python's `_build_segment_result` hardcodes `is_final: True`;
        // `_is_final` is part of the signature for API symmetry only.
        is_final: true,
        chunk_id: Some(state.current_chunk_id.clone()),
        speaker: speaker_label,
        speaker_id: speaker_id.max(0),
        start_ms: start_ms.map(|v| v + cumulative_offset_ms),
        end_ms: end_ms.map(|v| v + cumulative_offset_ms),
        translation: if translation.is_empty() {
            None
        } else {
            Some(translation.to_string())
        },
        error: None,
        msg_type: None,
        info: None,
        tentative: None,
    }
}

/// Split one Soniox event's tokens into (final_text_added, non_final_text,
/// translation_added, translation_non_final, display_end_ms).
struct TokenSplit {
    /// Soniox emitted an `<end>` token: the speaker paused (endpoint).
    endpoint: bool,
    /// True if any final speech or final translation token was added.
    final_added: bool,
    non_final: Vec<String>,
    non_final_translation: Vec<String>,
    first_non_final_start_ms: Option<i64>,
    latest_non_final_end_ms: Option<i64>,
    non_final_speaker: Option<i64>,
    /// Non-final tokens spoken by a DIFFERENT speaker while the previous
    /// speaker's final text is still in `state.accumulated_final`. Emitted as
    /// an interim (`is_final: false`) segment for the new speaker so their
    /// live words appear immediately in their own bubble instead of being
    /// glued onto the previous speaker's bubble for several seconds.
    next_speaker_non_final: Vec<String>,
    next_speaker_id: Option<i64>,
}

/// Soniox sends the speaker id as a JSON string (`"1"`); some payloads use a
/// number. Python's `int(...)` accepts both, so we do too.
pub(crate) fn parse_speaker_id(v: &Value) -> Option<i64> {
    if let Some(n) = v.as_i64() {
        return Some(n);
    }
    if let Some(s) = v.as_str() {
        return s.trim().parse::<i64>().ok();
    }
    None
}

/// Apply one Soniox event to `state`, returning the split of non-final tokens
/// and any segment that must be flushed BEFORE the event's display text (a
/// speaker change mid-event).
fn apply_event(
    state: &mut SessionState,
    event: &Value,
    cumulative_offset_ms: i64,
) -> (TokenSplit, Option<SonioxSegment>) {
    let mut split = TokenSplit {
        endpoint: false,
        final_added: false,
        non_final: Vec::new(),
        non_final_translation: Vec::new(),
        first_non_final_start_ms: None,
        latest_non_final_end_ms: None,
        non_final_speaker: None,
        next_speaker_non_final: Vec::new(),
        next_speaker_id: None,
    };
    let mut flushed: Option<SonioxSegment> = None;

    if let Some(tot) = event.get("total_audio_proc_ms").and_then(|v| v.as_i64()) {
        state.session_max_total_ms = state.session_max_total_ms.max(tot);
    }

    let Some(tokens) = event.get("tokens").and_then(|t| t.as_array()) else {
        return (split, flushed);
    };

    let mut saw_non_translation_token = false;

    for token in tokens {
        let token_text = token.get("text").and_then(|t| t.as_str()).unwrap_or("");
        if token_text == "<end>" {
            split.endpoint = true;
            saw_non_translation_token = true;
            continue;
        }
        if token_text.is_empty() {
            continue;
        }
        // CRITICAL: on the wire Soniox sends `"speaker": "1"` — a JSON STRING.
        // Python does `int(getattr(token, "speaker", 0) or 0)`, which parses it.
        // Reading it with `as_i64()` returns None for a string, so every token
        // silently defaulted to speaker 0; the moment a real "2" arrived the
        // comparison `speaker_id != current_speaker` (0 != 0) stayed false, and
        // the upstream segment was never flushed. Accept both encodings.
        let parsed_speaker = token.get("speaker").and_then(parse_speaker_id);
        let speaker_id = parsed_speaker.unwrap_or(0);
        let is_final = token.get("is_final").and_then(|v| v.as_bool()).unwrap_or(false);
        let translation_status = token
            .get("translation_status")
            .and_then(|v| v.as_str())
            .unwrap_or("none");

        if translation_status == "translation" {
            if is_final {
                state.accumulated_translation.push(token_text.to_string());
                split.final_added = true;
                state.dirty_since_clean_emit = true;
            } else {
                split.non_final_translation.push(token_text.to_string());
            }
            continue;
        }

        saw_non_translation_token = true;
        if state.pending_rotate {
            state.reset();
        }

        let tok_start = token.get("start_ms").and_then(|v| v.as_i64());
        let tok_end = token.get("end_ms").and_then(|v| v.as_i64());

        if is_final {
            if state.current_speaker == -1 {
                // First-ever final token: just adopt its speaker.
                state.current_speaker = speaker_id;
            } else if speaker_id != state.current_speaker && !state.accumulated_final.is_empty() {
                // Speaker change INSIDE the event: flush whatever's been
                // accumulated under the OLD speaker before we touch the new
                // token. Without this, tokens from S1 and S2 within the same
                // event collapse onto whichever speaker happened to be last.
                let full_text = state.accumulated_final.concat();
                let full_text = full_text.trim();
                if !full_text.is_empty() {
                    let translation = state.accumulated_translation.concat();
                    // Label with the OLD speaker (Python yields with
                    // `current_speaker` before reassigning it below).
                    flushed = Some(build_segment_for_speaker(
                        state,
                        full_text,
                        state.current_speaker,
                        cumulative_offset_ms,
                        state.segment_start_ms,
                        state.segment_end_ms,
                        translation.trim(),
                    ));
                }
                let new_speaker = speaker_id;
                state.reset();
                state.current_speaker = new_speaker;
            }
            // Update current_speaker even when no flush happened.
            state.current_speaker = speaker_id;

            // Track segment time range from actual token offsets.
            if tok_start.is_some() && state.segment_start_ms.is_none() {
                state.segment_start_ms = tok_start;
            }
            if tok_end.is_some() {
                state.segment_end_ms = tok_end;
            }

            state.accumulated_final.push(token_text.to_string());
            split.final_added = true;
            state.dirty_since_clean_emit = true;
        } else if state.current_speaker >= 0
            && !state.accumulated_final.is_empty()
            && parsed_speaker.is_some_and(|spk| spk != state.current_speaker)
        {
            // Non-final token from a DIFFERENT speaker while the previous
            // speaker's finalized text is still held in `state`: keep it
            // separate so we can emit an interim bubble for the new speaker
            // immediately instead of appending it to the old speaker's text.
            split.next_speaker_id = parsed_speaker;
            split.next_speaker_non_final.push(token_text.to_string());
        } else {
            if split.non_final_speaker.is_none() {
                split.non_final_speaker = parsed_speaker;
            }
            if tok_start.is_some() && split.first_non_final_start_ms.is_none() {
                split.first_non_final_start_ms = tok_start;
            }
            split.non_final.push(token_text.to_string());
            if tok_end.is_some() {
                split.latest_non_final_end_ms = tok_end;
            }
        }
    }

    if saw_non_translation_token {
        state.last_non_final = split.non_final.clone();
        state.last_non_final_end_ms = split.latest_non_final_end_ms;
    } else if split.non_final.is_empty() && !state.last_non_final.is_empty() {
        // Translation-only frame: preserve the in-flight non-final speech tail
        // so updating the translation doesn't erase tentative words on screen.
        split.non_final = state.last_non_final.clone();
        split.latest_non_final_end_ms = state.last_non_final_end_ms;
    }

    (split, flushed)
}

/// Build the live display segment after applying an event (Python builds
/// `accumulated_final + non_final`).
fn display_segment(
    state: &SessionState,
    split: &TokenSplit,
    cumulative_offset_ms: i64,
) -> Option<SonioxSegment> {
    let mut display: String = state.accumulated_final.concat();
    for t in &split.non_final {
        display.push_str(t);
    }
    let display = display.trim().to_string();
    if display.is_empty() {
        return None;
    }

    let mut translation: String = state.accumulated_translation.concat();
    for t in &split.non_final_translation {
        translation.push_str(t);
    }
    let translation = translation.trim().to_string();

    let display_start_ms = state.segment_start_ms.or(split.first_non_final_start_ms);
    // Resolve display end_ms: prefer the live non-final token's offset so the
    // time range grows in real time while the user is still speaking.
    let display_end_ms = split
        .latest_non_final_end_ms
        .or(state.segment_end_ms);

    let effective_speaker = if state.current_speaker >= 0 {
        state.current_speaker
    } else {
        split.non_final_speaker.unwrap_or(-1)
    };

    let mut seg = build_segment_for_speaker(
        state,
        &display,
        effective_speaker,
        cumulative_offset_ms,
        display_start_ms,
        display_end_ms,
        &translation,
    );
    let tentative = split.non_final.concat().trim().to_string();
    if !tentative.is_empty() && display.ends_with(&tentative) {
        seg.tentative = Some(tentative);
    }
    Some(seg)
}

/// Build an interim (`is_final: false`) segment when a new speaker starts
/// speaking non-final tokens while the previous speaker's segment is still
/// sitting in `state.accumulated_final`.
fn next_speaker_interim_segment(split: &TokenSplit) -> Option<SonioxSegment> {
    let spk = split.next_speaker_id?;
    let text = split.next_speaker_non_final.concat().trim().to_string();
    if text.is_empty() {
        return None;
    }
    let speaker_label = if spk >= 0 {
        format!("Speaker {}", spk + 1)
    } else {
        "Speaker 1".to_string()
    };
    Some(SonioxSegment {
        text,
        is_final: false,
        chunk_id: None,
        speaker: speaker_label,
        speaker_id: spk.max(0),
        start_ms: None,
        end_ms: None,
        translation: None,
        error: None,
        msg_type: None,
        info: None,
        tentative: None,
    })
}

/// Rotate to a new chunk at an endpoint once the current one is this long.
///
/// Soniox only started a new chunk on a speaker change, so one person talking
/// for minutes became a single ever-growing block (and one ever-growing
/// translation). Cutting at a natural pause keeps blocks readable while short
/// back-and-forth stays in one block.
const ROTATE_CHUNK_CHARS: usize = 80;

/// Encode a single 16-bit signed linear PCM sample to 8-bit ITU-T G.711 µ-law.
#[inline]
fn linear16_to_mulaw(mut sample: i32) -> u8 {
    const BIAS: i32 = 0x84;
    const CLIP: i32 = 32635;
    let sign = if sample < 0 {
        sample = -sample;
        0x80u8
    } else {
        0x00u8
    };
    if sample > CLIP {
        sample = CLIP;
    }
    sample += BIAS;
    let shifted = ((sample >> 7) as u32) | 1;
    let exponent = (31i32 - shifted.leading_zeros() as i32).clamp(0, 7) as u8;
    let mantissa = ((sample >> (exponent + 3)) & 0x0F) as u8;
    !(sign | (exponent << 4) | mantissa)
}

/// Downsample 16 kHz s16le mono PCM to 8 kHz G.711 µ-law (4x reduction:
/// 32 KB/s -> 8 KB/s, keeping every 100ms frame at 800 bytes < 1 TCP MSS so
/// international Cloudflare routes never stall on multi-segment TCP frames).
fn pcm16k_to_mulaw8k(pcm_bytes: &[u8]) -> Vec<u8> {
    let n_samples = pcm_bytes.len() / 2;
    let mut out = Vec::with_capacity((n_samples + 1) / 2);
    let mut i = 0;
    while i < n_samples {
        let s0 = i16::from_le_bytes([pcm_bytes[i * 2], pcm_bytes[i * 2 + 1]]) as i32;
        let avg = if i + 1 < n_samples {
            let s1 = i16::from_le_bytes([pcm_bytes[(i + 1) * 2], pcm_bytes[(i + 1) * 2 + 1]]) as i32;
            (s0 + s1) / 2
        } else {
            s0
        };
        out.push(linear16_to_mulaw(avg));
        i += 2;
    }
    out
}

/// Errors surfaced to the client as a terminal `error: true` result.
fn error_segment(message: String) -> SonioxSegment {
    SonioxSegment {
        text: message,
        is_final: true,
        chunk_id: None,
        speaker: "System".to_string(),
        speaker_id: -1,
        start_ms: None,
        end_ms: None,
        translation: None,
        error: Some(true),
        msg_type: None,
        info: None,
        tentative: None,
    }
}

/// Connect to Soniox's real-time WebSocket using an IPv4-preferred
/// Happy-Eyeballs race and `TCP_NODELAY`.
///
/// Why not plain `connect_async(SONIOX_RT_URL)`?
/// 1. `stt-rt.soniox.com` is fronted by Cloudflare anycast (2 IPv6 + 2 IPv4).
///    On macOS `getaddrinfo` returns IPv6 first; when the ISP's IPv6 route to
///    Cloudflare drops SYN packets or suffers high retransmission loss, plain
///    `connect_async` blocks for 2–3.5s on IPv6 and then streams audio over a
///    congested path that stalls TCP sends for 4–15s mid-recording.
/// 2. Plain `connect_async` leaves Nagle's algorithm enabled (`disable_nagle =
///    false`), adding delayed-ACK latency to small 100ms PCM frames.
async fn connect_soniox_ws() -> Result<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    tokio_tungstenite::tungstenite::Error,
> {
    use std::net::SocketAddr;
    use tokio::net::{lookup_host, TcpStream};
    use tokio::task::JoinSet;
    use tokio_tungstenite::{client_async_tls_with_config, connect_async_with_config};

    let mut addrs: Vec<SocketAddr> = match lookup_host("stt-rt.soniox.com:443").await {
        Ok(iter) => iter.collect(),
        Err(_) => {
            let (ws, _) = connect_async_with_config(SONIOX_RT_URL, None, true).await?;
            return Ok(ws);
        }
    };
    if addrs.is_empty() {
        let (ws, _) = connect_async_with_config(SONIOX_RT_URL, None, true).await?;
        return Ok(ws);
    }

    // Prefer IPv4 before IPv6.
    addrs.sort_by_key(|a| a.is_ipv6());

    // Happy-Eyeballs staggered TCP race (120ms stagger): whichever Cloudflare
    // edge IP completes TCP handshake first wins immediately.
    let mut set = JoinSet::new();
    let mut winning_tcp: Option<TcpStream> = None;
    for (idx, addr) in addrs.into_iter().enumerate() {
        set.spawn(async move {
            if idx > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(120 * idx as u64)).await;
            }
            tokio::time::timeout(
                std::time::Duration::from_millis(2500),
                TcpStream::connect(addr),
            )
            .await
            .ok()
            .and_then(|r| r.ok())
        });
    }

    while let Some(res) = set.join_next().await {
        if let Ok(Some(stream)) = res {
            winning_tcp = Some(stream);
            set.abort_all();
            break;
        }
    }

    if let Some(tcp) = winning_tcp {
        let _ = tcp.set_nodelay(true);
        if let Ok(Ok((ws, _))) = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            client_async_tls_with_config(SONIOX_RT_URL, tcp, None, None),
        )
        .await
        {
            return Ok(ws);
        }
    }

    let (ws, _) = connect_async_with_config(SONIOX_RT_URL, None, true).await?;
    Ok(ws)
}

/// Run a full Soniox realtime session for one client connection.
///
/// `audio_rx` yields raw PCM s16le chunks (or `None` when the client stops).
/// `out_tx` receives the segment payloads to forward to the client.
pub async fn run_soniox_session(
    config: SonioxConfig,
    audio_rx_in: mpsc::Receiver<Option<Vec<u8>>>,
    out_tx: mpsc::Sender<SonioxSegment>,
) {
    let mut cumulative_offset_ms: i64 = 0;
    let mut reconnect_attempts: u32 = 0;
    let mut stopped = false;
    // The client ended the stream (vs Soniox closing on us): never reconnect.
    let client_stopped = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    // The audio queue is created once and REUSED across reconnects so frames
    // already buffered from the frontend during a server-side close get drained
    // into the new WS instead of being dropped (Python: `_open_session` re-reads
    // the same `_audio_queue` with a fresh sender thread).
    let mut audio_rx: Option<mpsc::Receiver<Option<Vec<u8>>>> = Some(audio_rx_in);

    loop {
        let mut state = SessionState::new();
        // Each session consumes the shared queue and hands it back when done.
        let session_rx = match audio_rx.take() {
            Some(rx) => rx,
            None => return,
        };

        let ws = match connect_soniox_ws().await {
            Ok(v) => v,
            Err(e) => {
                audio_rx = Some(session_rx);
                if stopped {
                    return;
                }
                reconnect_attempts += 1;
                if reconnect_attempts > MAX_RECONNECT_ATTEMPTS {
                    let _ = out_tx
                        .send(error_segment(format!("Soniox connect failed: {e}")))
                        .await;
                    return;
                }
                tokio::time::sleep(backoff(reconnect_attempts)).await;
                continue;
            }
        };

        let (mut ws_sink, mut ws_stream) = ws.split();

        // Handshake: transcode 16kHz PCM to 8kHz G.711 mulaw on the wire
        // (4x smaller bandwidth: 8 KB/s, 800B/100ms frame < 1 TCP MSS).
        let use_mulaw_8k = config.sample_rate == 16000 && config.num_channels == 1;
        let mut wire_start = config.start_message();
        if use_mulaw_8k {
            wire_start["audio_format"] = json!("mulaw");
            wire_start["sample_rate"] = json!(8000);
        }
        if ws_sink
            .send(Message::Text(wire_start.to_string().into()))
            .await
            .is_err()
        {
            audio_rx = Some(session_rx);
            reconnect_attempts += 1;
            if reconnect_attempts > MAX_RECONNECT_ATTEMPTS {
                let _ = out_tx
                    .send(error_segment("Soniox handshake failed".into()))
                    .await;
                return;
            }
            continue;
        }

        // Audio sender: single task owns the sink so audio chunks and keepalive
        // control messages never race on the underlying WebSocket. It returns
        // the shared queue so the next session can keep draining it.
        let (ctl_tx, mut ctl_rx) = mpsc::channel::<Message>(64);
        let client_stopped_tx = std::sync::Arc::clone(&client_stopped);
        let sender = tokio::spawn(async move {
            let mut rx = session_rx;
            // Set once the client signalled end-of-audio: stop reading audio
            // and keepalives, just wait for the event loop to wind down.
            let mut finishing = false;
            loop {
                tokio::select! {
                    msg = ctl_rx.recv() => {
                        match msg {
                            Some(m) => {
                                if ws_sink.send(m).await.is_err() { return rx; }
                            }
                            None => return rx,
                        }
                    }
                    chunk = rx.recv(), if !finishing => {
                        match chunk {
                            Some(Some(bytes)) => {
                                let wire_bytes = if use_mulaw_8k {
                                    pcm16k_to_mulaw8k(&bytes)
                                } else {
                                    bytes
                                };
                                if ws_sink.send(Message::Binary(wire_bytes.into())).await.is_err() { return rx; }
                            }
                            Some(None) | None => {
                                // Graceful end-of-audio: an empty frame asks
                                // Soniox to finalize the pending tokens, then
                                // it sends `finished` and closes. Closing the
                                // socket here (as before) lost the last words.
                                client_stopped_tx.store(true, std::sync::atomic::Ordering::SeqCst);
                                finishing = true;
                                if ws_sink.send(Message::Text(String::new().into())).await.is_err() {
                                    return rx;
                                }
                            }
                        }
                    }
                    _ = tokio::time::sleep(KEEPALIVE_IDLE), if !finishing => {
                        // Silence / paused recording — keep the session alive so
                        // Soniox does not idle-close it (which would reset
                        // diarization). Python: session.keep_alive().
                        let ka = json!({"type": "keepalive"}).to_string();
                        if ws_sink.send(Message::Text(ka.into())).await.is_err() { return rx; }
                    }
                }
            }
        });

        // Event loop.
        let mut terminal_error: Option<String> = None;
        loop {
            let next_msg = if client_stopped.load(std::sync::atomic::Ordering::SeqCst) {
                match tokio::time::timeout(
                    std::time::Duration::from_millis(2500),
                    ws_stream.next(),
                )
                .await
                {
                    Ok(m) => m,
                    Err(_) => break,
                }
            } else {
                ws_stream.next().await
            };
            let Some(msg) = next_msg else {
                break;
            };
            let msg = match msg {
                Ok(m) => m,
                Err(_) => break,
            };
            let text = match msg {
                Message::Text(t) => t.to_string(),
                Message::Binary(b) => String::from_utf8_lossy(&b).into_owned(),
                Message::Close(_) => break,
                _ => continue,
            };
            let event: Value = match serde_json::from_str(&text) {
                Ok(v) => v,
                Err(_) => continue,
            };

            // Server errors (e.g. 402 balance exhausted, auth failure) are
            // TERMINAL — don't reconnect.
            if let Some(code) = event.get("error_code").and_then(|v| v.as_i64()) {
                let message = event
                    .get("error_message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                terminal_error = Some(format!("Soniox error {code}: {message}"));
                break;
            }

            let had_unsettled = state.dirty_since_clean_emit;
            let (split, flushed) = apply_event(&mut state, &event, cumulative_offset_ms);
            if let Some(seg) = flushed {
                if had_unsettled && out_tx.send(seg).await.is_err() {
                    stopped = true;
                    break;
                }
            }
            let emit_current = split.final_added
                || !split.non_final.is_empty()
                || !split.non_final_translation.is_empty()
                || (split.next_speaker_non_final.is_empty() && !split.endpoint);
            if emit_current {
                if let Some(seg) = display_segment(&state, &split, cumulative_offset_ms) {
                    let is_clean_final =
                        seg.tentative.is_none() && split.non_final_translation.is_empty();
                    if out_tx.send(seg).await.is_err() {
                        stopped = true;
                        break;
                    }
                    state.dirty_since_clean_emit = !is_clean_final;
                }
            }
            if let Some(interim_seg) = next_speaker_interim_segment(&split) {
                if out_tx.send(interim_seg).await.is_err() {
                    stopped = true;
                    break;
                }
            }
            if split.endpoint
                && state.accumulated_final.concat().trim().chars().count() >= ROTATE_CHUNK_CHARS
            {
                // Defer rotation until the next non-translation speech token so
                // trailing translation tokens after `<end>` still attach to
                // this chunk.
                state.pending_rotate = true;
            }
            if event.get("finished").and_then(|v| v.as_bool()) == Some(true) {
                break;
            }
        }

        // Flush whatever was still accumulating under this session BEFORE we
        // decide to reconnect (so partial text isn't lost).
        if state.dirty_since_clean_emit && !state.accumulated_final.is_empty() {
            let full_text = state.accumulated_final.concat();
            let full_text = full_text.trim();
            if !full_text.is_empty() {
                let translation = state.accumulated_translation.concat();
                let seg = build_segment(
                    &state,
                    full_text,
                    true,
                    cumulative_offset_ms,
                    state.segment_start_ms,
                    state.segment_end_ms,
                    translation.trim(),
                );
                let _ = out_tx.send(seg).await;
                state.dirty_since_clean_emit = false;
            }
        }

        let session_max_total_ms = state.session_max_total_ms;
        // Close the sink, let the sender task hand the shared queue back, then
        // reuse it for the next session so buffered audio survives a reconnect.
        let _ = ctl_tx.send(Message::Close(None)).await;
        drop(ctl_tx);
        let reclaimed = sender.await.ok();
        if let Some(rx) = reclaimed {
            audio_rx = Some(rx);
        }

        if let Some(err) = terminal_error {
            let _ = out_tx.send(error_segment(err)).await;
            return;
        }
        if stopped || client_stopped.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        if audio_rx.is_none() {
            // Sender died with the queue — nothing left to reconnect onto.
            return;
        }

        // Soniox closed the WS unexpectedly (likely session-duration cap,
        // occasionally a network blip). Auto-reconnect with the cumulative time
        // offset so the timeline stays continuous.
        reconnect_attempts += 1;
        if reconnect_attempts > MAX_RECONNECT_ATTEMPTS {
            let _ = out_tx
                .send(error_segment(format!(
                    "Soniox reconnect failed sau {MAX_RECONNECT_ATTEMPTS} lần. Vui lòng dừng và bắt đầu ghi âm lại."
                )))
                .await;
            return;
        }
        cumulative_offset_ms += session_max_total_ms;

        // Heartbeat to the frontend so the UI can show "reconnecting" instead
        // of looking frozen.
        let _ = out_tx
            .send(SonioxSegment {
                text: "Soniox session reconnecting...".to_string(),
                is_final: false,
                chunk_id: None,
                speaker: "System".to_string(),
                speaker_id: -1,
                start_ms: None,
                end_ms: None,
                translation: None,
                error: None,
                msg_type: Some("info".to_string()),
                info: Some(true),
                tentative: None,
            })
            .await;

        // Exponential backoff capped at 5s — usually reconnects on the first
        // try because the server-side close is intentional.
        tokio::time::sleep(backoff(reconnect_attempts)).await;
    }
}

/// Python: `min(0.5 * (2 ** (attempt - 1)), 5.0)` seconds.
fn backoff(attempt: u32) -> std::time::Duration {
    let secs = 0.5f64 * 2f64.powi(attempt.saturating_sub(1) as i32);
    std::time::Duration::from_secs_f64(secs.min(5.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn start_message_matches_python_config() {
        let cfg = SonioxConfig::new("k");
        let m = cfg.start_message();
        assert_eq!(m["model"], "stt-rt-v5");
        assert_eq!(m["audio_format"], "pcm_s16le");
        assert_eq!(m["sample_rate"], 16000);
        assert_eq!(m["num_channels"], 1);
        assert_eq!(m["enable_endpoint_detection"], true);
        assert_eq!(m["enable_speaker_diarization"], true);
        assert_eq!(m["language_hints"][0], "vi");
        assert!(m.get("translation").is_none());
    }

    #[test]
    fn start_message_includes_one_way_translation() {
        let mut cfg = SonioxConfig::new("k");
        cfg.translate_lang = "en".to_string();
        let m = cfg.start_message();
        assert_eq!(m["translation"]["type"], "one_way");
        assert_eq!(m["translation"]["target_language"], "en");
    }

    #[test]
    fn backoff_is_capped_at_five_seconds() {
        assert!((backoff(1).as_secs_f64() - 0.5).abs() < 1e-6);
        assert!((backoff(2).as_secs_f64() - 1.0).abs() < 1e-6);
        assert!((backoff(5).as_secs_f64() - 5.0).abs() < 1e-6);
        assert!((backoff(8).as_secs_f64() - 5.0).abs() < 1e-6);
    }

    #[test]
    fn speaker_change_mid_event_flushes_under_old_speaker() {
        let mut state = SessionState::new();
        // S0 final tokens.
        let ev1 = json!({"tokens": [
            {"text": "xin ", "is_final": true, "speaker": 0, "start_ms": 0, "end_ms": 100},
            {"text": "chào", "is_final": true, "speaker": 0, "start_ms": 100, "end_ms": 200}
        ]});
        let (split, flushed) = apply_event(&mut state, &ev1, 0);
        assert!(flushed.is_none());
        assert!(split.non_final.is_empty());
        assert_eq!(state.accumulated_final.concat(), "xin chào");

        // Same event continues with S1 — must flush the S0 text first.
        let ev2 = json!({"tokens": [
            {"text": " tôi ", "is_final": true, "speaker": 1, "start_ms": 200, "end_ms": 300}
        ]});
        let (_split, flushed) = apply_event(&mut state, &ev2, 0);
        let seg = flushed.expect("speaker change must flush");
        assert_eq!(seg.text, "xin chào");
        // Wire speaker 0 -> label "Speaker 1" (see live-capture test for the
        // 1-based wire numbering Soniox actually uses).
        assert_eq!(seg.speaker, "Speaker 1");
        assert_eq!(seg.speaker_id, 0);
        assert_eq!(seg.start_ms, Some(0));
        assert_eq!(seg.end_ms, Some(200));
        // New speaker adopted.
        assert_eq!(state.current_speaker, 1);
    }

    #[test]
    fn cumulative_offset_shifts_timestamps() {
        let mut state = SessionState::new();
        state.current_speaker = 0;
        state.segment_start_ms = Some(1000);
        state.segment_end_ms = Some(2000);
        state.accumulated_final.push("a".into());
        let seg = build_segment(&state, "a", true, 60_000, Some(1000), Some(2000), "");
        assert_eq!(seg.start_ms, Some(61_000));
        assert_eq!(seg.end_ms, Some(62_000));
    }

    #[test]
    fn translation_tokens_are_separated_from_stt_tokens() {
        let mut state = SessionState::new();
        let ev = json!({"tokens": [
            {"text": "xin chào", "is_final": true, "speaker": 0,
             "start_ms": 0, "end_ms": 10, "translation_status": "none"},
            {"text": "hello", "is_final": true, "speaker": 0,
             "translation_status": "translation"}
        ]});
        let (split, _) = apply_event(&mut state, &ev, 0);
        assert!(split.non_final.is_empty());
        assert_eq!(state.accumulated_final.concat(), "xin chào");
        assert_eq!(state.accumulated_translation.concat(), "hello");
    }

    /// Regression 2026-10-09: the real wire format sends `"speaker": "1"` as a
    /// JSON string. Reading it as an integer silently produced speaker 0 for
    /// every token, so a genuine speaker change was never detected and the
    /// previous utterance was never flushed.
    #[test]
    fn string_speaker_ids_are_parsed() {
        assert_eq!(parse_speaker_id(&json!("1")), Some(1));
        assert_eq!(parse_speaker_id(&json!("2")), Some(2));
        assert_eq!(parse_speaker_id(&json!(3)), Some(3));
        assert_eq!(parse_speaker_id(&json!(null)), None);
        assert_eq!(parse_speaker_id(&json!("abc")), None);
    }

    /// The exact event shape captured from the live Soniox API: non-final token
    /// for speaker "1", then a final batch for "1" containing `<end>`, then the
    /// first non-final token of speaker "2". The speaker change must flush the
    /// speaker-1 utterance exactly once, and `<end>` must not reset anything.
    #[test]
    fn live_captured_events_flush_on_real_speaker_change() {
        let mut state = SessionState::new();
        let mut emitted: Vec<String> = Vec::new();

        let ev_nonfinal = json!({"total_audio_proc_ms": 960, "tokens": [
            {"text": "Công", "start_ms": 300, "end_ms": 360, "is_final": false, "speaker": "1"}
        ]});
        let (_s, f) = apply_event(&mut state, &ev_nonfinal, 0);
        assert!(f.is_none());
        assert_eq!(state.current_speaker, -1, "non-final tokens must not set the speaker");

        let ev_final = json!({"final_audio_proc_ms": 2040, "total_audio_proc_ms": 2040, "tokens": [
            {"text": "Công", "is_final": true, "speaker": "1", "start_ms": 300, "end_ms": 360},
            {"text": " ty",  "is_final": true, "speaker": "1", "start_ms": 480, "end_ms": 540},
            {"text": "<end>", "is_final": true}
        ]});
        let (split, f) = apply_event(&mut state, &ev_final, 0);
        assert!(f.is_none(), "<end>/first final must not flush");
        assert_eq!(state.current_speaker, 1, "string speaker id must parse to 1");
        assert_eq!(state.accumulated_final.concat(), "Công ty");
        // `<end>` carries no speaker; it must be skipped, not treated as speaker 0.
        assert_eq!(split.non_final.len(), 0);

        // Speaker 2 arrives as a FINAL token -> must flush the speaker-1 segment.
        let ev_s2 = json!({"final_audio_proc_ms": 2520, "total_audio_proc_ms": 2520, "tokens": [
            {"text": " V", "is_final": true, "speaker": "2", "start_ms": 1860, "end_ms": 1920}
        ]});
        let (_split, f) = apply_event(&mut state, &ev_s2, 0);
        let seg = f.expect("real speaker change must flush");
        emitted.push(seg.text.clone());
        assert_eq!(seg.text, "Công ty");
        // Python's numbering: wire speaker "1" -> current_speaker 1 ->
        // label "Speaker 2", field speaker_id 1 (`f"Speaker {speaker_id + 1}"`).
        // Verified against the live Python client, whose histogram over the same
        // recording is {'Speaker 1': 8, 'Speaker 2': 193, 'Speaker 3': 59}.
        assert_eq!(seg.speaker, "Speaker 2");
        assert_eq!(seg.speaker_id, 1);
        assert_eq!(seg.start_ms, Some(300));
        assert_eq!(seg.end_ms, Some(540));
        assert_eq!(state.current_speaker, 2);
        assert_eq!(emitted, vec!["Công ty".to_string()]);
    }

    #[test]
    fn end_tokens_are_skipped() {
        let mut state = SessionState::new();
        let ev = json!({"tokens": [
            {"text": "<end>", "is_final": true, "speaker": 0},
            {"text": "", "is_final": true, "speaker": 0}
        ]});
        let (split, _) = apply_event(&mut state, &ev, 0);
        assert!(state.accumulated_final.is_empty());
        assert!(split.non_final.is_empty());
        // `<end>` is not text, but it IS the endpoint signal used to rotate.
        assert!(split.endpoint);
    }

    #[test]
    fn display_segment_marks_non_final_tail_as_tentative() {
        let mut state = SessionState::new();
        let ev = json!({"tokens": [
            {"text": "xin chào", "is_final": true, "speaker": "1"},
            {"text": " các bạn", "is_final": false, "speaker": "1"}
        ]});
        let (split, _) = apply_event(&mut state, &ev, 0);
        let seg = display_segment(&state, &split, 0).expect("segment");
        assert_eq!(seg.text, "xin chào các bạn");
        assert_eq!(seg.tentative.as_deref(), Some("các bạn"));
        assert!(seg.text.ends_with(seg.tentative.as_deref().unwrap()));

        // All tokens final → nothing tentative.
        let mut state = SessionState::new();
        let ev = json!({"tokens": [{"text": "xong", "is_final": true, "speaker": "1"}]});
        let (split, _) = apply_event(&mut state, &ev, 0);
        assert!(display_segment(&state, &split, 0).unwrap().tentative.is_none());
    }

    #[test]
    fn new_speaker_non_final_emits_interim_without_polluting_previous_speaker() {
        let mut state = SessionState::new();
        let ev1 = json!({"tokens": [
            {"text": "Pretty good.", "is_final": true, "speaker": "1", "start_ms": 100, "end_ms": 500},
            {"text": "<end>", "is_final": true}
        ]});
        let (split1, _) = apply_event(&mut state, &ev1, 0);
        let seg1 = display_segment(&state, &split1, 0).unwrap();
        assert_eq!(seg1.text, "Pretty good.");
        assert_eq!(seg1.speaker, "Speaker 2");
        assert_eq!(seg1.speaker_id, 1);

        // Speaker 2 starts speaking non-final tokens — must NOT be glued onto
        // Speaker 1's "Pretty good." segment, and must emit an interim segment
        // for Speaker 2 ("Speaker 3").
        let ev2 = json!({"tokens": [
            {"text": " Quen", "is_final": false, "speaker": "2", "start_ms": 600, "end_ms": 700},
            {"text": " không?", "is_final": false, "speaker": "2", "start_ms": 700, "end_ms": 800}
        ]});
        let (split2, flushed2) = apply_event(&mut state, &ev2, 0);
        assert!(flushed2.is_none());
        assert!(split2.non_final.is_empty());
        let interim = next_speaker_interim_segment(&split2).expect("interim segment for new speaker");
        assert!(!interim.is_final);
        assert_eq!(interim.text, "Quen không?");
        assert_eq!(interim.speaker, "Speaker 3");
        assert_eq!(interim.speaker_id, 2);
    }

    #[test]
    fn translation_only_frame_preserves_live_tentative_tail() {
        let mut state = SessionState::new();
        let ev1 = json!({"tokens": [
            {"text": "Hello", "is_final": true, "speaker": "1", "start_ms": 100, "end_ms": 200},
            {"text": " world", "is_final": false, "speaker": "1", "start_ms": 200, "end_ms": 300}
        ]});
        let (split1, _) = apply_event(&mut state, &ev1, 0);
        let seg1 = display_segment(&state, &split1, 0).unwrap();
        assert_eq!(seg1.text, "Hello world");
        assert_eq!(seg1.tentative.as_deref(), Some("world"));

        // Translation-only frame arrives while " world" is still non-final.
        let ev_trans = json!({"tokens": [
            {"text": "Xin chào", "is_final": true, "speaker": "1", "translation_status": "translation"}
        ]});
        let (split2, _) = apply_event(&mut state, &ev_trans, 0);
        let seg2 = display_segment(&state, &split2, 0).unwrap();
        assert_eq!(seg2.text, "Hello world");
        assert_eq!(seg2.tentative.as_deref(), Some("world"));
        assert_eq!(seg2.translation.as_deref(), Some("Xin chào"));
    }

    #[test]
    fn first_non_final_uses_its_speaker_and_start_ms_in_display_segment() {
        let mut state = SessionState::new();
        let ev = json!({"tokens": [
            {"text": "Xin", "is_final": false, "speaker": "1", "start_ms": 300, "end_ms": 360}
        ]});
        let (split, _) = apply_event(&mut state, &ev, 0);
        assert_eq!(state.current_speaker, -1);
        let seg = display_segment(&state, &split, 0).unwrap();
        assert_eq!(seg.speaker, "Speaker 2");
        assert_eq!(seg.speaker_id, 1);
        assert_eq!(seg.start_ms, Some(300));
        assert_eq!(seg.end_ms, Some(360));
    }

    #[test]
    fn pcm16k_to_mulaw8k_reduces_size_4x_and_matches_g711() {
        // 3200 bytes (100ms @ 16kHz s16le) -> 800 bytes (100ms @ 8kHz mulaw)
        let pcm = vec![0u8; 3200];
        let ulaw = pcm16k_to_mulaw8k(&pcm);
        assert_eq!(ulaw.len(), 800);
        assert!(ulaw.iter().all(|&b| b == 0xFF));
        // Positive and negative peaks have opposite sign bits (0x80).
        assert_ne!(linear16_to_mulaw(16000) & 0x80, linear16_to_mulaw(-16000) & 0x80);
    }
}
