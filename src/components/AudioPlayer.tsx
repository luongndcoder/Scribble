import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { CSSProperties, ChangeEvent } from 'react';

/** Imperative handle so a parent (e.g. MeetingDetail) can drive playback —
 *  used by transcript "click-to-seek": jump the audio to a segment's start. */
export interface AudioPlayerHandle {
    /** Seek to `sec` seconds and start playing. */
    seek: (sec: number) => void;
}

interface AudioPlayerProps {
    src: string;
    /** Fired continuously during playback with the current position (seconds).
     *  Lets the parent follow the transcript to the spoken segment. */
    onTime?: (sec: number) => void;
}

const formatTime = (seconds: number): string => {
    if (!isFinite(seconds) || seconds < 0) return '0:00';
    const total = Math.floor(seconds);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
};

/**
 * Lightweight, on-tone audio player: play/pause + seek + time labels.
 * Native <audio> kept hidden and driven via ref so we can theme the UI
 * to match the app's indigo/gray palette.
 */
const AudioPlayer = forwardRef<AudioPlayerHandle, AudioPlayerProps>(function AudioPlayer(
    { src, onTime },
    ref,
) {
    const audioRef = useRef<HTMLAudioElement>(null);
    const [playing, setPlaying] = useState(false);
    const [current, setCurrent] = useState(0);
    const [duration, setDuration] = useState(0);
    const [ready, setReady] = useState(false);

    // Reset transport state whenever the source changes.
    useEffect(() => {
        setPlaying(false);
        setCurrent(0);
        setDuration(0);
        setReady(false);
    }, [src]);

    useImperativeHandle(ref, () => ({
        seek: (sec: number) => {
            const audio = audioRef.current;
            if (!audio || !Number.isFinite(sec)) return;
            audio.currentTime = Math.max(0, sec);
            setCurrent(audio.currentTime);
            void audio.play();
        },
    }), []);

    const togglePlay = () => {
        const audio = audioRef.current;
        if (!audio) return;
        if (audio.paused) {
            void audio.play();
        } else {
            audio.pause();
        }
    };

    const handleSeek = (e: ChangeEvent<HTMLInputElement>) => {
        const audio = audioRef.current;
        if (!audio) return;
        const next = Number(e.target.value);
        audio.currentTime = next;
        setCurrent(next);
    };

    const progress = duration > 0 ? (current / duration) * 100 : 0;
    const seekStyle = { ['--audio-progress' as string]: `${progress}%` } as CSSProperties;

    return (
        <div className="audio-player">
            <audio
                ref={audioRef}
                src={src}
                preload="metadata"
                onLoadedMetadata={(e) => { setDuration(e.currentTarget.duration); setReady(true); }}
                onTimeUpdate={(e) => {
                    const t = e.currentTarget.currentTime;
                    setCurrent(t);
                    onTime?.(t);
                }}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onEnded={() => setPlaying(false)}
            />
            <button
                type="button"
                className="audio-play-btn"
                onClick={togglePlay}
                aria-label={playing ? 'Tạm dừng' : 'Phát'}
            >
                {playing ? (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                        <rect x="6" y="5" width="4" height="14" rx="1" />
                        <rect x="14" y="5" width="4" height="14" rx="1" />
                    </svg>
                ) : (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M8 5.14v13.72a1 1 0 0 0 1.54.84l10.7-6.86a1 1 0 0 0 0-1.68L9.54 4.3A1 1 0 0 0 8 5.14z" />
                    </svg>
                )}
            </button>
            <span className="audio-time">{formatTime(current)}</span>
            <input
                type="range"
                className="audio-seek"
                min={0}
                max={duration || 0}
                step={0.1}
                value={current}
                onChange={handleSeek}
                disabled={!ready}
                style={seekStyle}
                aria-label="Tua audio"
            />
            <span className="audio-time audio-time-total">{formatTime(duration)}</span>
        </div>
    );
});

export default AudioPlayer;
