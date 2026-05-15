import { useEffect } from 'react';
import { useAppStore } from '../stores/appStore';
import { useUpdaterStore } from '../stores/updaterStore';
import { UpdateBanner } from './UpdateBanner';
import { UpdateModal } from './UpdateModal';
import { checkForUpdates } from '../lib/updater';

/**
 * UpdateChecker is the orchestrator — it wires up the auto-check loop and
 * mounts the banner + modal. UI lives in <UpdateBanner /> and <UpdateModal />,
 * state lives in updaterStore, action helpers live in lib/updater.ts.
 *
 * Why split: auto-check vs. presentation vs. actions vs. state are 4 distinct
 * concerns. Keeping them together in one 200-line file (the v1) made it hard
 * to add Settings integration without prop-drilling or copy-paste.
 */
export function UpdateChecker() {
    const { autoCheck } = useUpdaterStore();

    useEffect(() => {
        // Only run inside the Tauri shell. Browser dev (`pnpm dev` without
        // tauri dev) lacks the plugin bridge — calling check() would throw.
        if (!window.__TAURI_INTERNALS__) return;
        if (!autoCheck) return;

        // Initial check 5s after mount — let the sidecar finish booting so we
        // don't compete for IO during the user's first impression of the app.
        const initialTimer = setTimeout(() => { checkForUpdates(); }, 5000);
        // Periodic re-check every 30 min. GitHub releases don't fire push
        // notifications, so polling is the only signal we have.
        const interval = setInterval(() => { checkForUpdates(); }, 30 * 60 * 1000);

        return () => {
            clearTimeout(initialTimer);
            clearInterval(interval);
        };
    }, [autoCheck]);

    return (
        <>
            <UpdateBanner />
            <UpdateModal />
        </>
    );
}

// Re-export so existing imports keep working, plus the new pieces.
export { useAppStore };
