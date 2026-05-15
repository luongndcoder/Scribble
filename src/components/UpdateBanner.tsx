import { useAppStore } from '../stores/appStore';
import { useUpdaterStore } from '../stores/updaterStore';
import { formatMB, estimateETA, formatETA } from '../lib/updater';

/**
 * Slim banner that surfaces an available update or download-in-progress at
 * the bottom-right of the app. Clicking "View" opens the full release-notes
 * modal — we deliberately keep this banner small so it doesn't fight for
 * attention with whatever the user is doing.
 */
export function UpdateBanner() {
    const { lang } = useAppStore();
    const {
        status, available, downloaded, total, startedAt,
        skippedVersion, bannerDismissed,
        setModalOpen, setBannerDismissed,
    } = useUpdaterStore();

    // Suppress when there's nothing to show, user skipped this version, or
    // the modal is already open (banner would be redundant chrome).
    if (!available) return null;
    if (available.version === skippedVersion) return null;
    if (bannerDismissed && status !== 'downloading' && status !== 'ready') return null;
    if (status === 'idle' || status === 'checking' || status === 'up-to-date') return null;

    const pct = total > 0 ? Math.round((downloaded / total) * 100) : 0;
    const eta = estimateETA(downloaded, total, startedAt);

    return (
        <div className="update-banner" role="status" aria-live="polite">
            <div className="update-content">
                <div className="update-icon" aria-hidden="true">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="7 10 12 15 17 10" />
                        <line x1="12" x2="12" y1="15" y2="3" />
                    </svg>
                </div>
                <div className="update-text">
                    {status === 'available' && (
                        <>
                            <strong>
                                {lang === 'vi'
                                    ? `Bản ${available.version} đã sẵn sàng`
                                    : `Version ${available.version} available`}
                            </strong>
                            <span className="update-notes-hint">
                                {lang === 'vi' ? 'Bấm "Xem" để đọc chi tiết' : 'Click "View" for details'}
                            </span>
                        </>
                    )}
                    {status === 'downloading' && (
                        <>
                            <strong>
                                {lang === 'vi'
                                    ? `Đang tải bản ${available.version}…`
                                    : `Downloading ${available.version}…`}
                            </strong>
                            <span className="update-notes-hint">
                                {total > 0
                                    ? `${formatMB(downloaded)} / ${formatMB(total)} MB${eta ? ' · ' + formatETA(eta, lang) : ''}`
                                    : (lang === 'vi' ? 'Đang kết nối…' : 'Connecting…')}
                            </span>
                        </>
                    )}
                    {status === 'ready' && (
                        <>
                            <strong>
                                {lang === 'vi' ? 'Đang khởi động lại…' : 'Relaunching…'}
                            </strong>
                            <span className="update-notes-hint">
                                {lang === 'vi' ? 'Vui lòng chờ vài giây' : 'Please wait a few seconds'}
                            </span>
                        </>
                    )}
                </div>
                <div className="update-actions">
                    {status === 'available' && (
                        <>
                            <button className="update-btn primary" onClick={() => setModalOpen(true)}>
                                {lang === 'vi' ? 'Xem' : 'View'}
                            </button>
                            <button className="update-btn dismiss" onClick={() => setBannerDismissed(true)}>
                                {lang === 'vi' ? 'Để sau' : 'Later'}
                            </button>
                        </>
                    )}
                    {status === 'downloading' && (
                        <div className="update-progress">
                            <div className="update-progress-bar" style={{ width: `${pct}%` }} />
                            <span>{pct}%</span>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
