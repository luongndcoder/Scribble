import { useEffect, useState } from 'react';
import { useAppStore } from '../stores/appStore';

interface UpdateInfo {
    version: string;
    body: string;
}

export function UpdateChecker() {
    const { lang } = useAppStore();
    const [update, setUpdate] = useState<UpdateInfo | null>(null);
    const [downloading, setDownloading] = useState(false);
    const [progress, setProgress] = useState(0);
    const [dismissed, setDismissed] = useState(false);

    useEffect(() => {
        // Only check in Tauri environment
        if (!(window as Window).__TAURI_INTERNALS__) return;

        const checkUpdate = async () => {
            try {
                const { check } = await import('@tauri-apps/plugin-updater');
                const result = await check();
                if (result?.available) {
                    setUpdate({
                        version: result.version,
                        body: result.body || '',
                    });
                }
            } catch (e) {
                console.warn('[updater] Check failed:', e);
            }
        };

        // Check after 5 seconds (let app finish loading first)
        const timer = setTimeout(checkUpdate, 5000);
        // Re-check every 30 minutes
        const interval = setInterval(checkUpdate, 30 * 60 * 1000);
        return () => { clearTimeout(timer); clearInterval(interval); };
    }, []);

    const handleUpdate = async () => {
        setDownloading(true);
        setProgress(0);
        try {
            const { check } = await import('@tauri-apps/plugin-updater');
            const result = await check();
            if (!result?.available) return;

            let downloaded = 0;
            let total = 0;
            await result.downloadAndInstall((event) => {
                if (event.event === 'Started' && event.data.contentLength) {
                    total = event.data.contentLength;
                } else if (event.event === 'Progress') {
                    downloaded += event.data.chunkLength;
                    if (total > 0) setProgress(Math.round((downloaded / total) * 100));
                } else if (event.event === 'Finished') {
                    setProgress(100);
                }
            });

            // Restart app after install
            const { relaunch } = await import('@tauri-apps/plugin-process');
            await relaunch();
        } catch (e) {
            console.error('[updater] Download failed:', e);
            setDownloading(false);
        }
    };

    if (!update || dismissed) return null;

    return (
        <div className="update-banner">
            <div className="update-content">
                <div className="update-icon">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="7 10 12 15 17 10" />
                        <line x1="12" x2="12" y1="15" y2="3" />
                    </svg>
                </div>
                <div className="update-text">
                    <strong>
                        {lang === 'vi'
                            ? `Phiên bản ${update.version} đã sẵn sàng`
                            : `Version ${update.version} available`}
                    </strong>
                    {update.body && <span className="update-notes">{update.body.slice(0, 100)}</span>}
                </div>
                <div className="update-actions">
                    {downloading ? (
                        <div className="update-progress">
                            <div className="update-progress-bar" style={{ width: `${progress}%` }} />
                            <span>{progress}%</span>
                        </div>
                    ) : (
                        <>
                            <button className="update-btn primary" onClick={handleUpdate}>
                                {lang === 'vi' ? 'Cập nhật' : 'Update'}
                            </button>
                            <button className="update-btn dismiss" onClick={() => setDismissed(true)}>
                                {lang === 'vi' ? 'Để sau' : 'Later'}
                            </button>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
