import { useState, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { useAppStore } from '../stores/appStore';
import { useUpdaterStore } from '../stores/updaterStore';
import { checkForUpdates } from '../lib/updater';
import { getSettings, saveSettings, diagnose, fetchLLMModels, getLocalModelStatus, downloadLocalModel } from '../lib/api';
import type { LocalModelStatus } from '../lib/api';
import { STT_LANGUAGES } from '../lib/language-options';
import { t } from '../i18n';
import { CustomSelect } from './CustomSelect';
import { useToast } from './Toast';
import { IconAlert, IconCheck, IconCheckCircle, IconClose, IconDownload, IconEye, IconEyeOff, IconMic, IconMoon, IconNib, IconSettings, IconSpinner, IconSun, IconSystem } from './icons/scribble-icons';

/** The STT providers this build supports. Anything else stored in the DB
 *  (notably the removed 'nvidia') is migrated — see `migrateProvider`. */
type SttProvider = 'soniox' | 'local';

/**
 * Map a stored `stt_provider` value onto a supported provider.
 * The removed Nvidia/Riva provider maps to 'soniox' (the closest remaining
 * cloud option, and what the user was implicitly using credits for). Any
 * unknown value falls back to the 'local' default.
 *
 * Note: we deliberately do NOT touch the stored `nvidia_api_key` — it stays
 * in the database untouched so the value survives if support ever returns.
 */
function migrateProvider(raw: string | undefined): SttProvider {
    const v = (raw || '').toLowerCase();
    if (v === 'nvidia') return 'soniox';
    if (v === 'soniox') return 'soniox';
    return 'local';
}

export function SettingsPanel() {
    const { setSettingsOpen, lang, theme, setTheme } = useAppStore();
    const { showToast } = useToast();
    const [sttProvider, setSttProvider] = useState<SttProvider>('local');
    const [modelStatus, setModelStatus] = useState<LocalModelStatus | null>(null);
    const [downloadingModel, setDownloadingModel] = useState(false);
    // Local engine: bundled Vietnamese Zipformer, or downloadable multilingual
    // Nemotron 3.5 (higher quality, punctuated, ~683MB).
    const [localEngine, setLocalEngine] = useState<'zipformer' | 'nemotron'>('zipformer');
    const [sonioxKey, setSonioxKey] = useState('');
    const [sonioxLangs, setSonioxLangs] = useState<Set<string>>(new Set(['vi']));
    // Primary language for the Local (offline) engine.
    const [sttLanguage, setSttLanguage] = useState('vi');
    const [llmKey, setLlmKey] = useState('');
    const [llmUrl, setLlmUrl] = useState('');
    const [llmModel, setLlmModel] = useState('');
    const [llmProvider, setLlmProvider] = useState('compatible');
    const [llmModelOptions, setLlmModelOptions] = useState<string[]>([]);
    const [fetchingModels, setFetchingModels] = useState(false);

    const [saving, setSaving] = useState(false);
    const [testRunning, setTestRunning] = useState(false);
    const [sttResult, setSttResult] = useState<{ok: boolean; msg: string} | null>(null);
    const [llmResult, setLlmResult] = useState<{ok: boolean; msg: string} | null>(null);
    const [showSonioxKey, setShowSonioxKey] = useState(false);
    const [showLlmKey, setShowLlmKey] = useState(false);
    const [appVersion, setAppVersion] = useState('');
    type SettingsTab = 'stt' | 'ai' | 'general';
    const [settingsTab, setSettingsTab] = useState<SettingsTab>('stt');
    const [closing, setClosing] = useState(false);
    const tabsBarRef = useRef<HTMLDivElement>(null);
    const [pillStyle, setPillStyle] = useState<{ left: number; width: number } | null>(null);

    const closePanel = () => {
        if (closing) return;
        setClosing(true);
        setTimeout(() => {
            setSettingsOpen(false);
        }, 350);
    };

    useEffect(() => {
        const bar = tabsBarRef.current;
        if (!bar) return;
        const activeBtn = bar.querySelector<HTMLElement>('.settings-tab.active');
        if (activeBtn) {
            setPillStyle({ left: activeBtn.offsetLeft, width: activeBtn.offsetWidth });
        }
    }, [settingsTab, lang]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') closePanel();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    });

    // Updater controls — read from the dedicated updater store so the Settings
    // panel can both kick a manual check and reflect the result inline.
    const {
        status: updaterStatus,
        available: updaterAvailable,
        autoCheck: updaterAutoCheck,
        setAutoCheck: setUpdaterAutoCheck,
        setModalOpen: setUpdateModalOpen,
        setSkippedVersion: setUpdaterSkippedVersion,
        skippedVersion: updaterSkippedVersion,
        error: updaterError,
    } = useUpdaterStore();

    useEffect(() => { loadSettings(); }, []);

    // Resolve app version once for the "Updates" section.
    useEffect(() => {
        if (window.__TAURI_INTERNALS__) {
            import('@tauri-apps/api/app')
                .then(({ getVersion }) => getVersion().then(setAppVersion).catch(() => {}))
                .catch(() => {});
        }
    }, []);

    const handleCheckUpdate = async () => {
        await checkForUpdates({ manual: true });
        // If an update was discovered, jump straight to the modal — the user
        // explicitly asked, so we shouldn't make them hunt for the banner.
        const s = useUpdaterStore.getState();
        if (s.available && s.status === 'available') {
            setUpdateModalOpen(true);
        }
    };

    const updateStatusLabel = (() => {
        if (updaterStatus === 'checking') {
            return { msg: lang === 'vi' ? 'Đang kiểm tra…' : 'Checking…', kind: '' };
        }
        if (updaterStatus === 'downloading') {
            return { msg: lang === 'vi' ? 'Đang tải bản cập nhật…' : 'Downloading update…', kind: '' };
        }
        if (updaterStatus === 'installing') {
            return { msg: lang === 'vi' ? 'Đang cài đặt…' : 'Installing…', kind: '' };
        }
        if (updaterStatus === 'ready') {
            return { msg: lang === 'vi' ? 'Đang khởi động lại…' : 'Relaunching…', kind: '' };
        }
        if (updaterStatus === 'up-to-date') {
            return { msg: lang === 'vi' ? '✓ Bạn đang dùng bản mới nhất' : "✓ You're on the latest version", kind: 'success' };
        }
        if (updaterStatus === 'available' && updaterAvailable) {
            return {
                msg: lang === 'vi'
                    ? `Có bản ${updaterAvailable.version} — bấm "Xem chi tiết" để cập nhật`
                    : `Version ${updaterAvailable.version} available — click "View details" to install`,
                kind: 'success' as const,
            };
        }
        if (updaterError) {
            return { msg: updaterError, kind: 'error' as const };
        }
        return null;
    })();

    const loadSettings = async () => {
        try {
            const s = await getSettings();
            // Migrate a stored provider onto a supported one ('nvidia' → 'soniox',
            // unknown → 'local'). The legacy nvidia_api_key is intentionally left
            // untouched in the DB — we just stop reading/showing it.
            setSttProvider(migrateProvider(s.stt_provider));
            if (s.soniox_api_key) setSonioxKey('••••••••');
            if (s.soniox_language_hints) {
                const hints = (s.soniox_language_hints as string).split(',').map((h: string) => h.trim()).filter(Boolean);
                if (hints.length > 0) setSonioxLangs(new Set(hints));
            }
            setSttLanguage(s.stt_language || 'vi');
            setLocalEngine(s.local_engine === 'nemotron' ? 'nemotron' : 'zipformer');
            if (s.llm_api_key) setLlmKey('••••••••');
            if (s.llm_base_url) setLlmUrl(s.llm_base_url);
            if (s.llm_model) setLlmModel(s.llm_model);
            if (s.llm_provider) setLlmProvider(s.llm_provider);

        } catch (e) {
            console.warn('[settings] Failed to load settings:', e);
        }
    };

    // Fetch the actual local model status when the Local tab is active; keep
    // polling while a download is in progress.
    useEffect(() => {
        if (sttProvider !== 'local') return;
        let active = true;
        const tick = async () => {
            try {
                const s = await getLocalModelStatus(localEngine);
                if (!active) return;
                setModelStatus(s);
                if (s.status === 'downloading') { setDownloadingModel(true); setTimeout(tick, 1000); }
                else setDownloadingModel(false);
            } catch { /* sidecar warming up */ }
        };
        tick();
        return () => { active = false; };
    }, [sttProvider, localEngine]);

    const handleDownloadModel = async () => {
        setDownloadingModel(true);
        try {
            const s = await downloadLocalModel(localEngine);
            setModelStatus(s);
            const poll = async () => {
                try {
                    const st = await getLocalModelStatus(localEngine);
                    setModelStatus(st);
                    if (st.status === 'downloading') setTimeout(poll, 1000);
                    else setDownloadingModel(false);
                } catch { setDownloadingModel(false); }
            };
            if (s.status === 'downloading') setTimeout(poll, 1000);
            else setDownloadingModel(false);
        } catch {
            setDownloadingModel(false);
        }
    };

    const handleSave = async () => {
        setSaving(true);
        try {
            await saveSettings(buildSettingsBody());
            // Notify other views (e.g. RecordingBar gates cabin translation by
            // the saved STT provider) that settings changed.
            window.dispatchEvent(new CustomEvent('scribble:settings-saved'));
        } catch (e) { console.warn('[settings] Save failed:', e); }
        setSaving(false);
        closePanel();
    };

    const buildSettingsBody = () => {
        const body: Record<string, unknown> = {};
        body.stt_provider = sttProvider;
        // NOTE: nvidia_api_key is deliberately never sent or cleared — the
        // stored value is preserved in the DB for data-preservation reasons.
        // Send key if changed (not masked placeholder). Empty string = clear key.
        if (!sonioxKey.includes('••')) body.soniox_api_key = sonioxKey;
        body.stt_language = sttLanguage;
        body.local_engine = localEngine;
        body.soniox_language_hints = Array.from(sonioxLangs).join(',');
        if (!llmKey.includes('•')) body.llm_api_key = llmKey;
        if (llmProvider === 'compatible') {
            body.llm_base_url = llmUrl;
        }
        body.llm_provider = llmProvider;
        body.llm_model = llmModel;
        return body;
    };

    const handleFetchModels = async () => {
        setFetchingModels(true);
        setLlmModelOptions([]); // clear cả model cũ trước khi fetch
        try {
            const result = await fetchLLMModels(llmProvider, llmKey, llmProvider === 'compatible' ? llmUrl : undefined);
            if (result.error) {
                // Model list giữ nguyên trạng thái rỗng (cũ đã xóa ở bước trên)
                const errMsg = result.error.includes('401')
                    ? (lang === 'vi' ? 'Mã API Key không hợp lệ (401 Unauthorized)' : 'Invalid API Key (401 Unauthorized)')
                    : result.error.includes('404') 
                        ? (lang === 'vi' ? 'Không tìm thấy endpoint (404)' : 'Endpoint not found (404)')
                        : (lang === 'vi' ? `Lỗi lấy model: ${result.error}` : `Fetch error: ${result.error}`);
                showToast(errMsg, 'error');
            } else if (result.models && result.models.length > 0) {
                setLlmModelOptions(result.models);
            } else {
                showToast(lang === 'vi' ? 'Không tìm thấy model nào' : 'No models found', 'warning');
            }
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            showToast(lang === 'vi' ? `Lỗi kết nối: ${msg}` : `Connection error: ${msg}`, 'error');
        }
        setFetchingModels(false);
    };

    const testAll = async () => {
        setTestRunning(true);
        setSttResult(null);
        setLlmResult(null);
        try {
            await saveSettings(buildSettingsBody());
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 15000);
            try {
                const r = await diagnose(lang, controller.signal);
                clearTimeout(timeout);
                // Offline: backend short-circuits both checks with the same
                // clean message. Surface it once as a toast so the user isn't
                // staring at two identical "no internet" rows.
                if (r.network?.online === false) {
                    const offlineMsg = lang === 'vi'
                        ? 'Không có kết nối mạng — kiểm tra Internet rồi thử lại'
                        : 'No internet connection — check your network and retry';
                    showToast(offlineMsg, 'error');
                }
                setSttResult({ ok: r.stt?.status === 'ok', msg: r.stt?.message || 'Error' });
                setLlmResult({ ok: r.llm?.status === 'ok', msg: r.llm?.message || 'Error' });
            } catch (e: unknown) {
                clearTimeout(timeout);
                const msg = (e instanceof DOMException && e.name === 'AbortError')
                    ? (lang === 'vi' ? 'Quá thời gian (15s)' : 'Timeout (15s)')
                    : (lang === 'vi' ? 'Không kết nối được' : 'Cannot connect');
                setSttResult({ ok: false, msg });
                setLlmResult({ ok: false, msg });
            }
        } catch (e) {
            console.warn('[settings] Test failed:', e);
            setSttResult({ ok: false, msg: 'Cannot save' });
            setLlmResult({ ok: false, msg: 'Cannot save' });
        }
        setTestRunning(false);
    };

    // Canonical list lives in src/lib/language-options.ts so UploadAudioModal
    // and any future selector stay in sync with the same labels + value set.
    const sttLanguages = STT_LANGUAGES;

    /** Soniox supports a far wider language set than the offline engine, so its
     *  hint picker keeps this extended list. */
    const sonioxLanguages = [
        { value: 'vi', label: 'Vietnamese' },
        { value: 'en', label: 'English' },
        { value: 'zh', label: 'Chinese' },
        { value: 'ja', label: 'Japanese' },
        { value: 'ko', label: 'Korean' },
        { value: 'fr', label: 'French' },
        { value: 'de', label: 'German' },
        { value: 'es', label: 'Spanish' },
        { value: 'it', label: 'Italian' },
        { value: 'pt', label: 'Portuguese' },
        { value: 'ru', label: 'Russian' },
        { value: 'th', label: 'Thai' },
        { value: 'hi', label: 'Hindi' },
        { value: 'ar', label: 'Arabic' },
        { value: 'tr', label: 'Turkish' },
        { value: 'nl', label: 'Dutch' },
        { value: 'pl', label: 'Polish' },
        { value: 'sv', label: 'Swedish' },
        { value: 'da', label: 'Danish' },
        { value: 'nb', label: 'Norwegian' },
        { value: 'fi', label: 'Finnish' },
        { value: 'cs', label: 'Czech' },
        { value: 'el', label: 'Greek' },
        { value: 'he', label: 'Hebrew' },
        { value: 'hu', label: 'Hungarian' },
        { value: 'ro', label: 'Romanian' },
        { value: 'uk', label: 'Ukrainian' },
        { value: 'bg', label: 'Bulgarian' },
        { value: 'hr', label: 'Croatian' },
        { value: 'sk', label: 'Slovak' },
        { value: 'id', label: 'Indonesian' },
        { value: 'ms', label: 'Malay' },
        { value: 'tl', label: 'Filipino' },
        { value: 'ca', label: 'Catalan' },
        { value: 'af', label: 'Afrikaans' },
        { value: 'sw', label: 'Swahili' },
    ];

    // The Soniox hint picker gets the wide set; the Local picker is filtered
    // down to whatever the bundled model actually supports.
    const langOptions = sonioxLanguages;

    // Local (nemotron MLX) is multilingual — offer the supported languages + Auto.
    const localLangOptions = [
        { value: 'auto', label: lang === 'vi' ? 'Tự động' : 'Auto-detect' },
        ...sttLanguages.filter(o => modelStatus?.supported_languages?.includes(o.value)),
    ];

    const currentApiKey = sonioxKey;
    const setCurrentApiKey = setSonioxKey;
    const signupUrl = 'console.soniox.com';
    const signupHref = 'https://console.soniox.com';

    const hasApiKey = currentApiKey.length > 0;
    const hasLlmKey = llmKey.length > 0;
    const hasLlmModel = llmModel.length > 0;
    // Model can only be picked once the prerequisite credential is present:
    // an API key for hosted providers, or a Base URL for the OpenAI-compatible
    // self-host case (key optional there). Without it, fetching models would
    // 401 — so the Model field is disabled until then.
    const canConfigureModel = llmProvider === 'compatible'
        ? llmUrl.trim().length > 0
        : hasLlmKey;

    const ConfigBadge = ({ ok, optional = false }: { ok: boolean; optional?: boolean }) => {
        if (ok) {
            return (
                <span className="config-status-badge configured">
                    {lang === 'vi' ? '✓ Đã cấu hình' : '✓ Configured'}
                </span>
            );
        }
        // Optional + unset → neutral "Tùy chọn", not an alarming warning.
        if (optional) {
            return (
                <span className="config-status-badge optional-unset">
                    {t('optional_label', lang)}
                </span>
            );
        }
        return (
            <span className="config-status-badge missing">
                {lang === 'vi' ? '⚠ Chưa cấu hình' : '⚠ Not set'}
            </span>
        );
    };

    // One connection-test result row: a colored status badge, the category
    // (Giọng nói / Trợ lý AI), then the message — left-aligned with real gaps
    // so nothing crowds the icon and long messages wrap cleanly.
    const renderTestRow = (label: string, result: { ok: boolean; msg: string }) => (
        <div className={`settings-test-result-row ${result.ok ? 'ok' : 'fail'}`}>
            <span className="settings-test-result-icon" aria-hidden>
                {result.ok ? (
                    <IconCheck size={12} strokeWidth={2.7} />
                ) : (
                    <IconClose size={12} strokeWidth={2.7} />
                )}
            </span>
            <span className="settings-test-result-label">{label}</span>
            <span className="settings-test-result-msg">{result.msg}</span>
        </div>
    );

    return (
        <div className={`settings-overlay${closing ? ' is-closing' : ''}`} onClick={closePanel}>
            <div className={`settings-panel${closing ? ' is-closing' : ''}`} onClick={(e) => e.stopPropagation()}>
                <div className="settings-panel-header">
                    <h2 className="settings-panel-title">
                        <IconSettings size={16} />
                        <span>{t('settings', lang)}</span>
                    </h2>
                    <button className="settings-close-btn" onClick={closePanel}>
                        <IconClose size={16} />
                    </button>
                </div>

                <div className="settings-panel-body tabbed">
                    {/* ── Top-level tabs: STT / AI / General (16-tabs-sliding.md) ── */}
                    <div
                        ref={tabsBarRef}
                        className={`settings-tabs${pillStyle ? ' has-pill' : ''}`}
                        role="tablist"
                        aria-label={lang === 'vi' ? 'Nhóm cài đặt' : 'Settings groups'}
                    >
                        {pillStyle && (
                            <span
                                className="settings-tabs-pill"
                                aria-hidden="true"
                                style={{
                                    transform: `translateX(${pillStyle.left}px)`,
                                    width: `${pillStyle.width}px`,
                                }}
                            />
                        )}
                        {([
                            { id: 'stt', label: lang === 'vi' ? 'Giọng nói' : 'Speech', icon: <IconMic size={15} /> },
                            { id: 'ai', label: lang === 'vi' ? 'Trợ lý AI' : 'AI Assistant', icon: <IconNib size={15} /> },
                            { id: 'general', label: lang === 'vi' ? 'Chung' : 'General', icon: <IconSettings size={15} /> },
                        ] as { id: SettingsTab; label: string; icon: ReactNode }[]).map((tab) => (
                            <button
                                key={tab.id}
                                role="tab"
                                aria-selected={settingsTab === tab.id}
                                className={`settings-tab${settingsTab === tab.id ? ' active' : ''}`}
                                onClick={() => setSettingsTab(tab.id)}
                            >
                                {tab.icon}
                                <span className="settings-tab-label">{tab.label}</span>
                            </button>
                        ))}
                    </div>

                    {settingsTab === 'stt' && (<>
                    {/* ── STT Section ── */}
                    <div className="settings-section">
                        <div className="settings-section-header">
                            <div className="settings-section-title">
                                <IconMic size={16} />
                                <span>{t('voice_recognition', lang)}</span>
                            </div>
                            <div className="settings-section-desc">{t('voice_recognition_desc', lang)}</div>
                        </div>

                        <div className="settings-section-body">

                        {/* Provider Selector — span full row, the tab pair is wide. */}
                        <div className="setting-group setting-group--full">
                            <div className="setting-label">{t('stt_provider', lang)}</div>
                            <div className="setting-provider-tabs">
                                <button
                                    className={`provider-tab${sttProvider === 'soniox' ? ' active' : ''}`}
                                    onClick={() => setSttProvider('soniox')}
                                >
                                    <strong>Soniox</strong>
                                    <span className="provider-tab-desc">{t('soniox_desc', lang)}</span>
                                </button>
                                <button
                                    className={`provider-tab${sttProvider === 'local' ? ' active' : ''}`}
                                    onClick={() => setSttProvider('local')}
                                >
                                    <strong>Local (offline)</strong>
                                    <span className="provider-tab-desc">{t('local_desc', lang)}</span>
                                </button>
                            </div>
                            {sttProvider === 'soniox' && (
                                <div className="setting-warning">
                                    <IconAlert size={14} />
                                    <span>{lang === 'vi'
                                        ? 'Soniox là dịch vụ trả phí (~$0.12/giờ). Phù hợp cho người dùng cần chất lượng nhận diện và dịch thuật tốt nhất.'
                                        : 'Soniox is a paid service (~$0.12/hr). Recommended for users who need the best recognition and translation quality.'
                                    }</span>
                                </div>
                            )}
                            {sttProvider === 'local' && (
                                <>
                                <div className="setting-group setting-group--full" style={{ marginTop: 8 }}>
                                    <div className="setting-label">{lang === 'vi' ? 'Model offline' : 'Offline model'}</div>
                                    <div className="setting-provider-tabs">
                                        <button
                                            type="button"
                                            className={`provider-tab${localEngine === 'zipformer' ? ' active' : ''}`}
                                            onClick={() => setLocalEngine('zipformer')}
                                        >
                                            <strong>Zipformer 30M</strong>
                                            <span className="provider-tab-desc">{lang === 'vi' ? 'Có sẵn • Tiếng Việt • Rất nhẹ' : 'Built-in • Vietnamese • Very light'}</span>
                                        </button>
                                        <button
                                            type="button"
                                            className={`provider-tab${localEngine === 'nemotron' ? ' active' : ''}`}
                                            onClick={() => setLocalEngine('nemotron')}
                                        >
                                            <strong>Nemotron 0.6B</strong>
                                            <span className="provider-tab-desc">{lang === 'vi' ? 'Chính xác hơn • Có dấu câu • Đa ngôn ngữ • Tải về khi chọn' : 'More accurate • Punctuated • Multilingual • Downloaded on demand'}</span>
                                        </button>
                                    </div>
                                </div>
                                <div className="setting-warning">
                                    <IconAlert size={14} />
                                    <span>{lang === 'vi'
                                        ? `Chạy hoàn toàn trên máy — miễn phí, không cần mạng, riêng tư. ${modelStatus?.multilingual ? 'Hỗ trợ nhiều ngôn ngữ (chọn bên dưới); ghi âm realtime và Upload file đều được.' : 'Chỉ hỗ trợ tiếng Việt; ghi âm realtime và Upload file đều được.'}`
                                        : `Runs entirely on your device — free, offline, private. ${modelStatus?.multilingual ? 'Many languages (pick below); works for both realtime recording and file upload.' : 'Vietnamese only; works for both realtime recording and file upload.'}`
                                    }</span>
                                </div>
                                {modelStatus && (
                                    <div className="setting-group setting-group--full" style={{ marginTop: 8 }}>
                                        {(modelStatus.status === 'downloading' || downloadingModel) ? (
                                            <>
                                                <div className="setting-label">{lang === 'vi' ? 'Đang tải model…' : 'Downloading model…'}</div>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                                    <progress value={modelStatus.progress ?? 0} max={1} style={{ flex: 1, height: 8 }} />
                                                    <span style={{ minWidth: 42, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                                                        {Math.round((modelStatus.progress ?? 0) * 100)}%
                                                    </span>
                                                </div>
                                            </>
                                        ) : (modelStatus.cached || modelStatus.status === 'done') ? (
                                            <div className="setting-label" style={{ color: '#16a34a' }}>
                                                ✓ {lang === 'vi' ? 'Sẵn sàng dùng offline' : 'Ready to use offline'}
                                            </div>
                                        ) : (
                                            <button
                                                type="button"
                                                onClick={handleDownloadModel}
                                                disabled={downloadingModel}
                                                className="settings-solid-btn"
                                            >
                                                {lang === 'vi' ? `Tải model offline (${modelStatus.size_mb}MB)` : `Download offline model (${modelStatus.size_mb}MB)`}
                                            </button>
                                        )}
                                        {modelStatus.status === 'error' && (
                                            <div className="setting-hint" style={{ color: '#dc2626' }}>
                                                {lang === 'vi' ? 'Tải lỗi — kiểm tra mạng và ' : 'Download failed — check network and '}
                                                <a onClick={handleDownloadModel} style={{ cursor: 'pointer', textDecoration: 'underline' }}>{lang === 'vi' ? 'thử lại' : 'retry'}</a>
                                            </div>
                                        )}
                                        <div className="setting-hint" style={{ opacity: 0.5, marginTop: 4 }}>
                                            {modelStatus.display_name} · {modelStatus.size_mb}MB
                                        </div>
                                    </div>
                                )}
                                {modelStatus?.multilingual && (
                                    <div className="setting-group setting-group--full" style={{ marginTop: 8 }}>
                                        <div className="setting-label">{lang === 'vi' ? 'Ngôn ngữ' : 'Language'}</div>
                                        <CustomSelect
                                            className="setting-lang-select"
                                            options={localLangOptions}
                                            value={sttLanguage}
                                            onChange={setSttLanguage}
                                        />
                                        <div className="setting-hint">{lang === 'vi' ? 'Chọn ngôn ngữ chính của audio (hoặc Tự động).' : "Pick the audio's main language (or Auto)."}</div>
                                    </div>
                                )}
                                </>
                            )}
                        </div>

                        {/* API Key — hidden for local (offline needs no key) */}
                        {sttProvider !== 'local' && (
                        <div className="setting-group setting-group--full">
                            <div className="setting-label">
                                API Key
                                <ConfigBadge ok={hasApiKey} />
                            </div>
                            <div className="setting-input-wrap">
                                <input
                                    type={showSonioxKey ? 'text' : 'password'}
                                    className="setting-input"
                                    value={currentApiKey}
                                    onChange={(e) => setCurrentApiKey(e.target.value)}
                                    placeholder="soniox-xxx"
                                />
                                <button
                                    type="button"
                                    className="setting-eye-btn"
                                    onClick={() => setShowSonioxKey(v => !v)}
                                    aria-label={lang === 'vi' ? 'Hiện/ẩn API key' : 'Show/hide key'}
                                >
                                    <span className="t-icon-swap" data-state={showSonioxKey ? 'b' : 'a'}>
                                        <span className="t-icon" data-icon="a"><IconEye size={14} /></span>
                                        <span className="t-icon" data-icon="b"><IconEyeOff size={14} /></span>
                                    </span>
                                </button>
                            </div>
                            <div className="setting-hint">{t('signup_free_at', lang)} <a href={signupHref} target="_blank" rel="noreferrer">{signupUrl}</a></div>
                        </div>
                        )}

                        {/* Language Selection — Soniox-only hint list (Local has
                            its own language selector above, next to the model). */}
                        {sttProvider === 'soniox' && (
                        <div className="setting-group">
                            <div className="setting-label">
                                {t('soniox_languages', lang)}
                            </div>
                            <CustomSelect
                                className="setting-lang-select"
                                options={langOptions}
                                value=""
                                onChange={() => {}}
                                multiple
                                selectedValues={sonioxLangs}
                                onToggle={(code) => {
                                    setSonioxLangs(prev => {
                                        const next = new Set(prev);
                                        if (next.has(code)) next.delete(code);
                                        else next.add(code);
                                        return next;
                                    });
                                }}
                            />
                            <div className="setting-hint">
                                {t('soniox_languages_hint', lang)}
                            </div>
                        </div>
                        )}
                        </div>
                    </div>
                    </>)}

                    {settingsTab === 'ai' && (<>
                    {/* ── LLM Section ── */}
                    <div className="settings-section">
                        <div className="settings-section-header">
                            <div className="settings-section-title">
                                <IconNib size={16} />
                                <span>{t('ai_section', lang)}</span>
                                <span className="settings-section-optional-pill">{t('optional_label', lang)}</span>
                            </div>
                            <div className="settings-section-desc">{t('ai_hint', lang)}</div>
                        </div>

                        <div className="settings-section-body">

                        {/* Provider Dropdown */}
                        <div className="setting-group">
                            <div className="setting-label" style={{ textTransform: 'uppercase' }}>{lang === 'vi' ? 'Nhà cung cấp' : 'Provider'}</div>
                            <CustomSelect
                                options={[
                                    { value: 'openai',     label: 'OpenAI' },
                                    { value: 'mistral',    label: 'Mistral AI' },
                                    { value: 'groq',       label: 'Groq' },
                                    { value: 'deepseek',   label: 'DeepSeek' },
                                    { value: 'openrouter', label: 'OpenRouter' },
                                    { value: 'gemini',     label: 'Google Gemini' },
                                    { value: 'compatible', label: lang === 'vi' ? 'Tương thích OpenAI' : 'OpenAI Compatible' },
                                ]}
                                value={llmProvider}
                                onChange={(val) => { setLlmProvider(val); setLlmModelOptions([]); }}
                            />
                        </div>

                        {/* API Key */}
                        <div className="setting-group setting-group--full">
                            <div className="setting-label">
                                API Key
                                <ConfigBadge ok={hasLlmKey} optional />
                            </div>
                            <div className="setting-input-wrap">
                                <input type={showLlmKey ? 'text' : 'password'} className="setting-input" value={llmKey} onChange={(e) => { setLlmKey(e.target.value); setLlmModelOptions([]); }} placeholder="sk-xxx" />
                                <button type="button" className="setting-eye-btn" onClick={() => setShowLlmKey(v => !v)} aria-label="toggle key">
                                    <span className="t-icon-swap" data-state={showLlmKey ? 'b' : 'a'}>
                                        <span className="t-icon" data-icon="a"><IconEye size={14} /></span>
                                        <span className="t-icon" data-icon="b"><IconEyeOff size={14} /></span>
                                    </span>
                                </button>
                            </div>
                        </div>

                        {/* Custom URL — only for compatible */}
                        {llmProvider === 'compatible' && (
                            <div className="setting-group setting-group--full">
                                <div className="setting-label" style={{ textTransform: 'uppercase' }}>Base URL</div>
                                <input type="text" className="setting-input" value={llmUrl} onChange={(e) => { setLlmUrl(e.target.value); setLlmModelOptions([]); }} placeholder="https://api.example.com/v1" />
                            </div>
                        )}

                        {/* Model — disabled until the credential exists; auto-fetches on open */}
                        <div className="setting-group">
                            <div className="setting-label" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', textTransform: 'uppercase' }}>
                                <span>Model <ConfigBadge ok={hasLlmModel && canConfigureModel} optional /></span>
                            </div>
                            <CustomSelect
                                options={fetchingModels
                                    ? [{ value: '', label: lang === 'vi' ? 'Đang tải...' : 'Loading...' }]
                                    : !canConfigureModel
                                        ? [{ value: '', label: llmProvider === 'compatible'
                                            ? (lang === 'vi' ? '-- Nhập Base URL trước --' : '-- Enter Base URL first --')
                                            : (lang === 'vi' ? '-- Nhập API Key trước --' : '-- Enter API Key first --') }]
                                        : (llmModelOptions.length > 0
                                            ? llmModelOptions.map(m => ({ value: m, label: m }))
                                            : (llmModel ? [{ value: llmModel, label: llmModel }] : [{ value: '', label: lang === 'vi' ? '-- Bấm để tải model --' : '-- Click to load --' }]))
                                }
                                value={fetchingModels ? '' : (canConfigureModel ? llmModel : '')}
                                onChange={setLlmModel}
                                disabled={fetchingModels || !canConfigureModel}
                                onOpen={() => {
                                    if (canConfigureModel && llmModelOptions.length === 0 && !fetchingModels) {
                                        handleFetchModels();
                                    }
                                }}
                            />
                            <div className="setting-hint" style={{ marginTop: '6px' }}>
                                {!canConfigureModel
                                    ? (llmProvider === 'compatible'
                                        ? (lang === 'vi' ? 'Nhập Base URL để chọn model' : 'Enter Base URL to pick a model')
                                        : (lang === 'vi' ? 'Nhập API Key để chọn model' : 'Enter API Key to pick a model'))
                                    : llmModelOptions.length > 0
                                        ? `${llmModelOptions.length} ${lang === 'vi' ? 'model khả dụng' : 'models available'}`
                                        : t('ai_model_hint', lang)}
                            </div>
                        </div>
                        </div>
                    </div>
                    </>)}

                    {settingsTab === 'general' && (<>
                    {/* ── Appearance ── */}
                    <div className="settings-section">
                        <div className="settings-section-header">
                            <div className="settings-section-title">
                                <span>{lang === 'vi' ? 'Giao diện' : 'Appearance'}</span>
                            </div>
                            <div className="settings-section-desc">
                                {lang === 'vi' ? 'Sáng, tối, hoặc theo hệ thống.' : 'Light, dark, or follow the system.'}
                            </div>
                        </div>
                        <div className="setting-provider-tabs">
                            {([
                                { id: 'light', label: lang === 'vi' ? 'Sáng' : 'Light', icon: <IconSun size={16} /> },
                                { id: 'dark', label: lang === 'vi' ? 'Tối' : 'Dark', icon: <IconMoon size={16} /> },
                                { id: 'system', label: lang === 'vi' ? 'Hệ thống' : 'System', icon: <IconSystem size={16} /> },
                            ] as const).map((opt) => (
                                <button
                                    key={opt.id}
                                    className={`provider-tab${theme === opt.id ? ' active' : ''}`}
                                    onClick={() => setTheme(opt.id)}
                                >
                                    {opt.icon}
                                    <strong>{opt.label}</strong>
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* ── Unified Test Connection (spans both grid cols) ── */}
                    <div className="settings-section settings-test-section span-full">
                        <div className="settings-test-head">
                            <span className="settings-test-label">
                                {lang === 'vi'
                                    ? 'Kiểm tra API key đã hoạt động chưa'
                                    : 'Verify your API keys'}
                            </span>
                            <button className="settings-test-btn" onClick={testAll} disabled={testRunning}>
                                {testRunning ? (
                                    <IconSpinner size={16} className="spin" strokeWidth={2.25} />
                                ) : (
                                    <IconCheckCircle size={16} />
                                )}
                                <span>{testRunning ? t('testing', lang) : t('test_all_connections', lang)}</span>
                            </button>
                        </div>
                        {(sttResult || llmResult) && (
                            <div className="settings-test-results">
                                {sttResult && renderTestRow(t('test_result_stt', lang), sttResult)}
                                {llmResult && renderTestRow(t('test_result_llm', lang), llmResult)}
                            </div>
                        )}
                    </div>

                    {/* ── Updates section (spans both grid cols) ──
                        Surfaces app version + manual "check for updates" so
                        the user isn't reliant on the 30-min auto-poll, and can
                        toggle the auto-poll off if they prefer staying pinned. */}
                    <div className="settings-section span-full">
                        <div className="settings-section-header">
                            <div className="settings-section-title">
                                <IconDownload size={16} />
                                <span>{lang === 'vi' ? 'Cập nhật ứng dụng' : 'App Updates'}</span>
                            </div>
                        </div>

                        <div className="settings-update-list">
                        <div className="settings-update-row">
                            <div>
                                <div className="label">
                                    {lang === 'vi' ? 'Phiên bản hiện tại' : 'Current version'}
                                </div>
                                <div className="sub">
                                    {appVersion ? `v${appVersion}` : (lang === 'vi' ? 'Không xác định' : 'Unknown')}
                                </div>
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                                <button
                                    className="settings-update-check-btn"
                                    onClick={handleCheckUpdate}
                                    disabled={updaterStatus === 'checking' || updaterStatus === 'downloading' || updaterStatus === 'installing' || updaterStatus === 'ready'}
                                >
                                    {updaterStatus === 'checking'
                                        ? (lang === 'vi' ? 'Đang kiểm tra…' : 'Checking…')
                                        : updaterStatus === 'downloading'
                                            ? (lang === 'vi' ? 'Đang tải…' : 'Downloading…')
                                            : updaterStatus === 'installing'
                                                ? (lang === 'vi' ? 'Đang cài đặt…' : 'Installing…')
                                                : updaterStatus === 'ready'
                                                    ? (lang === 'vi' ? 'Đang khởi động lại…' : 'Relaunching…')
                                                    : updaterStatus === 'available' && updaterAvailable
                                                        ? (lang === 'vi' ? 'Xem chi tiết' : 'View details')
                                                        : (lang === 'vi' ? 'Kiểm tra cập nhật' : 'Check for updates')}
                                </button>
                                {/* If we already have an update available, the
                                    button does double-duty: clicking opens the
                                    modal (handleCheckUpdate re-checks then
                                    opens). Otherwise it triggers a fresh check. */}
                                {updaterStatus === 'available' && updaterAvailable && (
                                    <button
                                        className="settings-update-check-btn"
                                        style={{ borderColor: 'var(--gray-300, #cbd5e1)', color: 'var(--text-secondary, #64748b)' }}
                                        onClick={() => setUpdateModalOpen(true)}
                                    >
                                        {lang === 'vi' ? 'Mở chi tiết' : 'Open details'}
                                    </button>
                                )}
                            </div>
                        </div>

                        {updateStatusLabel && (
                            <div className={`settings-update-status ${updateStatusLabel.kind}`}>
                                {updateStatusLabel.msg}
                            </div>
                        )}

                        <div className="settings-update-row">
                            <div>
                                <div className="label">
                                    {lang === 'vi' ? 'Tự động kiểm tra' : 'Auto-check'}
                                </div>
                                <div className="sub">
                                    {lang === 'vi'
                                        ? 'Kiểm tra khi mở app và mỗi 30 phút sau đó.'
                                        : 'Check at startup and every 30 minutes.'}
                                </div>
                            </div>
                            <label className="toggle" title={lang === 'vi' ? 'Bật/tắt tự động kiểm tra' : 'Toggle auto-check'}>
                                <input
                                    type="checkbox"
                                    checked={updaterAutoCheck}
                                    onChange={(e) => setUpdaterAutoCheck(e.target.checked)}
                                />
                                <span className="toggle-slider" />
                            </label>
                        </div>

                        {updaterSkippedVersion && (
                            <div className="settings-update-row">
                                <div>
                                    <div className="label">
                                        {lang === 'vi'
                                            ? `Đã bỏ qua bản ${updaterSkippedVersion}`
                                            : `Skipped version ${updaterSkippedVersion}`}
                                    </div>
                                    <div className="sub">
                                        {lang === 'vi'
                                            ? 'Bấm để xóa và nhận lại thông báo về bản này.'
                                            : 'Clear to receive notifications about this version again.'}
                                    </div>
                                </div>
                                <button
                                    className="settings-update-check-btn"
                                    onClick={() => setUpdaterSkippedVersion('')}
                                >
                                    {lang === 'vi' ? 'Xóa bỏ qua' : 'Clear skip'}
                                </button>
                            </div>
                        )}
                        </div>
                    </div>
                    </>) /* end general tab */}
                </div>

                <div className="settings-panel-footer">
                    <div className="settings-footer-actions">
                        <button className="action-btn primary" onClick={handleSave} disabled={saving}>
                            <IconCheck size={14} />
                            <span>{saving ? '...' : t('save_settings', lang)}</span>
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
