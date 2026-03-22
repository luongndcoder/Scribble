/**
 * Centralized translations for VoiceScribe frontend.
 * Usage: import { t } from '../i18n'; t('key', lang)
 */

const translations: Record<string, Record<string, string>> = {
    vi: {
        // ── Settings ──
        settings: 'Cài đặt',
        save_settings: 'Lưu cài đặt',
        cancel: 'Hủy',
        testing: 'Đang kiểm tra...',
        test_connection: 'Kiểm tra kết nối',
        test_all_connections: 'Kiểm tra tất cả kết nối',
        test_result_stt: 'Giọng nói',
        test_result_llm: 'Trợ lý AI',

        // ── Voice Recognition (STT) ──
        voice_recognition: 'Nhận diện giọng nói',
        voice_recognition_desc: 'Cấu hình dịch vụ chuyển giọng nói thành văn bản',
        voice_service: 'Dịch vụ nhận giọng nói',
        stt_provider: 'Nhà cung cấp STT',
        groq_desc: 'Nhanh, đa ngôn ngữ',
        nvidia_desc: 'Miễn phí • Độ trễ thấp',
        soniox_desc: 'Trả phí • Chất lượng tốt hơn',
        groq_access_key: 'Mã truy cập Groq',
        nvidia_access_key: 'Mã truy cập Nvidia',
        soniox_access_key: 'Mã truy cập Soniox',
        soniox_languages: 'Ngôn ngữ nhận diện',
        soniox_languages_hint: 'Chọn ngôn ngữ gợi ý — Soniox tự động nhận diện, gợi ý giúp tăng độ chính xác',
        signup_free_at: 'Đăng ký miễn phí tại',
        primary_language: 'Ngôn ngữ chính',
        auto_detect: 'Tự động nhận diện',
        language_hint: 'Chọn ngôn ngữ chính để nhận diện chính xác hơn',

        // ── AI (LLM) ──
        ai_section: 'Trợ lý AI',
        ai_hint: 'Cấu hình AI để tóm tắt cuộc họp',
        ai_access_key: 'Mã truy cập',
        ai_base_url: 'Địa chỉ máy chủ',
        ai_url_hint: 'Hỗ trợ OpenAI, Gemini, Claude, v.v.',
        ai_model: 'Tên mô hình',
        ai_model_hint: 'Ví dụ: gpt-4o, gemini-2.0-flash, claude-3',

        // ── Recording ──
        recording: 'Đang ghi âm',
        paused: 'Tạm dừng',
        start_recording: 'Bắt đầu ghi âm',
        stop_recording: 'Dừng ghi âm',
        summarize: 'Tóm tắt',
        download: 'Tải xuống',

        // ── Meeting List ──
        meetings: 'Cuộc họp',
        new_meeting: 'Cuộc họp mới',
        no_meetings: 'Chưa có cuộc họp nào',
        no_meetings_hint: 'Bắt đầu ghi âm để tạo cuộc họp đầu tiên',
        delete: 'Xóa',
        delete_confirm: 'Bạn có chắc muốn xóa cuộc họp này?',
        confirm: 'Xác nhận',

        // ── Meeting Detail ──
        transcript: 'Bản ghi',
        summary: 'Tóm tắt',
        translation: 'Bản dịch',
        translate: 'Dịch',
        translating: 'Đang dịch...',
        summarizing: 'Đang tóm tắt...',
        copy: 'Sao chép',
        copied: 'Đã sao chép',
        export: 'Xuất file',
        back: 'Quay lại',
        untitled_meeting: 'Cuộc họp chưa đặt tên',

        // ── Welcome ──
        welcome_title: 'Chào mừng đến VoiceScribe',
        welcome_sub: 'Ghi âm cuộc họp, nhận diện giọng nói và tóm tắt tự động',

        // ── Audio source ──
        mic_only: 'Chỉ micro',
        system_only: 'Chỉ âm thanh hệ thống',
        both: 'Micro + Hệ thống',
    },
    en: {
        // ── Settings ──
        settings: 'Settings',
        save_settings: 'Save Settings',
        cancel: 'Cancel',
        testing: 'Testing...',
        test_connection: 'Test Connection',
        test_all_connections: 'Test All Connections',
        test_result_stt: 'Voice',
        test_result_llm: 'AI Assistant',

        // ── Voice Recognition (STT) ──
        voice_recognition: 'Voice Recognition',
        voice_recognition_desc: 'Configure speech-to-text service',
        voice_service: 'Voice Service',
        stt_provider: 'STT Provider',
        groq_desc: 'Fast, multilingual',
        nvidia_desc: 'Free • Low latency',
        soniox_desc: 'Paid • Better accuracy',
        groq_access_key: 'Groq Access Key',
        nvidia_access_key: 'Nvidia Access Key',
        soniox_access_key: 'Soniox Access Key',
        soniox_languages: 'Recognition Languages',
        soniox_languages_hint: 'Select language hints — Soniox auto-detects, hints improve accuracy',
        signup_free_at: 'Sign up free at',
        primary_language: 'Primary Language',
        auto_detect: 'Auto-detect',
        language_hint: 'Select primary language for better accuracy',

        // ── AI (LLM) ──
        ai_section: 'AI Assistant',
        ai_hint: 'For generating meeting summaries',
        ai_access_key: 'Access Key',
        ai_base_url: 'Server URL',
        ai_url_hint: 'Supports OpenAI, Gemini, Claude, etc.',
        ai_model: 'Model Name',
        ai_model_hint: 'E.g. gpt-4o, gemini-2.0-flash, claude-3',

        // ── Recording ──
        recording: 'Recording',
        paused: 'Paused',
        start_recording: 'Start Recording',
        stop_recording: 'Stop Recording',
        summarize: 'Summarize',
        download: 'Download',

        // ── Meeting List ──
        meetings: 'Meetings',
        new_meeting: 'New Meeting',
        no_meetings: 'No meetings yet',
        no_meetings_hint: 'Start recording to create your first meeting',
        delete: 'Delete',
        delete_confirm: 'Are you sure you want to delete this meeting?',
        confirm: 'Confirm',

        // ── Meeting Detail ──
        transcript: 'Transcript',
        summary: 'Summary',
        translation: 'Translation',
        translate: 'Translate',
        translating: 'Translating...',
        summarizing: 'Summarizing...',
        copy: 'Copy',
        copied: 'Copied',
        export: 'Export',
        back: 'Back',
        untitled_meeting: 'Untitled Meeting',

        // ── Welcome ──
        welcome_title: 'Welcome to VoiceScribe',
        welcome_sub: 'Record meetings, recognize speech and auto-summarize',

        // ── Audio source ──
        mic_only: 'Mic only',
        system_only: 'System audio only',
        both: 'Mic + System',
    },
};

export function t(key: string, lang: string): string {
    const strings = translations[lang] || translations.en;
    return strings[key] ?? translations.en[key] ?? key;
}
