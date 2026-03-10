import { useEffect, useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAppStore } from './stores/appStore';
import { MeetingList } from './components/MeetingList';
import { MeetingDetail } from './components/MeetingDetail';
import { RecordingBar } from './components/RecordingBar';
import { SettingsPanel } from './components/SettingsPanel';
import { ToastProvider } from './components/Toast';
import { SIDECAR_HTTP_BASES } from './lib/sidecar';
import './index.css';

const queryClient = new QueryClient();
const SIDECAR_BASES = SIDECAR_HTTP_BASES;

function App() {
  const { currentView, settingsOpen, setSettingsOpen, lang, setLang } = useAppStore();
  const [backendStatus, setBackendStatus] = useState<'online' | 'offline'>('offline');

  const showRecBar = currentView === 'recording' || currentView === 'detail';
  const backendLabel = useMemo(() => {
    if (lang === 'vi') return backendStatus === 'online' ? '✓ Sẵn sàng' : 'Đang kết nối...';
    return backendStatus === 'online' ? '✓ Ready' : 'Connecting...';
  }, [backendStatus, lang]);

  useEffect(() => {
    let active = true;
    let wasOffline = true;

    const check = async () => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        const res = await fetch(`${SIDECAR_BASES[0]}/health`, {
          cache: 'no-store',
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (active) {
          const isOnline = res.ok;
          setBackendStatus(isOnline ? 'online' : 'offline');
          // Reload data when backend comes online
          if (isOnline && wasOffline) {
            window.dispatchEvent(new Event('backend-online'));
          }
          wasOffline = !isOnline;
        }
      } catch {
        if (active) {
          setBackendStatus('offline');
          wasOffline = true;
        }
      }
    };

    check();
    const id = setInterval(check, 2000);
    return () => { active = false; clearInterval(id); };
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
                <div
                  className={`backend-status-chip ${backendStatus}`}
                  title={backendLabel}
                  aria-live="polite"
                >
                  <span className={`status-dot ${backendStatus === 'online' ? 'online' : 'offline'}`} />
                  <span>{backendLabel}</span>
                </div>
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

            {backendStatus === 'offline' && (
              <div className="startup-banner">
                <div className="startup-banner-spinner" />
                <span>{lang === 'vi' ? 'Đang kết nối...' : 'Connecting...'}</span>
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
