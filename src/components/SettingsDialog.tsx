import { useState, useEffect } from 'react';
import { useAppStore } from '../stores/appStore';
import { getSettings, saveSettings, diagnose } from '../lib/api';

export function SettingsDialog() {
    const { setSettingsOpen } = useAppStore();
    const [groqKey, setGroqKey] = useState('');
    const [llmKey, setLlmKey] = useState('');
    const [llmUrl, setLlmUrl] = useState('');
    const [llmModel, setLlmModel] = useState('');

    const [saving, setSaving] = useState(false);
    const [diagResult, setDiagResult] = useState<any>(null);

    useEffect(() => {
        loadSettings();
    }, []);

    const loadSettings = async () => {
        try {
            const s = await getSettings();
            if (s.groq_api_key) setGroqKey('••••••••');
            if (s.llm_api_key) setLlmKey('••••••••');
            if (s.llm_base_url) setLlmUrl(s.llm_base_url);
            if (s.llm_model) setLlmModel(s.llm_model);

        } catch { }
    };

    const handleSave = async () => {
        setSaving(true);
        try {
            const body: any = {};
            if (groqKey && !groqKey.includes('••')) body.groq_api_key = groqKey;
            if (llmKey && !llmKey.includes('••')) body.llm_api_key = llmKey;
            if (llmUrl) body.llm_base_url = llmUrl;
            if (llmModel) body.llm_model = llmModel;

            await saveSettings(body);
        } catch (err) {
            console.error('Save error:', err);
        }
        setSaving(false);
    };

    const runDiagnose = async () => {
        try {
            const r = await diagnose('vi');
            setDiagResult(r);
        } catch {
            setDiagResult({ stt: { status: 'error', message: 'Cannot connect' }, llm: { status: 'error', message: 'Cannot connect' } });
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
            <div className="glass rounded-2xl w-full max-w-lg max-h-[85vh] overflow-y-auto p-6 space-y-5 m-4">
                <div className="flex items-center justify-between">
                    <h2 className="text-lg font-bold text-text">⚙️ Settings</h2>
                    <button
                        onClick={() => setSettingsOpen(false)}
                        className="p-1 rounded-lg hover:bg-bg-elevated transition-colors cursor-pointer text-text-secondary"
                    >
                        ✕
                    </button>
                </div>

                {/* STT Section */}
                <section className="space-y-3">
                    <h3 className="text-sm font-semibold text-primary">🎤 Speech-to-Text (Groq)</h3>
                    <div>
                        <label className="text-xs text-text-secondary block mb-1">Groq API Key</label>
                        <input
                            type="password"
                            value={groqKey}
                            onChange={(e) => setGroqKey(e.target.value)}
                            placeholder="gsk_xxx..."
                            className="w-full bg-bg-elevated rounded-lg px-3 py-2 text-sm text-text border border-border focus:border-primary outline-none"
                        />
                    </div>
                </section>

                {/* Diarization Info */}
                <section className="space-y-2">
                    <h3 className="text-sm font-semibold text-success">👥 Speaker Diarization</h3>
                    <div className="bg-success/10 rounded-lg p-3 text-xs text-success">
                        ✅ ECAPA-TDNN (SpeechBrain) — No API key needed. Model downloads automatically (~80MB on first use).
                    </div>
                </section>

                {/* LLM Section */}
                <section className="space-y-3">
                    <h3 className="text-sm font-semibold text-warning">🧠 LLM (Translation & Summary)</h3>
                    <div>
                        <label className="text-xs text-text-secondary block mb-1">API Key</label>
                        <input
                            type="password"
                            value={llmKey}
                            onChange={(e) => setLlmKey(e.target.value)}
                            placeholder="sk-xxx..."
                            className="w-full bg-bg-elevated rounded-lg px-3 py-2 text-sm text-text border border-border focus:border-primary outline-none"
                        />
                    </div>
                    <div>
                        <label className="text-xs text-text-secondary block mb-1">Base URL</label>
                        <input
                            value={llmUrl}
                            onChange={(e) => setLlmUrl(e.target.value)}
                            placeholder="https://api.openai.com/v1"
                            className="w-full bg-bg-elevated rounded-lg px-3 py-2 text-sm text-text border border-border focus:border-primary outline-none"
                        />
                    </div>
                    <div>
                        <label className="text-xs text-text-secondary block mb-1">Model</label>
                        <input
                            value={llmModel}
                            onChange={(e) => setLlmModel(e.target.value)}
                            placeholder="gpt-4o-mini"
                            className="w-full bg-bg-elevated rounded-lg px-3 py-2 text-sm text-text border border-border focus:border-primary outline-none"
                        />
                    </div>
                </section>

                {/* Diagnostics */}
                <section className="space-y-3">
                    <button
                        onClick={runDiagnose}
                        className="w-full py-2 rounded-lg bg-bg-elevated text-text-secondary hover:text-text text-sm transition-colors cursor-pointer"
                    >
                        🔍 Run Diagnostics
                    </button>
                    {diagResult && (
                        <div className="bg-bg rounded-lg p-3 space-y-1 text-xs">
                            <div className="flex items-center gap-2">
                                <span className={diagResult.stt?.status === 'ok' ? 'text-success' : 'text-danger'}>
                                    {diagResult.stt?.status === 'ok' ? '✅' : '❌'}
                                </span>
                                <span>STT: {diagResult.stt?.message}</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <span className={diagResult.llm?.status === 'ok' ? 'text-success' : 'text-danger'}>
                                    {diagResult.llm?.status === 'ok' ? '✅' : '❌'}
                                </span>
                                <span>LLM: {diagResult.llm?.message}</span>
                            </div>
                        </div>
                    )}
                </section>

                {/* Save */}
                <button
                    onClick={handleSave}
                    disabled={saving}
                    className="w-full py-3 rounded-xl bg-primary hover:bg-primary-hover text-white font-semibold transition-colors cursor-pointer disabled:opacity-50"
                >
                    {saving ? 'Saving...' : '💾 Save Settings'}
                </button>
            </div>
        </div>
    );
}
