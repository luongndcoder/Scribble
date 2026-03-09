import { useRef, useCallback, useEffect, useState } from 'react';
import { useAppStore } from '../stores/appStore';
import { resetDiarize } from '../lib/api';



export function RecordingPanel() {
    const {
        recording, paused, seconds,
        setRecording, setPaused, setSeconds,
        clearTranscript, setCurrentView,
    } = useAppStore();

    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const timerRef = useRef<number | null>(null);
    const analyserRef = useRef<AnalyserNode | null>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const animFrameRef = useRef<number>(0);
    const [volume, setVolume] = useState(0);

    // Timer
    useEffect(() => {
        if (recording && !paused) {
            timerRef.current = window.setInterval(() => {
                useAppStore.setState((s) => ({ seconds: s.seconds + 1 }));
            }, 1000);
        }
        return () => {
            if (timerRef.current) clearInterval(timerRef.current);
        };
    }, [recording, paused]);

    // Waveform visualization
    const drawWaveform = useCallback(() => {
        const analyser = analyserRef.current;
        const canvas = canvasRef.current;
        if (!analyser || !canvas) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const { width, height } = canvas;
        const bufferLength = analyser.fftSize;
        const dataArray = new Float32Array(bufferLength);

        const draw = () => {
            animFrameRef.current = requestAnimationFrame(draw);
            analyser.getFloatTimeDomainData(dataArray);

            ctx.fillStyle = 'rgba(15, 23, 42, 0.3)';
            ctx.fillRect(0, 0, width, height);

            // Gradient line
            const gradient = ctx.createLinearGradient(0, 0, width, 0);
            gradient.addColorStop(0, '#6366f1');
            gradient.addColorStop(0.5, '#8b5cf6');
            gradient.addColorStop(1, '#ec4899');
            ctx.strokeStyle = gradient;
            ctx.lineWidth = 2;
            ctx.beginPath();

            const sliceWidth = width / bufferLength;
            let x = 0;
            for (let i = 0; i < bufferLength; i++) {
                const v = dataArray[i];
                const y = (v + 1) / 2 * height;
                if (i === 0) ctx.moveTo(x, y);
                else ctx.lineTo(x, y);
                x += sliceWidth;
            }
            ctx.stroke();

            // RMS for volume meter
            let sum = 0;
            for (let i = 0; i < bufferLength; i++) sum += dataArray[i] * dataArray[i];
            setVolume(Math.sqrt(sum / bufferLength));
        };
        draw();
    }, []);

    const startRecording = useCallback(async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            streamRef.current = stream;

            // Audio analyser
            const audioCtx = new AudioContext();
            const source = audioCtx.createMediaStreamSource(stream);
            const analyser = audioCtx.createAnalyser();
            analyser.fftSize = 2048;
            source.connect(analyser);
            analyserRef.current = analyser;

            clearTranscript();
            resetDiarize().catch(() => { });
            setRecording(true);
            setSeconds(0);

            drawWaveform();

            // Start chunked recording (VAD chunking handled in useRecording hook)
            startChunkRecording(stream);
        } catch (err) {
            console.error('Mic access denied:', err);
        }
    }, [clearTranscript, setRecording, setSeconds, drawWaveform]);

    const startChunkRecording = (stream: MediaStream) => {
        // VAD-based chunking
        const SILENCE_DURATION = 400;
        const MIN_CHUNK_SEC = 2;
        const MAX_CHUNK_SEC = 10;
        let chunkStartTime = Date.now();
        let isSilent = false;
        let silenceStart = 0;
        let recorder: MediaRecorder | null = null;
        let chunks: Blob[] = [];

        const startRecorder = () => {
            recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
            chunks = [];
            recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
            recorder.onstop = () => {
                const blob = new Blob(chunks, { type: 'audio/webm' });
                const { seconds } = useAppStore.getState();
                const endSec = seconds;
                const startSec = endSec - (Date.now() - chunkStartTime) / 1000;

                // Send to transcription
                const form = new FormData();
                form.append('audio', blob, 'chunk.webm');
                queueChunk(form, Math.max(0, startSec), endSec);

                chunkStartTime = Date.now();
                // Restart if still recording
                if (useAppStore.getState().recording && !useAppStore.getState().paused) {
                    startRecorder();
                }
            };
            recorder.start();
            mediaRecorderRef.current = recorder;
        };

        startRecorder();

        // VAD interval
        const vadInterval = setInterval(() => {
            const state = useAppStore.getState();
            if (!state.recording || state.paused || !analyserRef.current) return;

            const bufferLength = analyserRef.current.fftSize;
            const dataArray = new Float32Array(bufferLength);
            analyserRef.current.getFloatTimeDomainData(dataArray);
            let sum = 0;
            for (let i = 0; i < bufferLength; i++) sum += dataArray[i] * dataArray[i];
            const rms = Math.sqrt(sum / bufferLength);

            const now = Date.now();
            const chunkAge = (now - chunkStartTime) / 1000;
            const silent = rms < 0.015;

            if (silent) {
                if (!isSilent) { isSilent = true; silenceStart = now; }
                const silenceDuration = now - silenceStart;
                if (silenceDuration >= SILENCE_DURATION && chunkAge >= MIN_CHUNK_SEC) {
                    isSilent = false;
                    recorder?.stop();
                }
            } else {
                isSilent = false;
                silenceStart = 0;
            }

            if (chunkAge >= MAX_CHUNK_SEC) {
                isSilent = false;
                recorder?.stop();
            }
        }, 80);

        // Store cleanup ref
        (window as any).__vadInterval = vadInterval;
    };

    const queueChunk = async (form: FormData, startSec: number, endSec: number) => {
        try {
            const res = await fetch('http://localhost:8765/transcribe-diarize', { method: 'POST', body: form });
            const data = await res.json();
            const rawSegments = Array.isArray(data.segments) ? data.segments : [];
            const normalizedSegments = rawSegments
                .map((seg: any) => ({
                    text: String(seg?.text || '').trim(),
                    speakerId: seg?.speaker_id ?? 0,
                    speaker: seg?.speaker || 'Speaker 1',
                }))
                .filter((seg: any) => seg.text.length > 0);

            if (normalizedSegments.length === 0) {
                const fallbackText = String(data.text || '').trim();
                if (!fallbackText) return;
                normalizedSegments.push({
                    text: fallbackText,
                    speakerId: 0,
                    speaker: 'Speaker 1',
                });
            }

            const ts = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
            const safeStart = Math.max(0, startSec);
            const safeEnd = Math.max(safeStart, endSec);
            const perSegment = (safeEnd - safeStart) / Math.max(1, normalizedSegments.length);

            normalizedSegments.forEach((seg: any, idx: number) => {
                const segStart = safeStart + perSegment * idx;
                const segEnd = idx === normalizedSegments.length - 1
                    ? safeEnd
                    : safeStart + perSegment * (idx + 1);
                const state = useAppStore.getState();
                const lastPart = state.transcriptParts[state.transcriptParts.length - 1];
                if (lastPart && lastPart.speakerId === seg.speakerId) {
                    useAppStore.getState().appendToLastPart(seg.text, segEnd.toFixed(1));
                    return;
                }
                useAppStore.getState().addTranscriptPart({
                    text: seg.text,
                    speaker: seg.speaker,
                    speakerId: seg.speakerId,
                    startTime: segStart.toFixed(1),
                    endTime: segEnd.toFixed(1),
                    timestamp: ts,
                    translation: '',
                });
            });
        } catch (err) {
            console.error('Transcription error:', err);
        }
    };

    const stopRecording = useCallback(() => {
        setRecording(false);
        setPaused(false);
        mediaRecorderRef.current?.stop();
        streamRef.current?.getTracks().forEach((t) => t.stop());
        cancelAnimationFrame(animFrameRef.current);
        clearInterval((window as any).__vadInterval);
    }, [setRecording, setPaused]);

    const togglePause = useCallback(() => {
        setPaused(!paused);
        if (paused) {
            mediaRecorderRef.current?.resume();
        } else {
            mediaRecorderRef.current?.pause();
        }
    }, [paused, setPaused]);

    const formatTime = (s: number) => {
        const m = Math.floor(s / 60);
        const sec = s % 60;
        return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
    };

    return (
        <div className="glass rounded-2xl p-6 space-y-4">
            {/* Waveform */}
            <canvas
                ref={canvasRef}
                width={600}
                height={80}
                className="w-full rounded-lg bg-bg"
            />

            {/* Timer */}
            <div className="text-center">
                <span className="text-3xl font-mono font-bold text-text">
                    {formatTime(seconds)}
                </span>
                {recording && (
                    <span className="ml-3 inline-flex items-center gap-1 text-sm text-danger">
                        <span className="w-2 h-2 rounded-full bg-danger streaming-dot" />
                        {paused ? 'Paused' : 'Recording'}
                    </span>
                )}
            </div>

            {/* Volume meter */}
            {recording && (
                <div className="h-1 bg-bg-elevated rounded-full overflow-hidden">
                    <div
                        className="h-full bg-gradient-to-r from-primary to-pink-500 transition-all duration-100"
                        style={{ width: `${Math.min(volume * 500, 100)}%` }}
                    />
                </div>
            )}

            {/* Controls */}
            <div className="flex justify-center gap-4">
                {!recording ? (
                    <>
                        <button
                            onClick={() => { setCurrentView('list'); }}
                            className="px-4 py-2 rounded-xl bg-bg-elevated text-text-secondary hover:text-text transition-colors cursor-pointer"
                        >
                            ← Back
                        </button>
                        <button
                            onClick={startRecording}
                            className="px-8 py-3 rounded-xl bg-primary hover:bg-primary-hover text-white font-semibold transition-colors cursor-pointer shadow-lg shadow-primary/30"
                        >
                            🎙️ Start Recording
                        </button>
                    </>
                ) : (
                    <>
                        <button
                            onClick={togglePause}
                            className="px-6 py-3 rounded-xl bg-warning/20 text-warning hover:bg-warning/30 transition-colors cursor-pointer"
                        >
                            {paused ? '▶️ Resume' : '⏸️ Pause'}
                        </button>
                        <button
                            onClick={stopRecording}
                            className="px-6 py-3 rounded-xl bg-danger/20 text-danger hover:bg-danger/30 transition-colors cursor-pointer"
                        >
                            ⏹️ Stop
                        </button>
                    </>
                )}
            </div>
        </div>
    );
}
