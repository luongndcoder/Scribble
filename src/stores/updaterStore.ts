import { create } from 'zustand';

// Standalone store for the auto-updater because the state spans three
// components (banner, modal, Settings panel "Check now" button) and we want
// them to share a single source of truth. Keeping it separate from appStore
// avoids growing that file further — updater state is self-contained.

function safeGetItem(key: string, fallback: string = ''): string {
    try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}
function safeSetItem(key: string, value: string): void {
    try { localStorage.setItem(key, value); } catch {}
}

export type UpdaterStatus =
    | 'idle'         // no check in flight
    | 'checking'     // calling check()
    | 'available'    // update found, awaiting user
    | 'downloading'  // downloadAndInstall in flight
    | 'ready'        // download done, awaiting relaunch
    | 'error'        // last operation failed
    | 'up-to-date';  // checked, nothing new

export interface UpdateInfo {
    version: string;
    notes: string;
    date?: string;
}

interface UpdaterState {
    status: UpdaterStatus;
    available: UpdateInfo | null;
    downloaded: number;          // bytes
    total: number;               // bytes
    startedAt: number;           // perf.now() at download start (for ETA)
    error: string | null;
    /** True while the release-notes modal is open. Banner hides while modal is up. */
    modalOpen: boolean;
    /** True when the small toast-style banner is dismissed for this session. Modal can still re-open it. */
    bannerDismissed: boolean;
    /** Version the user opted to skip. Stored in localStorage. */
    skippedVersion: string;
    /** Auto-check on startup + every 30 min. Default on. */
    autoCheck: boolean;

    setStatus: (s: UpdaterStatus) => void;
    setAvailable: (info: UpdateInfo | null) => void;
    setProgress: (downloaded: number, total: number) => void;
    setError: (msg: string | null) => void;
    setModalOpen: (open: boolean) => void;
    setBannerDismissed: (v: boolean) => void;
    setSkippedVersion: (v: string) => void;
    setAutoCheck: (v: boolean) => void;
    startDownload: () => void;
    reset: () => void;
}

export const useUpdaterStore = create<UpdaterState>((set) => ({
    status: 'idle',
    available: null,
    downloaded: 0,
    total: 0,
    startedAt: 0,
    error: null,
    modalOpen: false,
    bannerDismissed: false,
    skippedVersion: safeGetItem('scribble:updater-skipped-version'),
    // Default true. We only flip to false if the user explicitly toggles it
    // off in Settings — they can still manually trigger a check from there.
    autoCheck: safeGetItem('scribble:updater-auto-check', 'true') !== 'false',

    setStatus: (s) => set({ status: s }),
    setAvailable: (info) => set({ available: info, bannerDismissed: false }),
    setProgress: (downloaded, total) => set({ downloaded, total }),
    setError: (msg) => set({ error: msg, status: msg ? 'error' : 'idle' }),
    setModalOpen: (open) => set({ modalOpen: open }),
    setBannerDismissed: (v) => set({ bannerDismissed: v }),
    setSkippedVersion: (v) => {
        safeSetItem('scribble:updater-skipped-version', v);
        set({ skippedVersion: v });
    },
    setAutoCheck: (v) => {
        safeSetItem('scribble:updater-auto-check', String(v));
        set({ autoCheck: v });
    },
    startDownload: () =>
        set({ status: 'downloading', downloaded: 0, total: 0, startedAt: performance.now(), error: null }),
    reset: () => set({
        status: 'idle', available: null, downloaded: 0, total: 0,
        startedAt: 0, error: null, modalOpen: false, bannerDismissed: false,
    }),
}));
