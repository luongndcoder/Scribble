import { useState } from 'react';
import { useAppStore } from '../stores/appStore';
import { fetchSidecar } from '../lib/sidecar';

export function SummaryView({ meetingId, transcript }: { meetingId: number; transcript: string }) {
    const [summary, setSummary] = useState('');
    const [loading, setLoading] = useState(false);
    const { lang } = useAppStore();

    const generateSummary = async () => {
        setLoading(true);
        setSummary('');

        try {
            const payload: any = { language: lang };
            if (meetingId) {
                payload.meetingId = meetingId;
            } else {
                payload.transcript = transcript;
            }
            const res = await fetchSidecar('/summarize', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });

            const reader = res.body?.getReader();
            if (!reader) return;
            const decoder = new TextDecoder();
            let buffer = '';
            let accumulated = '';

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
                                accumulated += data.token;
                                setSummary(accumulated);
                            }
                        } catch { }
                    }
                }
            }
        } catch (err) {
            console.error('Summary error:', err);
            setSummary('Error generating summary');
        }
        setLoading(false);
    };

    // Try to parse as JSON for structured display
    let structured: any = null;
    try {
        structured = JSON.parse(summary);
    } catch { }

    return (
        <div className="glass rounded-2xl p-6 space-y-4">
            <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-text-secondary">📋 Meeting Summary</h3>
                <button
                    onClick={generateSummary}
                    disabled={loading || !transcript}
                    className="px-4 py-2 rounded-lg bg-primary hover:bg-primary-hover text-white text-sm transition-colors cursor-pointer disabled:opacity-50"
                >
                    {loading ? '⏳ Generating...' : '✨ Generate'}
                </button>
            </div>

            {structured ? (
                <div className="space-y-4">
                    {structured.title && (
                        <h2 className="text-lg font-bold text-text">{structured.title}</h2>
                    )}
                    {structured.keyPoints?.length > 0 && (
                        <div>
                            <h4 className="text-xs font-semibold text-primary mb-2">Key Points</h4>
                            <ul className="space-y-1">
                                {structured.keyPoints.map((p: string, i: number) => (
                                    <li key={i} className="text-sm text-text flex gap-2">
                                        <span className="text-primary">•</span> {p}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                    {structured.decisions?.length > 0 && (
                        <div>
                            <h4 className="text-xs font-semibold text-success mb-2">Decisions</h4>
                            <ul className="space-y-1">
                                {structured.decisions.map((d: string, i: number) => (
                                    <li key={i} className="text-sm text-text flex gap-2">
                                        <span className="text-success">✓</span> {d}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                    {structured.actionItems?.length > 0 && (
                        <div>
                            <h4 className="text-xs font-semibold text-warning mb-2">Action Items</h4>
                            <ul className="space-y-2">
                                {structured.actionItems.map((a: any, i: number) => (
                                    <li key={i} className="text-sm text-text bg-bg-elevated rounded-lg p-2">
                                        <span className="font-medium">{a.task}</span>
                                        {a.assignee && <span className="text-text-secondary ml-2">→ {a.assignee}</span>}
                                        {a.deadline && <span className="text-warning ml-2">📅 {a.deadline}</span>}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                    {structured.summary && (
                        <div>
                            <h4 className="text-xs font-semibold text-text-secondary mb-2">Summary</h4>
                            <p className="text-sm text-text leading-relaxed">{structured.summary}</p>
                        </div>
                    )}
                </div>
            ) : summary ? (
                <div className="text-sm text-text leading-relaxed whitespace-pre-wrap">
                    {summary}
                    {loading && <span className="streaming-dot ml-1">●</span>}
                </div>
            ) : (
                <p className="text-sm text-text-secondary text-center py-4">
                    Click "Generate" to create a meeting summary
                </p>
            )}
        </div>
    );
}
