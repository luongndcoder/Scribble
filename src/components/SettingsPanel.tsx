import { useState, useEffect } from 'react';
import { useAppStore } from '../stores/appStore';
import { getSettings, saveSettings, diagnose, fetchLLMModels } from '../lib/api';
import { NVIDIA_STT_LANGUAGES } from '../lib/language-options';
import { t } from '../i18n';
import { CustomSelect } from './CustomSelect';
import { useToast } from './Toast';

export function SettingsPanel() {
    const { setSettingsOpen, lang } = useAppStore();
    const { showToast } = useToast();
    const [sttProvider, setSttProvider] = useState<'nvidia' | 'soniox'>('nvidia');
    const [nvidiaKey, setNvidiaKey] = useState('');
    const [sonioxKey, setSonioxKey] = useState('');
    const [sonioxLangs, setSonioxLangs] = useState<Set<string>>(new Set(['vi']));
    const [nvidiaLang, setNvidiaLang] = useState('vi');
    const [llmKey, setLlmKey] = useState('');
    const [llmUrl, setLlmUrl] = useState('');
    const [llmModel, setLlmModel] = useState('');
    const [llmProvider, setLlmProvider] = useState('compatible');
    const [llmModelOptions, setLlmModelOptions] = useState<string[]>([]);
    const [fetchingModels, setFetchingModels] = useState(false);

    const [maxSpeakers, setMaxSpeakers] = useState(4);
    const [saving, setSaving] = useState(false);
    const [testRunning, setTestRunning] = useState(false);
    const [sttResult, setSttResult] = useState<{ok: boolean; msg: string} | null>(null);
    const [llmResult, setLlmResult] = useState<{ok: boolean; msg: string} | null>(null);
    const [showNvidiaKey, setShowNvidiaKey] = useState(false);
    const [showSonioxKey, setShowSonioxKey] = useState(false);
    const [showLlmKey, setShowLlmKey] = useState(false);

    useEffect(() => { loadSettings(); }, []);

    const loadSettings = async () => {
        try {
            const s = await getSettings();
            setSttProvider((s.stt_provider as 'nvidia' | 'soniox') || 'nvidia');
            if (s.nvidia_api_key) setNvidiaKey('••••••••');
            if (s.soniox_api_key) setSonioxKey('••••••••');
            if (s.soniox_language_hints) {
                const hints = (s.soniox_language_hints as string).split(',').map((h: string) => h.trim()).filter(Boolean);
                if (hints.length > 0) setSonioxLangs(new Set(hints));
            }
            setNvidiaLang(s.stt_language || 'vi');
            if (s.max_speakers) setMaxSpeakers(parseInt(s.max_speakers) || 4);
            if (s.llm_api_key) setLlmKey('••••••••');
            if (s.llm_base_url) setLlmUrl(s.llm_base_url);
            if (s.llm_model) setLlmModel(s.llm_model);
            if (s.llm_provider) setLlmProvider(s.llm_provider);

        } catch (e) {
            console.warn('[settings] Failed to load settings:', e);
        }
    };

    const handleSave = async () => {
        setSaving(true);
        try { await saveSettings(buildSettingsBody()); } catch (e) { console.warn('[settings] Save failed:', e); }
        setSaving(false);
        setSettingsOpen(false);
    };

    const buildSettingsBody = () => {
        const body: Record<string, unknown> = {};
        body.stt_provider = sttProvider;
        // Send key if changed (not masked placeholder). Empty string = clear key.
        if (!nvidiaKey.includes('••')) body.nvidia_api_key = nvidiaKey;
        if (!sonioxKey.includes('••')) body.soniox_api_key = sonioxKey;
        body.stt_language = nvidiaLang;
        body.soniox_language_hints = Array.from(sonioxLangs).join(',');
        body.max_speakers = maxSpeakers;
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
                setSttResult({ ok: r.stt?.status === 'ok', msg: r.stt?.message || 'Error' });
                setLlmResult({ ok: r.llm?.status === 'ok', msg: r.llm?.message || 'Error' });
            } catch (e: unknown) {
                clearTimeout(timeout);
                const msg = (e instanceof DOMException && e.name === 'AbortError') ? 'Timeout (15s)' : 'Cannot connect';
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
    const nvidiaLanguages = NVIDIA_STT_LANGUAGES;

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

    const langOptions = sttProvider === 'nvidia' ? nvidiaLanguages : sonioxLanguages;

    const currentApiKey = sttProvider === 'nvidia' ? nvidiaKey : sonioxKey;
    const setCurrentApiKey = sttProvider === 'nvidia' ? setNvidiaKey : setSonioxKey;
    const signupUrl = sttProvider === 'nvidia' ? 'build.nvidia.com' : 'console.soniox.com';
    const signupHref = sttProvider === 'nvidia' ? 'https://build.nvidia.com' : 'https://console.soniox.com';

    const hasApiKey = currentApiKey.length > 0;
    const hasLlmKey = llmKey.length > 0;
    const hasLlmModel = llmModel.length > 0;

    const ConfigBadge = ({ ok }: { ok: boolean }) => (
        <span className={`config-status-badge ${ok ? 'configured' : 'missing'}`}>
            {ok
                ? (lang === 'vi' ? '✓ Đã cấu hình' : '✓ Configured')
                : (lang === 'vi' ? '⚠ Chưa cấu hình' : '⚠ Not set')}
        </span>
    );

    return (
        <div className="settings-overlay">
            <div className="settings-panel">
                <div className="settings-panel-header">
                    <h2 className="settings-panel-title">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
                            <circle cx="12" cy="12" r="3" />
                        </svg>
                        <span>{t('settings', lang)}</span>
                    </h2>
                    <button className="settings-close-btn" onClick={() => setSettingsOpen(false)}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M18 6 6 18" /><path d="m6 6 12 12" />
                        </svg>
                    </button>
                </div>

                <div className="settings-panel-body">
                    {/* ── STT Section ── */}
                    <div className="settings-section">
                        <div className="settings-section-header">
                            <div className="settings-section-title">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                                    <path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" x2="12" y1="19" y2="22" />
                                </svg>
                                <span>{t('voice_recognition', lang)}</span>
                            </div>
                            <div className="settings-section-desc">{t('voice_recognition_desc', lang)}</div>
                        </div>

                        {/* Provider Selector — span full row, the tab pair is wide. */}
                        <div className="setting-group setting-group--full">
                            <div className="setting-label">{t('stt_provider', lang)}</div>
                            <div className="setting-provider-tabs">
                                <button
                                    className={`provider-tab${sttProvider === 'nvidia' ? ' active' : ''}`}
                                    onClick={() => setSttProvider('nvidia')}
                                >
                                    <strong>Nvidia Riva</strong>
                                    <span className="provider-tab-desc">{t('nvidia_desc', lang)}</span>
                                </button>
                                <button
                                    className={`provider-tab${sttProvider === 'soniox' ? ' active' : ''}`}
                                    onClick={() => setSttProvider('soniox')}
                                >
                                    <strong>Soniox</strong>
                                    <span className="provider-tab-desc">{t('soniox_desc', lang)}</span>
                                </button>
                            </div>
                            {sttProvider === 'soniox' && (
                                <div className="setting-warning">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <circle cx="12" cy="12" r="10" /><line x1="12" x2="12" y1="8" y2="12" /><line x1="12" x2="12.01" y1="16" y2="16" />
                                    </svg>
                                    <span>{lang === 'vi'
                                        ? 'Soniox là dịch vụ trả phí (~$0.12/giờ). Phù hợp cho người dùng cần chất lượng nhận diện và dịch thuật tốt nhất.'
                                        : 'Soniox is a paid service (~$0.12/hr). Recommended for users who need the best recognition and translation quality.'
                                    }</span>
                                </div>
                            )}
                        </div>

                        {/* API Key — span full so the long input row breathes */}
                        <div className="setting-group setting-group--full">
                            <div className="setting-label">
                                API Key
                                <ConfigBadge ok={hasApiKey} />
                            </div>
                            <div className="setting-input-wrap">
                                <input
                                    type={sttProvider === 'nvidia' ? (showNvidiaKey ? 'text' : 'password') : (showSonioxKey ? 'text' : 'password')}
                                    className="setting-input"
                                    value={currentApiKey}
                                    onChange={(e) => setCurrentApiKey(e.target.value)}
                                    placeholder={sttProvider === 'nvidia' ? 'nvapi-xxx' : 'soniox-xxx'}
                                />
                                <button
                                    type="button"
                                    className="setting-eye-btn"
                                    onClick={() => sttProvider === 'nvidia' ? setShowNvidiaKey(v => !v) : setShowSonioxKey(v => !v)}
                                    aria-label={lang === 'vi' ? 'Hiện/ẩn API key' : 'Show/hide key'}
                                >
                                    {(sttProvider === 'nvidia' ? showNvidiaKey : showSonioxKey) ? (
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" x2="23" y1="1" y2="23"/></svg>
                                    ) : (
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                                    )}
                                </button>
                            </div>
                            <div className="setting-hint">{t('signup_free_at', lang)} <a href={signupHref} target="_blank" rel="noreferrer">{signupUrl}</a></div>
                        </div>

                        {/* Language Selection — dropdown */}
                        <div className="setting-group">
                            <div className="setting-label">
                                {t(sttProvider === 'soniox' ? 'soniox_languages' : 'primary_language', lang)}
                            </div>
                            {sttProvider === 'nvidia' ? (
                                <CustomSelect
                                    className="setting-lang-select"
                                    options={langOptions}
                                    value={nvidiaLang}
                                    onChange={setNvidiaLang}
                                />
                            ) : (
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
                            )}
                            <div className="setting-hint">
                                {sttProvider === 'nvidia'
                                    ? t('language_hint', lang)
                                    : t('soniox_languages_hint', lang)}
                            </div>
                        </div>

                        {/* Max Speakers — only for Nvidia (Soniox has built-in diarization) */}
                        {sttProvider === 'nvidia' && <div className="setting-group setting-group--full">
                            <div className="setting-label">
                                {lang === 'vi' ? 'Số người nói tối đa' : 'Max Speakers'}
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                <input
                                    type="range"
                                    min={2}
                                    max={12}
                                    value={maxSpeakers}
                                    onChange={(e) => setMaxSpeakers(parseInt(e.target.value))}
                                    style={{ flex: 1 }}
                                />
                                <span style={{ minWidth: '24px', textAlign: 'center', fontWeight: 600 }}>{maxSpeakers}</span>
                            </div>
                            <div className="setting-hint">
                                {lang === 'vi'
                                    ? 'Giới hạn số người nói nhận diện được trong 1 cuộc họp'
                                    : 'Maximum number of speakers to detect per meeting'}
                            </div>
                        </div>}
                    </div>

                    {/* ── LLM Section ── */}
                    <div className="settings-section">
                        <div className="settings-section-header">
                            <div className="settings-section-title">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.8 1.9a2 2 0 0 1 1.288 1.287L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.8-1.9a2 2 0 0 1-1.288-1.287Z" />
                                </svg>
                                <span>{t('ai_section', lang)}</span>
                            </div>
                            <div className="settings-section-desc">{t('ai_hint', lang)}</div>
                        </div>

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
                                <ConfigBadge ok={hasLlmKey} />
                            </div>
                            <div className="setting-input-wrap">
                                <input type={showLlmKey ? 'text' : 'password'} className="setting-input" value={llmKey} onChange={(e) => { setLlmKey(e.target.value); setLlmModelOptions([]); }} placeholder="sk-xxx" />
                                <button type="button" className="setting-eye-btn" onClick={() => setShowLlmKey(v => !v)} aria-label="toggle key">
                                    {showLlmKey ? (
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" x2="23" y1="1" y2="23"/></svg>
                                    ) : (
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                                    )}
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

                        {/* Model — auto fetch on click */}
                        <div className="setting-group">
                            <div className="setting-label" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', textTransform: 'uppercase' }}>
                                <span>Model <ConfigBadge ok={hasLlmModel} /></span>
                            </div>
                            <CustomSelect
                                options={fetchingModels
                                    ? [{ value: '', label: lang === 'vi' ? 'Đang tải...' : 'Loading...' }]
                                    : (llmModelOptions.length > 0
                                        ? llmModelOptions.map(m => ({ value: m, label: m }))
                                        : (llmModel ? [{ value: llmModel, label: llmModel }] : [{ value: '', label: lang === 'vi' ? '-- Bấm để tải model --' : '-- Click to load --' }]))
                                }
                                value={fetchingModels ? '' : llmModel}
                                onChange={setLlmModel}
                                disabled={fetchingModels}
                                onOpen={() => {
                                    if (llmModelOptions.length === 0 && !fetchingModels) {
                                        handleFetchModels();
                                    }
                                }}
                            />
                            <div className="setting-hint" style={{ marginTop: '6px' }}>
                                {llmModelOptions.length > 0
                                    ? `${llmModelOptions.length} ${lang === 'vi' ? 'model khả dụng' : 'models available'}`
                                    : t('ai_model_hint', lang)}
                            </div>
                        </div>
                    </div>


                    {/* ── Unified Test Connection (spans both grid cols) ── */}
                    <div className="settings-section settings-test-section span-full">
                        <button className="settings-test-btn" onClick={testAll} disabled={testRunning}>
                            {testRunning ? (
                                <svg className="spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                                </svg>
                            ) : (
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
                                </svg>
                            )}
                            <span>{testRunning ? t('testing', lang) : t('test_all_connections', lang)}</span>
                        </button>
                        {(sttResult || llmResult) && (
                            <div className="settings-test-results">
                                {sttResult && (
                                    <div className="settings-test-result-row">
                                        <span className="settings-test-result-label">{t('test_result_stt', lang)}</span>
                                        <span className={`settings-test-result-value ${sttResult.ok ? 'ok' : 'fail'}`}>
                                            {sttResult.ok
                                                ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
                                                : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                                            }
                                            {sttResult.msg}
                                        </span>
                                    </div>
                                )}
                                {llmResult && (
                                    <div className="settings-test-result-row">
                                        <span className="settings-test-result-label">{t('test_result_llm', lang)}</span>
                                        <span className={`settings-test-result-value ${llmResult.ok ? 'ok' : 'fail'}`}>
                                            {llmResult.ok
                                                ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
                                                : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
                                            }
                                            {llmResult.msg}
                                        </span>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </div>

                <div className="settings-panel-footer">
                    <div className="settings-footer-actions">
                        <button className="action-btn primary" onClick={handleSave} disabled={saving}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M20 6 9 17l-5-5" />
                            </svg>
                            <span>{saving ? '...' : t('save_settings', lang)}</span>
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
