import { useEffect, useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAppStore } from './stores/appStore';
import { MeetingList } from './components/MeetingList';
import { MeetingDetail } from './components/MeetingDetail';
import { RecordingBar } from './components/RecordingBar';
import { SettingsPanel } from './components/SettingsPanel';
import { ToastProvider } from './components/Toast';
import './index.css';

const queryClient = new QueryClient();
const SIDECAR_BASES = ['http://127.0.0.1:8765', 'http://localhost:8765'] as const;

function App() {
  const { currentView, settingsOpen, setSettingsOpen, lang, setLang } = useAppStore();
  const [backendStatus, setBackendStatus] = useState<'starting' | 'online' | 'offline' | 'hidden'>('starting');

  const showRecBar = currentView === 'recording' || currentView === 'detail';
  const backendLabel = useMemo(() => {
    if (lang === 'vi') {
      if (backendStatus === 'online') return '✓ Sẵn sàng';
      if (backendStatus === 'offline') return 'Đang kết nối...';
      if (backendStatus === 'starting') return 'Đang khởi động...';
      return '';
    }
    if (backendStatus === 'online') return '✓ Ready';
    if (backendStatus === 'offline') return 'Connecting...';
    if (backendStatus === 'starting') return 'Starting up...';
    return '';
  }, [backendStatus, lang]);

  useEffect(() => {
    let isDisposed = false;
    let failStreak = 0;
    const startedAt = Date.now();
    const GRACE_PERIOD_MS = 15_000; // Stay 'starting' for at least 15s
    const OFFLINE_THRESHOLD = 5;     // Need 5+ consecutive fails
    let hideTimer: ReturnType<typeof setTimeout> | null = null;

    const check = async () => {
      let ok = false;
      for (const base of SIDECAR_BASES) {
        try {
          const res = await fetch(`${base}/health`, { cache: 'no-store' });
          if (res.ok) {
            ok = true;
            break;
          }
        } catch { }
      }

      if (isDisposed) return;

      if (ok) {
        failStreak = 0;
        setBackendStatus('online');
        // Auto-hide the chip after 3s when online
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = setTimeout(() => {
          if (!isDisposed) setBackendStatus('hidden');
        }, 3000);
      } else {
        failStreak += 1;
        if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
        setBackendStatus((prev) => {
          // If was online, give benefit of the doubt (temporary network hiccup)
          if (prev === 'online' || prev === 'hidden') {
            return failStreak <= 2 ? prev : 'starting';
          }
          // During grace period, stay 'starting' — sidecar is booting
          if (Date.now() - startedAt < GRACE_PERIOD_MS) return 'starting';
          // After grace period, need enough failures to show offline
          return failStreak >= OFFLINE_THRESHOLD ? 'offline' : 'starting';
        });
      }
    };

    void check();
    const id = window.setInterval(() => { void check(); }, 2000);
    return () => {
      isDisposed = true;
      window.clearInterval(id);
      if (hideTimer) clearTimeout(hideTimer);
    };
  }, []);

  return (
    <ToastProvider>
      <QueryClientProvider client={queryClient}>
        <div className="app">
          <main className="main">
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
                </span>
              </div>
              <div className="topnav-right">
                {backendStatus !== 'hidden' && (
                  <div
                    className={`backend-status-chip ${backendStatus}`}
                    title={backendLabel}
                    aria-live="polite"
                  >
                    <span className={`status-dot ${backendStatus === 'online' ? 'online' : backendStatus === 'offline' ? 'offline' : 'loading'}`} />
                    <span>{backendLabel}</span>
                  </div>
                )}
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

            {/* Main UI — always render immediately */}
            <>
              <div className={`tab-content ${showRecBar ? 'no-scroll' : ''}`}>
                {currentView === 'list' && <MeetingList />}
                {(currentView === 'recording' || currentView === 'detail') && <MeetingDetail />}
              </div>
              {showRecBar && <RecordingBar />}
            </>

            {/* Startup banner — non-blocking, auto-hides when ready */}
            {(backendStatus === 'starting' || backendStatus === 'offline') && (
              <div className="startup-banner">
                <div className="startup-banner-spinner" />
                <span>{backendStatus === 'starting'
                  ? (lang === 'vi' ? 'Đang khởi động...' : 'Starting up...')
                  : (lang === 'vi' ? 'Đang kết nối lại...' : 'Reconnecting...')
                }</span>
              </div>
            )}
          </main>

          {/* Settings Panel */}
          {settingsOpen && <SettingsPanel />}
        </div>
      </QueryClientProvider>
    </ToastProvider >
  );
}

export default App;
