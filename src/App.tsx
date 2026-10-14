import { useEffect, useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useAppStore, applyTheme, resolveTheme } from './stores/appStore';
import { MeetingList } from './components/MeetingList';
import { MeetingDetail } from './components/MeetingDetail';
import { RecordingBar } from './components/RecordingBar';
import { SettingsPanel } from './components/SettingsPanel';
import { ToastProvider } from './components/Toast';
import { UpdateChecker } from './components/UpdateChecker';
import { SIDECAR_HTTP_BASES } from './lib/sidecar';
import { getSettings } from './lib/api';
import './index.css';
import { IconMic, IconMoon, IconSettings, IconSun } from './components/icons/scribble-icons';

const queryClient = new QueryClient();
const SIDECAR_BASES = SIDECAR_HTTP_BASES;

/** macOS overlay title bar leaves the traffic lights floating over our content
 *  (78×28 area starting at top-left). Detect once at module load so the topnav
 *  can reserve room. We use platform from navigator — Tauri exposes the host
 *  OS via the standard UA on macOS. */
const IS_MACOS = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');

/** Manual implementation of window dragging from the topnav.
 *
 *  `data-tauri-drag-region` is supposed to handle this declaratively, but on
 *  some Tauri 2 + macOS Overlay-titlebar combos the attribute is silently
 *  ignored. Calling `getCurrentWindow().startDragging()` from a mousedown
 *  handler is Tauri's recommended fallback.
 *
 *  IMPORTANT: `startDragging()` requires the `core:window:allow-start-dragging`
 *  capability — NOT included in `core:default`. If the capability is missing
 *  the call rejects silently. See `src-tauri/capabilities/default.json`.
 *
 *  We skip the drag when the click lands on an interactive element (button,
 *  link, input) so their onClick handlers still fire. Double-click on the
 *  topnav background triggers `toggleMaximize()` — mirrors native title-bar UX.
 *
 *  Why fire-and-forget (not async/await) — when an event handler awaits, the
 *  mousedown event loop has already moved on. Tauri's drag-start needs to be
 *  initiated synchronously while the OS still has the mouse button held. */
function handleTopnavMouseDown(e: React.MouseEvent<HTMLElement>) {
  if (e.button !== 0) return;

  const target = e.target as HTMLElement | null;
  if (target?.closest('button, a, input, select, textarea, [data-no-drag]')) return;

  if (typeof window === 'undefined' || !(window as any).__TAURI_INTERNALS__) return;

  // Capture the click count BEFORE we hand off to async land — React's
  // SyntheticEvent will be pooled after this synchronous handler returns.
  const isDoubleClick = e.detail === 2;

  const win = getCurrentWindow();
  const op = isDoubleClick ? win.toggleMaximize() : win.startDragging();
  op.catch((err) => {
    // Real error — surface it. Silent warn was hiding the actual symptom
    // for users who had the capability missing in their default.json.
    console.error(
      `[topnav] ${isDoubleClick ? 'toggleMaximize' : 'startDragging'} failed:`,
      err,
      '\nIf you see "not allowed by the scope", add the matching permission to src-tauri/capabilities/default.json.',
    );
  });
}

