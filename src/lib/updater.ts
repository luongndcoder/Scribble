// Centralized updater action helpers so banner/modal/Settings can all
// trigger the same flows. We avoid storing the tauri `Update` object in
// zustand (it's a class instance from a JS bridge — not serializable, not
// stable across re-renders), and instead re-call check() right before
// install. This is what the Tauri docs recommend.

import { useUpdaterStore } from '../stores/updaterStore';

declare global {
    interface Window {
        __TAURI_INTERNALS__?: unknown;
    }
}

function inTauri(): boolean {
    return typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;
}

/** Probe the configured updater endpoint. Updates the store with the result. */
export async function checkForUpdates(opts: { manual?: boolean } = {}): Promise<void> {
    if (!inTauri()) return;
    const store = useUpdaterStore.getState();

    // Don't re-check while a download is in flight — that would leave the
    // user with two parallel install attempts.
    if (store.status === 'downloading' || store.status === 'ready') return;

    store.setStatus('checking');
    store.setError(null);

    try {
        const { check } = await import('@tauri-apps/plugin-updater');
        const result = await check();
        if (result?.available) {
            useUpdaterStore.getState().setAvailable({
                version: result.version,
                notes: result.body || '',
                date: result.date,
            });
            useUpdaterStore.getState().setStatus('available');
        } else {
            useUpdaterStore.getState().setAvailable(null);
            useUpdaterStore.getState().setStatus('up-to-date');
            // For manual checks, leave 'up-to-date' visible briefly so the
            // user sees confirmation; auto-checks fade silently.
            if (opts.manual) {
                setTimeout(() => {
                    const s = useUpdaterStore.getState();
                    if (s.status === 'up-to-date') s.setStatus('idle');
                }, 3500);
            }
        }
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // The endpoint returning 404 (no manifest yet) hits the catch path
        // with "Network Error" or similar — surface a cleaner message.
        const friendly = /404|not.found|network/i.test(msg)
            ? 'Update server unreachable'
            : msg;
        console.warn('[updater] Check failed:', e);
        useUpdaterStore.getState().setError(friendly);
    }
}

/** Download + install the available update, then relaunch. */
export async function downloadAndInstall(): Promise<void> {
    if (!inTauri()) return;
    const store = useUpdaterStore.getState();
    if (!store.available) return;

    store.startDownload();
    try {
        const { check } = await import('@tauri-apps/plugin-updater');
        const result = await check();
        if (!result?.available) {
            store.setError('Update no longer available');
            return;
        }

        let downloaded = 0;
        let total = 0;
        await result.downloadAndInstall((event) => {
            const s = useUpdaterStore.getState();
            if (event.event === 'Started' && event.data.contentLength) {
                total = event.data.contentLength;
                s.setProgress(0, total);
            } else if (event.event === 'Progress') {
                downloaded += event.data.chunkLength;
                s.setProgress(downloaded, total);
            } else if (event.event === 'Finished') {
                s.setProgress(total, total);
                s.setStatus('ready');
            }
        });

        // Relaunch — on success this never returns (process is replaced).
        const { relaunch } = await import('@tauri-apps/plugin-process');
        await relaunch();
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[updater] Install failed:', e);
        useUpdaterStore.getState().setError(msg);
    }
}

/** Format bytes as MB (1 decimal) for the progress display. */
export function formatMB(bytes: number): string {
    return (bytes / 1024 / 1024).toFixed(1);
}

/** Estimate seconds remaining based on bytes/elapsed. Returns null if not yet meaningful. */
export function estimateETA(downloaded: number, total: number, startedAt: number): number | null {
    if (downloaded <= 0 || total <= 0 || startedAt <= 0) return null;
    const elapsed = (performance.now() - startedAt) / 1000;
    if (elapsed < 1) return null;
    const bps = downloaded / elapsed;
    if (bps <= 0) return null;
    const remaining = total - downloaded;
    return Math.ceil(remaining / bps);
}

export function formatETA(seconds: number | null, lang: 'vi' | 'en'): string {
    if (seconds === null || !Number.isFinite(seconds)) return '';
    if (seconds < 60) return lang === 'vi' ? `${seconds}s còn lại` : `${seconds}s left`;
    const min = Math.ceil(seconds / 60);
    return lang === 'vi' ? `~${min} phút còn lại` : `~${min} min left`;
}
