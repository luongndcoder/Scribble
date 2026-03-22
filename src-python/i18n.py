"""Centralized translations for VoiceScribe backend."""

TRANSLATIONS = {
    "vi": {
        # ── Diagnose ──
        "nvidia_connected": "Nvidia Riva đã kết nối thành công",
        "nvidia_key_missing": "Chưa nhập mã truy cập Nvidia",
        "nvidia_connect_fail": "Không thể kết nối Nvidia",
        "soniox_connected": "Soniox đã kết nối thành công",
        "soniox_key_missing": "Chưa nhập mã truy cập Soniox",
        "soniox_connect_fail": "Không thể kết nối Soniox",
        "groq_connected": "Groq Whisper đã kết nối thành công",
        "groq_key_missing": "Chưa nhập mã truy cập Groq",
        "groq_key_invalid": "Mã truy cập Groq không hợp lệ",
        "groq_connect_fail": "Không thể kết nối đến Groq",
        "llm_connected": "Trợ lý AI đã kết nối thành công",
        "llm_key_missing": "Chưa nhập mã truy cập AI",
        "llm_key_invalid": "Mã truy cập AI không hợp lệ",
        "llm_connect_fail": "Không thể kết nối đến dịch vụ AI",

        # ── Startup logs ──
        "starting": "VoiceScribe dang khoi dong...",
        "shutting_down": "VoiceScribe dang tat",
        "diarizer_loaded": "[OK] Mo hinh phan biet giong noi da san sang",
        "diarizer_fail": "[WARN] Khong the tai mo hinh phan biet giong noi",
        "riva_connected": "[OK] Da ket noi Nvidia Riva",
        "riva_warmup_fail": "[WARN] Khong the ket noi Nvidia Riva",

        # ── Errors ──
        "nvidia_key_not_set": "Chưa cấu hình mã truy cập Nvidia",
    },
    "en": {
        # ── Diagnose ──
        "nvidia_connected": "Nvidia Riva connected successfully",
        "nvidia_key_missing": "Nvidia access key not set",
        "nvidia_connect_fail": "Cannot connect to Nvidia",
        "soniox_connected": "Soniox connected successfully",
        "soniox_key_missing": "Soniox access key not set",
        "soniox_connect_fail": "Cannot connect to Soniox",
        "groq_connected": "Groq Whisper connected successfully",
        "groq_key_missing": "Groq access key not set",
        "groq_key_invalid": "Invalid Groq access key",
        "groq_connect_fail": "Cannot connect to Groq",
        "llm_connected": "AI assistant connected successfully",
        "llm_key_missing": "AI access key not set",
        "llm_key_invalid": "Invalid AI access key",
        "llm_connect_fail": "Cannot connect to AI service",

        # ── Startup logs ──
        "starting": "VoiceScribe starting...",
        "shutting_down": "VoiceScribe shutting down",
        "diarizer_loaded": "[OK] Speaker diarization model loaded",
        "diarizer_fail": "[WARN] Failed to load diarization model",
        "riva_connected": "[OK] Nvidia Riva client connected",
        "riva_warmup_fail": "[WARN] Nvidia Riva warmup failed",

        # ── Errors ──
        "nvidia_key_not_set": "Nvidia API key not configured",
    },
}


def t(key: str, lang: str = "vi") -> str:
    """Get translated string by key and language."""
    strings = TRANSLATIONS.get(lang, TRANSLATIONS["en"])
    return strings.get(key, TRANSLATIONS["en"].get(key, key))
