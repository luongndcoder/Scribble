import { useEffect, useMemo, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAppStore } from './stores/appStore';
import { MeetingList } from './components/MeetingList';
import { MeetingDetail } from './components/MeetingDetail';
import { RecordingBar } from './components/RecordingBar';
import { SettingsPanel } from './components/SettingsPanel';
import { ToastProvider, useToast } from './components/Toast';
import { UpdateChecker } from './components/UpdateChecker';
import { StartupStatusBar } from './components/StartupStatusBar';
import { SIDECAR_HTTP_BASES } from './lib/sidecar';
import './index.css';

const queryClient = new QueryClient();
const SIDECAR_BASES = SIDECAR_HTTP_BASES;

function AppInner() {
  const { currentView, settingsOpen, setSettingsOpen, lang, setLang, recording, setBackendOnline } = useAppStore();
  const { showToast } = useToast();
  const [backendStatus, setBackendStatusLocal] = useState<'online' | 'offline'>('offline');
  // Mirror local backend state into the global store so unrelated components
  // (MeetingList action buttons, RecordingBar) can gate themselves without
  // re-running their own health probes.
  const setBackendStatus = (v: 'online' | 'offline') => {
    setBackendStatusLocal(v);
    setBackendOnline(v === 'online');
  };
  const [appVersion, setAppVersion] = useState('');
  // Startup progress: 0=connecting, 1=sidecar online, 2=diarizer loaded, 3=ready
  const [startupStep, setStartupStep] = useState(0);
  const [startupElapsed, setStartupElapsed] = useState(0); // seconds since boot
  const [showStartupDetails, setShowStartupDetails] = useState(false);
  const hasBeenOnline = useRef(false);
  const startupBeganAt = useRef<number>(Date.now());

  const showRecBar = currentView === 'recording' || currentView === 'detail';
  const isOffline = backendStatus !== 'online';

  // Tick elapsed-time counter once a second while offline. Resets when we
  // go online (startupBeganAt is captured on each fresh boot cycle).
  useEffect(() => {
    if (!isOffline) {
      setStartupElapsed(0);
      return;
    }
    const id = setInterval(() => {
      setStartupElapsed(Math.floor((Date.now() - startupBeganAt.current) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [isOffline]);

  const backendLabel = useMemo(() => {
    if (backendStatus === 'online') {
      return lang === 'vi' ? '✓ Sẵn sàng' : '✓ Ready';
    }
    // Elapsed time lives in the bottom status strip — no need to also
    // surface it here (duplicate signal, eyes have to scan two corners).
    return lang === 'vi' ? 'Đang khởi động' : 'Starting';
  }, [backendStatus, lang]);

  useEffect(() => {
    if (window.__TAURI_INTERNALS__) {
      import('@tauri-apps/api/app').then(({ getVersion }) =>
        getVersion().then(v => setAppVersion(v)).catch(() => {})
      );
    }
  }, []);

  useEffect(() => {
    let active = true;
    let wasOffline = true;

    // Sequential startup: each step must complete before moving to next
    const runStartup = async () => {
      // Reset elapsed-time anchor whenever startup re-runs (initial boot or
      // a backend hiccup that knocked us offline).
      startupBeganAt.current = Date.now();
      // ── Step 0→1: Wait for sidecar to respond to /health ──
      while (active) {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 2000);
          const res = await fetch(`${SIDECAR_BASES[0]}/health`, {
            cache: 'no-store', signal: controller.signal,
          });
          clearTimeout(timeout);
          if (res.ok) {
            setStartupStep(1);
            break;
          }
        } catch {} // expected during startup
        await new Promise(r => setTimeout(r, 500));
      }
      if (!active) return;

      // ── Step 1→2: Wait for diarizer model to load ──
      while (active) {
        try {
          const dRes = await fetch(`${SIDECAR_BASES[0]}/diarizer-status`, { cache: 'no-store' });
          if (dRes.ok) {
            const dData = await dRes.json();
            if (dData.model_loaded) {
              setStartupStep(2);
              break;
            }
          }
        } catch {}
        await new Promise(r => setTimeout(r, 500));
      }
      if (!active) return;

      // ── Step 2→3: Ready — small delay for visual feedback ──
      await new Promise(r => setTimeout(r, 500));
      if (!active) return;
      setStartupStep(3);
      setBackendStatus('online');
      window.dispatchEvent(new Event('backend-online'));
      if (!hasBeenOnline.current) {
        hasBeenOnline.current = true;
        showToast(lang === 'vi' ? '✓ Hệ thống đã sẵn sàng' : '✓ System ready', 'success');
      }

      // ── Ongoing health check (slow poll) ──
      while (active) {
        await new Promise(r => setTimeout(r, 10000));
        if (!active) break;
        try {
          const res = await fetch(`${SIDECAR_BASES[0]}/health`, { cache: 'no-store' });
          if (active) {
            const isOnline = res.ok;
            setBackendStatus(isOnline ? 'online' : 'offline');
            if (!isOnline && wasOffline) {
              // Backend went down — reset startup for re-init
              setStartupStep(0);
            }
            wasOffline = !isOnline;
          }
        } catch {
          if (active) {
            setBackendStatus('offline');
            wasOffline = true;
          }
        }
      }
    };

    runStartup();
    return () => { active = false; };
  }, []);

  return (
      <QueryClientProvider client={queryClient}>
        <div className={`app ${isOffline ? 'app--offline' : ''}`}>
          <main className="main">
            {/* App shell stays interactive (scroll meeting list, open
                settings) while sidecar warms up. Buttons that need the
                backend disable themselves via the `disabled={isOffline}`
                flag below, plus the .app--offline class dims them via CSS. */}
            {/* Top Navigation */}
            <header className="topnav">
              <div className="topnav-left">
                <span className="brand">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                    strokeLinecap="round" strokeLinejoin="round" className="brand-icon">
                    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                    <line x1="12" x2="12" y1="19" y2="22" />
                  </svg>
                  Scribble
                  {appVersion && <span className="app-version">v{appVersion}</span>}
                </span>
              </div>
              <div className="topnav-right">
                <div
                  className={`backend-status-chip ${backendStatus}`}
                  title={backendLabel}
                  aria-live="polite"
                >
                  <span className={`status-dot ${backendStatus === 'online' ? 'online' : 'offline'}`} />
                  <span>{backendLabel}</span>
                </div>
                {/* Language + Settings stay enabled during startup — users
                    often want to configure API keys / language while waiting,
                    and neither needs the backend running. */}
                <button className="lang-toggle" onClick={() => setLang(lang === 'vi' ? 'en' : 'vi')}>
                  {lang === 'vi' ? 'VI' : 'EN'}
                </button>
                <button className="icon-btn" id="btnSettings" onClick={() => setSettingsOpen(true)} aria-label="Settings">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                    strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
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

            {/* Startup status — slim bottom strip (replaces the old center
                overlay). App shell stays visible behind so the user can see
                structure (logo, nav, meeting list shape) instead of staring
                at a giant blocking modal. */}
            {isOffline && !recording && (
              <StartupStatusBar
                lang={lang}
                step={startupStep}
                elapsed={startupElapsed}
                expanded={showStartupDetails}
                onToggleExpand={() => setShowStartupDetails((v) => !v)}
              />
            )}

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
