import { useRef, useEffect, useCallback } from 'react';
import { useAppStore, TranscriptPart } from '../stores/appStore';

const SPEAKER_COLORS = ['#6366f1', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];
const abortControllers: Record<number, AbortController> = {};

export function TranscriptView() {
    const { transcriptParts, translationEnabled, setTranslationEnabled, translationLang, setTranslationLang } = useAppStore();
    const bottomRef = useRef<HTMLDivElement>(null);
    const interimRef = useRef<HTMLDivElement>(null);
    const scrollRaf = useRef<number>(0);

    // Direct DOM subscription for interim text — zero re-renders
    useEffect(() => {
        const unsub = useAppStore.subscribe((state) => {
            if (interimRef.current) {
                const text = state.interimText;
                interimRef.current.style.display = (state.isTranscribing && text) ? 'flex' : 'none';
                const textEl = interimRef.current.querySelector('.interim-text');
                if (textEl) textEl.textContent = text;
            }
            // Throttled scroll
            cancelAnimationFrame(scrollRaf.current);
            scrollRaf.current = requestAnimationFrame(() => {
                bottomRef.current?.scrollIntoView({ behavior: 'auto' });
            });
        });
        return () => unsub();
    }, []);

    // Auto-scroll on new parts
    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [transcriptParts]);

    // Trigger translation when parts change
    useEffect(() => {
        if (!translationEnabled || transcriptParts.length === 0) return;
        const idx = transcriptParts.length - 1;
        translatePart(idx, transcriptParts[idx]);
    }, [transcriptParts, translationEnabled]);

    const translatePart = useCallback(async (idx: number, part: TranscriptPart) => {
        if (!part.text) return;

        // Abort previous translation for this index
        if (abortControllers[idx]) abortControllers[idx].abort();
        const ac = new AbortController();
        abortControllers[idx] = ac;

        try {
            const targetLang = useAppStore.getState().translationLang;
            const res = await fetch('http://localhost:8765/translate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: part.text, targetLang }),
                signal: ac.signal,
            });

            const reader = res.body?.getReader();
            if (!reader) return;
            const decoder = new TextDecoder();
            let buffer = '';
            let translated = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const data = JSON.parse(line.slice(6));
                            if (data.token) {
                                translated += data.token;
                                useAppStore.getState().updateTranscriptTranslation(idx, translated);
                            }
                        } catch { }
                    }
                }
            }
        } catch (err: any) {
            if (err.name === 'AbortError') return;
            console.error('Translation error:', err);
        }
    }, []);

    if (transcriptParts.length === 0) {
        return (
            <div className="glass rounded-2xl p-6 text-center text-text-secondary">
                <p className="text-4xl mb-2">🎧</p>
                <p>Transcript sẽ hiển thị ở đây khi bạn bắt đầu ghi âm</p>
            </div>
        );
    }

    return (
        <div className="glass rounded-2xl overflow-hidden">
            {/* Translation toggle */}
            <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                <span className="text-sm font-medium text-text-secondary">Transcript</span>
                <div className="flex items-center gap-3">
                    <select
                        value={translationLang}
                        onChange={(e) => setTranslationLang(e.target.value)}
                        className="bg-bg-elevated text-text text-xs rounded-md px-2 py-1 border-none outline-none"
                    >
                        <option value="en">English</option>
                        <option value="vi">Vietnamese</option>
                        <option value="ja">日本語</option>
                        <option value="ko">한국어</option>
                        <option value="zh">中文</option>
                        <option value="fr">Français</option>
                        <option value="de">Deutsch</option>
                        <option value="es">Español</option>
                        <option value="th">ภาษาไทย</option>
                        <option value="id">Bahasa Indonesia</option>
                        <option value="ru">Русский</option>
                        <option value="ar">العربية</option>
                        <option value="hi">हिन्दी</option>
                    </select>
                    <button
                        onClick={() => setTranslationEnabled(!translationEnabled)}
                        className={`px-3 py-1 text-xs rounded-full transition-colors cursor-pointer ${translationEnabled
                            ? 'bg-primary/20 text-primary'
                            : 'bg-bg-elevated text-text-secondary hover:text-text'
                            }`}
                    >
                        {translationEnabled ? '🌐 On' : '🌐 Off'}
                    </button>
                </div>
            </div>

            {/* Transcript items */}
            <div className="max-h-[60vh] overflow-y-auto p-4 space-y-3">
                {transcriptParts.map((part, idx) => (
                    <TranscriptItem key={idx} part={part} />
                ))}

                {/* Live typing indicator — updated via ref, no re-renders */}
                <div className="interim-bubble" ref={interimRef} style={{ display: 'none' }}>
                    <span className="interim-dot" />
                    <span className="interim-text"></span>
                </div>

                <div ref={bottomRef} />
            </div>
        </div>
    );
}

function TranscriptItem({ part }: { part: TranscriptPart }) {
    const speakerColor = SPEAKER_COLORS[part.speakerId % SPEAKER_COLORS.length];
    const formatSec = (v: string) => {
        const n = parseFloat(v) || 0;
        const m = Math.floor(n / 60);
        const s = Math.floor(n % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
    };

    return (
        <div className="group flex gap-3 hover:bg-bg-elevated/50 rounded-lg p-2 transition-colors">
            {/* Speaker badge */}
            <div className="flex-shrink-0 mt-0.5">
                <span
                    className="inline-flex items-center justify-center w-8 h-8 rounded-full text-xs font-bold text-white"
                    style={{ backgroundColor: speakerColor + '30', color: speakerColor }}
                >
                    S{part.speakerId + 1}
                </span>
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-medium" style={{ color: speakerColor }}>
                        {part.speaker}
                    </span>
                    <span className="text-xs text-text-secondary">
                        {formatSec(part.startTime)} - {formatSec(part.endTime)}
                    </span>
                    <span className="text-xs text-text-secondary opacity-50">
                        {part.timestamp}
                    </span>
                </div>
                <p className="text-sm text-text leading-relaxed">{part.text}</p>

                {/* Translation */}
                {part.translation && (
                    <div className="mt-1 text-sm text-primary/80 italic border-l-2 border-primary/30 pl-2">
                        {part.translation}
                    </div>
                )}
            </div>
        </div>
    );
}
