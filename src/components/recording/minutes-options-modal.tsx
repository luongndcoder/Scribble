/**
 * MinutesOptionsModal — small popover dialog for choosing the summary language
 * and template/prompt right before generating minutes. These two controls used
 * to sit permanently in the recording bar; moving them into an on-demand popup
 * keeps the bar compact (the bar then shows just the "Create Minutes" CTA).
 *
 * Reads/writes the summary options directly on the global store so the existing
 * summarize() flow (which reads summaryLang / summaryTemplate / customPrompt)
 * needs no change — this modal is purely the UI for setting them, then calls
 * back via onConfirm to kick off generation.
 */
import { useAppStore } from '../../stores/appStore';
import { CustomSelect } from '../CustomSelect';

interface MinutesOptionsModalProps {
    open: boolean;
    lang: string;
    onClose: () => void;
    onConfirm: () => void;
}

export function MinutesOptionsModal({ open, lang, onClose, onConfirm }: MinutesOptionsModalProps) {
    const summaryLang = useAppStore((s) => s.summaryLang);
    const setSummaryLang = useAppStore((s) => s.setSummaryLang);
    const summaryTemplate = useAppStore((s) => s.summaryTemplate);
    const setSummaryTemplate = useAppStore((s) => s.setSummaryTemplate);
    const customPrompt = useAppStore((s) => s.customPrompt);
    const setCustomPrompt = useAppStore((s) => s.setCustomPrompt);

    if (!open) return null;

    const vi = lang === 'vi';

    return (
        <div className="minutes-modal-overlay" onClick={onClose}>
            <div className="minutes-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
                <div className="minutes-modal-header">
                    <div className="minutes-modal-title">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.8 1.9a2 2 0 0 1 1.288 1.287L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.8-1.9a2 2 0 0 1-1.288-1.287Z" />
                        </svg>
                        <span>{vi ? 'Tạo biên bản' : 'Create Minutes'}</span>
                    </div>
                    <button className="minutes-modal-close" onClick={onClose} aria-label={vi ? 'Đóng' : 'Close'}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M18 6 6 18" /><path d="m6 6 12 12" />
                        </svg>
                    </button>
                </div>

                <div className="minutes-modal-body">
                    <div className="minutes-modal-field">
                        <label>{vi ? 'Ngôn ngữ' : 'Language'}</label>
                        <CustomSelect
                            value={summaryLang}
                            onChange={setSummaryLang}
                            options={[
                                { value: 'vi', label: 'Vietnamese' },
                                { value: 'en', label: 'English' },
                            ]}
                        />
                    </div>

                    <div className="minutes-modal-field">
                        <label>{vi ? 'Kiểu biên bản' : 'Template'}</label>
                        <CustomSelect
                            value={summaryTemplate}
                            onChange={setSummaryTemplate}
                            options={[
                                { value: 'mom', label: vi ? 'Biên bản (MoM)' : 'Minutes (MoM)' },
                                { value: 'deep', label: vi ? 'Phân tích chi tiết' : 'Deep Analysis' },
                                { value: 'summary', label: vi ? 'Tóm tắt' : 'Summary' },
                                { value: 'bullets', label: 'Bullet Points' },
                                { value: 'custom', label: vi ? 'Tùy chỉnh' : 'Custom Prompt' },
                            ]}
                        />
                    </div>

                    {summaryTemplate === 'custom' && (
                        <div className="minutes-modal-field">
                            <label>{vi ? 'Prompt tùy chỉnh' : 'Custom prompt'}</label>
                            <textarea
                                className="custom-prompt-input"
                                value={customPrompt}
                                onChange={(e) => setCustomPrompt(e.target.value)}
                                placeholder={vi ? 'Nhập prompt tùy chỉnh...' : 'Enter your custom prompt...'}
                                rows={3}
                            />
                        </div>
                    )}
                </div>

                <div className="minutes-modal-footer">
                    <button className="action-btn" onClick={onClose}>
                        {vi ? 'Huỷ' : 'Cancel'}
                    </button>
                    <button className="action-btn primary minutes-modal-confirm" onClick={onConfirm}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.8 1.9a2 2 0 0 1 1.288 1.287L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.8-1.9a2 2 0 0 1-1.288-1.287Z" />
                        </svg>
                        <span>{vi ? 'Tạo biên bản' : 'Create Minutes'}</span>
                    </button>
                </div>
            </div>
        </div>
    );
}
