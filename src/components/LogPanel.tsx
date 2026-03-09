import { useEffect, useRef, useState } from 'react';

const BASE = 'http://127.0.0.1:8765';

export function LogPanel() {
    const [open, setOpen] = useState(false);
    const [lines, setLines] = useState<string[]>([]);
    const [filter, setFilter] = useState('');
    const bottomRef = useRef<HTMLDivElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const esRef = useRef<EventSource | null>(null);

    useEffect(() => {
        if (!open) return;

        const es = new EventSource(`${BASE}/logs`);
        esRef.current = es;

        es.onmessage = (ev) => {
            setLines((prev) => {
                const next = [...prev, ev.data];
                return next.length > 500 ? next.slice(-500) : next;
            });
        };

        es.onerror = () => {
            es.close();
            // Reconnect after 2s
            setTimeout(() => {
                if (esRef.current === es) {
                    esRef.current = null;
                }
            }, 2000);
        };

        return () => {
            es.close();
            esRef.current = null;
        };
    }, [open]);

    useEffect(() => {
        if (!open || !scrollRef.current) return;
        const el = scrollRef.current;
        const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        if (isNearBottom && bottomRef.current) {
            bottomRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [lines, open]);

    const filtered = filter
        ? lines.filter((l) => l.toLowerCase().includes(filter.toLowerCase()))
        : lines;

    // Filter out noisy health checks
    const display = filtered.filter(
        (l) => !l.includes('GET /health') && !l.includes('GET /meetings')
    );

    return (
        <div className={`log-panel ${open ? 'log-panel--open' : ''}`}>
            <button
                className="log-panel__toggle"
                onClick={() => setOpen((v) => !v)}
            >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
                    <path d="M13 2v7h7" />
                </svg>
                <span>BE Logs</span>
                <span className="log-panel__badge">{display.length}</span>
                <svg
                    width="12" height="12" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" strokeWidth="2.5"
                    style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}
                >
                    <path d="M18 15l-6-6-6 6" />
                </svg>
            </button>

            {open && (
                <div className="log-panel__body">
                    <div className="log-panel__toolbar">
                        <input
                            className="log-panel__filter"
                            placeholder="Filter logs..."
                            value={filter}
                            onChange={(e) => setFilter(e.target.value)}
                        />
                        <button
                            className="log-panel__clear"
                            onClick={() => setLines([])}
                            title="Clear"
                        >
                            ✕
                        </button>
                    </div>
                    <div className="log-panel__scroll" ref={scrollRef}>
                        {display.map((line, i) => (
                            <div
                                key={i}
                                className={`log-line ${line.includes('ERROR') || line.includes('failed')
                                    ? 'log-line--error'
                                    : line.includes('WARNING') || line.includes('Warn')
                                        ? 'log-line--warn'
                                        : line.includes('[diarize]')
                                            ? 'log-line--diarize'
                                            : ''
                                    }`}
                            >
                                {line}
                            </div>
                        ))}
                        <div ref={bottomRef} />
                    </div>
                </div>
            )}
        </div>
    );
}
