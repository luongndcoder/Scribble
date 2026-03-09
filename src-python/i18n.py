"""Centralized translations for VoiceScribe backend."""

TRANSLATIONS = {
    "vi": {
        # ── Diagnose ──
        "nvidia_connected": "Nvidia Riva đã kết nối thành công",
        "nvidia_key_missing": "Chưa nhập mã truy cập Nvidia",
        "nvidia_connect_fail": "Không thể kết nối Nvidia",
        "groq_connected": "Groq Whisper đã kết nối thành công",
        "groq_key_missing": "Chưa nhập mã truy cập Groq",
        "groq_key_invalid": "Mã truy cập Groq không hợp lệ",
        "groq_connect_fail": "Không thể kết nối đến Groq",
        "llm_connected": "Trợ lý AI đã kết nối thành công",
        "llm_key_missing": "Chưa nhập mã truy cập AI",
        "llm_key_invalid": "Mã truy cập AI không hợp lệ",
        "llm_connect_fail": "Không thể kết nối đến dịch vụ AI",

        # ── Startup logs ──
        "starting": "🚀 VoiceScribe đang khởi động...",
        "shutting_down": "👋 VoiceScribe đang tắt",
        "diarizer_loaded": "✅ Mô hình phân biệt giọng nói đã sẵn sàng",
        "diarizer_fail": "⚠️ Không thể tải mô hình phân biệt giọng nói",
        "riva_connected": "✅ Đã kết nối Nvidia Riva",
        "riva_warmup_fail": "⚠️ Không thể kết nối Nvidia Riva",

        # ── Errors ──
        "nvidia_key_not_set": "Chưa cấu hình mã truy cập Nvidia",
    },
    "en": {
        # ── Diagnose ──
        "nvidia_connected": "Nvidia Riva connected successfully",
        "nvidia_key_missing": "Nvidia access key not set",
        "nvidia_connect_fail": "Cannot connect to Nvidia",
        "groq_connected": "Groq Whisper connected successfully",
        "groq_key_missing": "Groq access key not set",
        "groq_key_invalid": "Invalid Groq access key",
        "groq_connect_fail": "Cannot connect to Groq",
        "llm_connected": "AI assistant connected successfully",
        "llm_key_missing": "AI access key not set",
        "llm_key_invalid": "Invalid AI access key",
        "llm_connect_fail": "Cannot connect to AI service",

        # ── Startup logs ──
        "starting": "🚀 VoiceScribe starting...",
        "shutting_down": "👋 VoiceScribe shutting down",
        "diarizer_loaded": "✅ Speaker diarization model loaded",
        "diarizer_fail": "⚠️ Failed to load diarization model",
        "riva_connected": "✅ Nvidia Riva client connected",
        "riva_warmup_fail": "⚠️ Nvidia Riva warmup failed",

        # ── Errors ──
        "nvidia_key_not_set": "Nvidia API key not configured",
    },
}


def t(key: str, lang: str = "vi") -> str:
    """Get translated string by key and language."""
    strings = TRANSLATIONS.get(lang, TRANSLATIONS["en"])
    return strings.get(key, TRANSLATIONS["en"].get(key, key))
