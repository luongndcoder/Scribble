import { useState, useEffect } from 'react';
import { useAppStore } from '../stores/appStore';
import { getSettings, saveSettings, diagnose } from '../lib/api';
import { t } from '../i18n';

export function SettingsPanel() {
    const { setSettingsOpen, lang } = useAppStore();
    const [nvidiaKey, setNvidiaKey] = useState('');
    const [sttLang, setSttLang] = useState('');
    const [llmKey, setLlmKey] = useState('');
    const [llmUrl, setLlmUrl] = useState('');
    const [llmModel, setLlmModel] = useState('');
    const [saving, setSaving] = useState(false);
    const [sttTest, setSttTest] = useState('');
    const [llmTest, setLlmTest] = useState('');

    useEffect(() => { loadSettings(); }, []);

    const loadSettings = async () => {
        try {
            const s = await getSettings();
            if (s.nvidia_api_key) setNvidiaKey('••••••••');
            setSttLang(s.stt_language || '');
            if (s.llm_api_key) setLlmKey('••••••••');
            if (s.llm_base_url) setLlmUrl(s.llm_base_url);
            if (s.llm_model) setLlmModel(s.llm_model);
        } catch { }
    };

    const handleSave = async () => {
        setSaving(true);
        const body: any = {};
        if (nvidiaKey && !nvidiaKey.includes('••')) body.nvidia_api_key = nvidiaKey;
        body.stt_language = sttLang;
        body.stt_backend = 'nvidia';
        if (llmKey && !llmKey.includes('••')) body.llm_api_key = llmKey;
        if (llmUrl) body.llm_base_url = llmUrl;
        if (llmModel) body.llm_model = llmModel;
        try { await saveSettings(body); } catch { }
        setSaving(false);
        setSettingsOpen(false);
    };

    const testStt = async () => {
        setSttTest(t('testing', lang));
        try {
            const r = await diagnose(lang);
            setSttTest(r.stt?.status === 'ok' ? '✅ ' + r.stt.message : '❌ ' + (r.stt?.message || 'Error'));
        } catch { setSttTest('❌ Cannot connect'); }
    };

    const testLlm = async () => {
        setLlmTest(t('testing', lang));
        try {
            const r = await diagnose(lang);
            setLlmTest(r.llm?.status === 'ok' ? '✅ ' + r.llm.message : '❌ ' + (r.llm?.message || 'Error'));
        } catch { setLlmTest('❌ Cannot connect'); }
    };

    return (
        <div className="settings-overlay">
            <div className="settings-panel">
                <div className="settings-panel-header">
                    <h2 className="settings-panel-title">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
                            <circle cx="12" cy="12" r="3" />
                        </svg>
                        <span>{t('settings', lang)}</span>
                    </h2>
                    <button className="settings-close-btn" onClick={() => setSettingsOpen(false)}>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M18 6 6 18" /><path d="m6 6 12 12" />
                        </svg>
                    </button>
                </div>

                <div className="settings-panel-body">
                    {/* STT Section — Nvidia Riva */}
                    <div className="settings-section">
                        <div className="settings-section-title">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                                <path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" x2="12" y1="19" y2="22" />
                            </svg>
                            <span>{t('voice_recognition', lang)}</span>
                        </div>
                        <div className="setting-hint" style={{ marginBottom: 8 }}>
                            {lang === 'vi' ? 'Sử dụng Nvidia Riva — nhận diện giọng nói realtime' : 'Powered by Nvidia Riva — real-time speech recognition'}
                        </div>
                        <div className="setting-group">
                            <div className="setting-label">{t('nvidia_access_key', lang)}</div>
                            <input type="password" className="setting-input" value={nvidiaKey} onChange={(e) => setNvidiaKey(e.target.value)} placeholder="nvapi-xxx" />
                            <div className="setting-hint">{t('signup_free_at', lang)} <a href="https://build.nvidia.com" target="_blank" rel="noreferrer">build.nvidia.com</a></div>
                        </div>

                        <div className="setting-group">
                            <div className="setting-label">{t('primary_language', lang)}</div>
                            <select className="setting-input setting-select" value={sttLang} onChange={(e) => setSttLang(e.target.value)}>
                                <option value="vi">Tiếng Việt</option>
                                <option value="en">English (US)</option>
                                <option value="zh">中文 (Chinese)</option>
                                <option value="ja">日本語 (Japanese)</option>
                                <option value="ko">한국어 (Korean)</option>
                                <option value="fr">Français</option>
                                <option value="de">Deutsch</option>
                                <option value="es">Español</option>
                                <option value="it">Italiano</option>
                                <option value="pt">Português (Brazil)</option>
                                <option value="ru">Русский</option>
                                <option value="th">ภาษาไทย</option>
                                <option value="tr">Türkçe</option>
                                <option value="hi">हिन्दी (Hindi)</option>
                                <option value="ar">العربية (Arabic)</option>
                                <option value="nl">Nederlands</option>
                                <option value="pl">Polski</option>
                                <option value="sv">Svenska</option>
                                <option value="da">Dansk</option>
                                <option value="nb">Norsk Bokmål</option>
                                <option value="cs">Čeština</option>
                                <option value="he">עברית (Hebrew)</option>
                            </select>
                            <div className="setting-hint">{t('language_hint', lang)}</div>
                        </div>

                        <div className="setting-group">
                            <button className="action-btn" onClick={testStt} style={{ width: '100%' }}>
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
                                </svg>
                                <span>{t('test_connection', lang)}</span>
                            </button>
                            {sttTest && <div className="setting-hint">{sttTest}</div>}
                        </div>
                    </div>

                    {/* LLM Section */}
                    <div className="settings-section">
                        <div className="settings-section-title">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="m12 3-1.9 5.8a2 2 0 0 1-1.287 1.288L3 12l5.8 1.9a2 2 0 0 1 1.288 1.287L12 21l1.9-5.8a2 2 0 0 1 1.287-1.288L21 12l-5.8-1.9a2 2 0 0 1-1.288-1.287Z" />
                            </svg>
                            <span>{t('ai_section', lang)}</span>
                        </div>
                        <div className="setting-hint">{t('ai_hint', lang)}</div>
                        <div className="setting-group">
                            <div className="setting-label">{t('ai_access_key', lang)}</div>
                            <input type="password" className="setting-input" value={llmKey} onChange={(e) => setLlmKey(e.target.value)} placeholder="sk-xxx" />
                        </div>
                        <div className="setting-group">
                            <div className="setting-label">{t('ai_base_url', lang)}</div>
                            <input type="text" className="setting-input" value={llmUrl} onChange={(e) => setLlmUrl(e.target.value)} placeholder="https://api.openai.com/v1" />
                            <div className="setting-hint">{t('ai_url_hint', lang)}</div>
                        </div>
                        <div className="setting-group">
                            <div className="setting-label">{t('ai_model', lang)}</div>
                            <input type="text" className="setting-input" value={llmModel} onChange={(e) => setLlmModel(e.target.value)} placeholder="gpt-4o" />
                            <div className="setting-hint">{t('ai_model_hint', lang)}</div>
                        </div>
                        <div className="setting-group">
                            <button className="action-btn" onClick={testLlm} style={{ width: '100%' }}>
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
                                </svg>
                                <span>{t('test_connection', lang)}</span>
                            </button>
                            {llmTest && <div className="setting-hint">{llmTest}</div>}
                        </div>
                    </div>
                </div>

                <div className="settings-panel-footer">
                    <div className="settings-footer-actions">
                        <button className="action-btn" onClick={() => setSettingsOpen(false)}>{t('cancel', lang)}</button>
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
