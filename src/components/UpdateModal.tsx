import { useEffect } from 'react';
import { useAppStore } from '../stores/appStore';
import { useUpdaterStore } from '../stores/updaterStore';
import { downloadAndInstall, formatMB, estimateETA, formatETA } from '../lib/updater';
import { Markdown } from '../lib/markdown';
import { IconClose, IconDownload } from './icons/scribble-icons';

/**
 * Full release-notes modal. Opens from the banner's "View" button or from
 * the Settings panel's "Check for updates now" button (when an update is
 * found). Renders the release body verbatim — we intentionally don't
 * markdown-parse it because the GH release body uses simple bullet lists
 * that read fine as plain text, and pulling in a markdown lib for this one
 * surface would be wasteful.
 */
export function UpdateModal() {
    const { lang } = useAppStore();
    const {
        modalOpen, available, status, downloaded, total, startedAt, error,
        setModalOpen, setSkippedVersion,
    } = useUpdaterStore();

    // Close on Escape — standard modal behavior. We don't close on backdrop
    // click during download, otherwise the user could lose visibility into
    // the in-flight install accidentally.
    useEffect(() => {
        if (!modalOpen) return;
        const handler = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && status !== 'downloading' && status !== 'installing' && status !== 'ready') {
                setModalOpen(false);
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [modalOpen, status, setModalOpen]);

    if (!modalOpen || !available) return null;

    const pct = total > 0 ? Math.round((downloaded / total) * 100) : 0;
    const eta = estimateETA(downloaded, total, startedAt);
    const installing = status === 'downloading' || status === 'installing' || status === 'ready';

    const handleSkip = () => {
        setSkippedVersion(available.version);
        setModalOpen(false);
    };

    const handleBackdrop = (e: React.MouseEvent) => {
        if (e.target === e.currentTarget && !installing) setModalOpen(false);
    };

    return (
        <div className="update-modal-backdrop" onClick={handleBackdrop} role="dialog" aria-modal="true">
            <div className="update-modal">
                <div className="update-modal-header">
                    <div className="update-modal-title">
                        <IconDownload size={22} />
                        <div>
                            <h3>
                                {lang === 'vi'
                                    ? `Phiên bản ${available.version}`
                                    : `Version ${available.version}`}
                            </h3>
                            {available.date && (
                                <span className="update-modal-date">
                                    {new Date(available.date).toLocaleDateString(lang === 'vi' ? 'vi-VN' : 'en-US', {
                                        year: 'numeric', month: 'long', day: 'numeric',
                                    })}
                                </span>
                            )}
                        </div>
                    </div>
                    {!installing && (
                        <button
                            className="update-modal-close"
                            onClick={() => setModalOpen(false)}
                            aria-label={lang === 'vi' ? 'Đóng' : 'Close'}
                        >
                            <IconClose size={16} />
                        </button>
                    )}
                </div>

                <div className="update-modal-body">
                    <h4>{lang === 'vi' ? 'Có gì mới' : "What's new"}</h4>
                    {/* Use our minimal markdown renderer (lib/markdown.tsx).
                        Falls back to plain text if release notes are absent. */}
                    <div className="update-modal-notes">
                        {available.notes
                            ? <Markdown>{available.notes}</Markdown>
                            : <p className="md-p">{lang === 'vi' ? 'Không có ghi chú.' : 'No release notes.'}</p>}
                    </div>
                </div>

                {installing && (
                    <div className="update-modal-progress">
                        <div className="update-modal-progress-bar">
                            <div className="update-modal-progress-fill" style={{ width: `${pct}%` }} />
                        </div>
                        <div className="update-modal-progress-meta">
                            <span>
                                {status === 'ready'
                                    ? (lang === 'vi' ? 'Đang khởi động lại…' : 'Relaunching…')
                                    : status === 'installing'
                                        ? (lang === 'vi' ? 'Đang cài đặt…' : 'Installing update…')
                                        : total > 0
                                            ? `${formatMB(downloaded)} / ${formatMB(total)} MB`
                                            : (lang === 'vi' ? 'Đang kết nối…' : 'Connecting…')}
                            </span>
                            <span>{status === 'installing' ? '100%' : `${pct}%`}{eta && status === 'downloading' ? ' · ' + formatETA(eta, lang) : ''}</span>
                        </div>
                    </div>
                )}

                {error && !installing && (
                    <div className="update-modal-error" role="alert">
                        {lang === 'vi' ? 'Lỗi: ' : 'Error: '}{error}
                    </div>
                )}

                <div className="update-modal-footer">
                    {!installing && (
                        <>
                            <button className="update-modal-btn ghost" onClick={handleSkip}>
                                {lang === 'vi' ? 'Bỏ qua bản này' : 'Skip this version'}
                            </button>
                            <button className="update-modal-btn ghost" onClick={() => setModalOpen(false)}>
                                {lang === 'vi' ? 'Để sau' : 'Later'}
                            </button>
                            <button className="update-modal-btn primary" onClick={downloadAndInstall}>
                                {lang === 'vi' ? 'Cập nhật ngay' : 'Update now'}
                            </button>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
