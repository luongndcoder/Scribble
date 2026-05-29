/**
 * NetworkOfflineBanner — consumes `networkOnline` from the global store and
 * surfaces a warning when the backend's TCP probe (1.1.1.1:443) reports the
 * user's machine has lost internet. Designed to be dropped into any long-
 * running flow (upload progress, retry-failed-chunks) so the user knows
 * WHY a step suddenly stalled.
 *
 * Recovery loop: while offline, this component force-probes /ping-network
 * every 3s instead of waiting for App.tsx's 10s /health poll. Banner hides
 * the instant the probe flips back to online. Without this, the user would
 * see "Mất kết nối" for up to 10s after wifi returned — which feels broken.
 *
 * Render gates:
 *   - networkOnline === false → show banner
 *   - networkOnline === null (initial / sidecar down) → don't show (the
 *     sidecar-offline state is surfaced elsewhere via backendOnline)
 *   - networkOnline === true → don't show
 */
import { useEffect } from 'react';
import { useAppStore } from '../stores/appStore';
import { pingNetwork } from '../lib/api';

const FAST_PROBE_INTERVAL_MS = 3000;

export function NetworkOfflineBanner() {
    const networkOnline = useAppStore((s) => s.networkOnline);
    const lang = useAppStore((s) => s.lang);

    // Force-poll network every 3s while offline. Cheaper than waiting for the
    // 10s /health cadence and gives the user near-instant "back online"
    // feedback when wifi returns.
    useEffect(() => {
        if (networkOnline !== false) return;
        const id = setInterval(() => {
            pingNetwork()
                .then((n) => useAppStore.getState().setNetworkOnline(n.online))
                .catch(() => {
                    // Sidecar itself unreachable — App.tsx's health poll already
                    // handles this. Leave networkOnline as-is so we don't
                    // false-flip to online.
                });
        }, FAST_PROBE_INTERVAL_MS);
        return () => clearInterval(id);
    }, [networkOnline]);

    if (networkOnline !== false) return null;

    return (
        <div className="network-offline-banner" role="alert" aria-live="assertive">
            <div className="network-offline-banner-icon" aria-hidden>
                {/* wifi-off icon */}
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                     stroke="currentColor" strokeWidth="2"
                     strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 1l22 22" />
                    <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
                    <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
                    <path d="M10.71 5.05A16 16 0 0 1 22.58 9" />
                    <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
                    <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
                    <line x1="12" y1="20" x2="12.01" y2="20" />
                </svg>
            </div>
            <div className="network-offline-banner-body">
                <div className="network-offline-banner-title">
                    {lang === 'vi' ? 'Mất kết nối Internet' : 'Internet connection lost'}
                </div>
                <div className="network-offline-banner-sub">
                    {lang === 'vi'
                        ? 'Đang chờ mạng quay lại — quá trình sẽ tự thử lại khi có kết nối.'
                        : 'Waiting for network — the pipeline will auto-retry once connection returns.'}
                </div>
            </div>
            <div className="network-offline-banner-spinner" aria-hidden />
        </div>
    );
}