function AppInner() {
  const { currentView, settingsOpen, setSettingsOpen, lang, setLang, recording, setBackendOnline, setNetworkOnline, networkOnline, setAiConfigured, theme, setTheme } = useAppStore();
  const [backendStatus, setBackendStatusLocal] = useState<'online' | 'offline'>('offline');
  // Mirror local backend state into the global store so unrelated components
  // (MeetingList action buttons, RecordingBar) can gate themselves without
  // re-running their own health probes.
  const setBackendStatus = (v: 'online' | 'offline') => {
    setBackendStatusLocal(v);
    setBackendOnline(v === 'online');
  };
  const [appVersion, setAppVersion] = useState('');

  const showRecBar = currentView === 'recording' || currentView === 'detail';
  const isOffline = backendStatus !== 'online';

  // Theme: apply on boot, re-apply when the mode changes, and follow the
  // OS when mode === 'system'.
  useEffect(() => {
    applyTheme(theme);
    if (theme !== 'system' || typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme]);

  // Chip reflects TWO independent signals: the local sidecar (backendStatus)
  // AND internet reachability (networkOnline). "Ready" must mean both are up —
  // otherwise the user sees a green "Sẵn sàng" while uploads silently fail
  // because wifi dropped. networkOnline === null = unknown (sidecar down or
  // not probed yet) → don't raise a false offline alarm.
  const chipState: 'online' | 'network-offline' | 'starting' =
    backendStatus !== 'online'
      ? 'starting'
      : (networkOnline === false ? 'network-offline' : 'online');

  const backendLabel = useMemo(() => {
    if (chipState === 'online') {
      return lang === 'vi' ? 'Sẵn sàng' : 'Ready';
    }
    if (chipState === 'network-offline') {
      return lang === 'vi' ? 'Mất mạng' : 'Offline';
    }
    // Elapsed time lives in the bottom status strip — no need to also
    // surface it here (duplicate signal, eyes have to scan two corners).
    return lang === 'vi' ? 'Đang khởi động' : 'Starting';
  }, [chipState, lang]);

  useEffect(() => {
    if (window.__TAURI_INTERNALS__) {
      import('@tauri-apps/api/app').then(({ getVersion }) =>
        getVersion().then(v => setAppVersion(v)).catch(() => {})
      );
    }
  }, []);

  useEffect(() => {
    let active = true;

    // The backend is an axum server inside the Tauri process now (no Python
    // sidecar to unpack and boot), so it answers almost immediately. The old
    // multi-step startup (health → wait for the diarizer model → 500 ms
    // "visual" delay) and its bottom progress strip only added latency; the
    // speaker model loads lazily when a recording starts.
    const runStartup = async () => {
      while (active) {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 2000);
          const res = await fetch(`${SIDECAR_BASES[0]}/health`, {
            cache: 'no-store', signal: controller.signal,
          });
          clearTimeout(timeout);
          if (res.ok) break;
        } catch {} // server still binding its port
        await new Promise(r => setTimeout(r, 150));
      }
      if (!active) return;
      setBackendStatus('online');
      window.dispatchEvent(new Event('backend-online'));

      // ── Ongoing health check (slow poll) ──
      // v1.2.14: also parses `network` field so UI can surface "Mất mạng"
      // banner during long uploads. Sidecar can be online while internet is
      // down (e.g. wifi drops mid-upload) — these are independent signals.
      while (active) {
        await new Promise(r => setTimeout(r, 10000));
        if (!active) break;
        try {
          const res = await fetch(`${SIDECAR_BASES[0]}/health`, { cache: 'no-store' });
          if (active) {
            const isOnline = res.ok;
            setBackendStatus(isOnline ? 'online' : 'offline');

            // Parse network reachability if backend returned it.
            if (isOnline) {
              try {
                const body = await res.json();
                if (body?.network && typeof body.network.online === 'boolean') {
                  setNetworkOnline(body.network.online);
                }
              } catch {} // old backend without `network` field — leave null
            } else {
              // Sidecar unreachable — can't trust any cached network value.
              setNetworkOnline(null);
            }
          }
        } catch {
          if (active) {
            setBackendStatus('offline');
            setNetworkOnline(null);
          }
        }
      }
    };

    runStartup();
    return () => { active = false; };
  }, []);

  // Resolve whether the AI assistant is configured enough to summarize. Shared
  // via the store so RecordingBar (CTA) and MeetingDetail (Minutes tab) can
  // gate themselves consistently. Re-checks once the sidecar is up and again
  // whenever the Settings panel closes (the user may have just added/removed
  // AI credentials).
  useEffect(() => {
    if (backendStatus !== 'online' || settingsOpen) return;
    let cancelled = false;
    (async () => {
      try {
        const s = await getSettings();
        if (cancelled) return;
        const hasKey = !!(s.llm_api_key && String(s.llm_api_key).trim());
        const hasModel = !!(s.llm_model && String(s.llm_model).trim());
        const hasBaseUrl = !!(s.llm_base_url && String(s.llm_base_url).trim());
        const provider = s.llm_provider || 'openai';
        const credOk = hasKey || (provider === 'compatible' && hasBaseUrl);
        setAiConfigured(credOk && hasModel);
      } catch { /* keep previous value on transient failure */ }
    })();
    return () => { cancelled = true; };
  }, [backendStatus, settingsOpen, setAiConfigured]);

  return (
      <QueryClientProvider client={queryClient}>
        <div className={`app ${isOffline ? 'app--offline' : ''} ${IS_MACOS ? 'app--macos' : ''}`}>
          <main className="main">
            {/* App shell stays interactive (scroll meeting list, open
                settings) while sidecar warms up. Buttons that need the
                backend disable themselves via the `disabled={isOffline}`
                flag below, plus the .app--offline class dims them via CSS. */}
            {/* Top Navigation — onMouseDown calls Tauri's startDragging()
                directly (data-tauri-drag-region alone was unreliable on
                macOS overlay-titlebar). The handler bails out when the
                click target is a button/link, so onClick still fires. */}
            <header className="topnav" data-tauri-drag-region onMouseDown={handleTopnavMouseDown}>
              <div className="topnav-left" data-tauri-drag-region>
                <span className="brand" data-tauri-drag-region>
                  <IconMic size={18} className="brand-icon" strokeWidth={2.25} />
                  Scribble
                  {appVersion && <span className="app-version">v{appVersion}</span>}
                </span>
              </div>
              <div className="topnav-right" data-tauri-drag-region>
                <div
                  className={`backend-status-chip ${chipState}`}
                  title={backendLabel}
                  aria-live="polite"
                  data-tauri-drag-region
                >
                  <span className={`status-dot ${chipState}`} />
                  <span>{backendLabel}</span>
                </div>
                {/* Language + Settings stay enabled during startup — users
                    often want to configure API keys / language while waiting,
                    and neither needs the backend running. */}
                <button className="lang-toggle" onClick={() => setLang(lang === 'vi' ? 'en' : 'vi')}>
                  {lang === 'vi' ? 'VI' : 'EN'}
                </button>
                <button
                  className="icon-btn"
                  onClick={() => setTheme(resolveTheme(theme) === 'dark' ? 'light' : 'dark')}
                  title={lang === 'vi'
                    ? `Giao diện: ${theme === 'system' ? 'theo hệ thống' : theme === 'dark' ? 'tối' : 'sáng'} — bấm để đổi`
                    : `Theme: ${theme} — click to toggle`}
                  aria-label={lang === 'vi' ? 'Đổi giao diện sáng/tối' : 'Toggle light/dark theme'}
                >
                  <span className="t-icon-swap" data-state={resolveTheme(theme) === 'dark' ? 'b' : 'a'}>
                    <span className="t-icon" data-icon="a"><IconMoon size={18} /></span>
                    <span className="t-icon" data-icon="b"><IconSun size={18} /></span>
                  </span>
                </button>
                <button
                  className="icon-btn"
                  id="btnSettings"
                  onClick={() => setSettingsOpen(true)}
                  disabled={recording}
                  title={recording ? (lang === 'vi' ? 'Đang ghi âm — dừng ghi để chỉnh cấu hình' : 'Recording — stop to change settings') : (lang === 'vi' ? 'Cài đặt' : 'Settings')}
                  aria-label="Settings"
                >
                  <IconSettings size={18} />
                </button>
              </div>
            </header>

            {/* Main UI */}
            <>
              <div className={`tab-content ${showRecBar ? 'no-scroll' : ''}`}>
                {currentView === 'list' && <MeetingList />}
                {(currentView === 'recording' || currentView === 'detail') && <MeetingDetail />}
              </div>
              {showRecBar && <RecordingBar />}
            </>

          </main>

          {/* Settings Panel */}
          {settingsOpen && <SettingsPanel />}
          <UpdateChecker />
        </div>
      </QueryClientProvider>
  );
}

function App() {
  return (
    <ToastProvider>
      <AppInner />
    </ToastProvider>
  );
}

export default App;
