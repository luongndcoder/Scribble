// ─── Internationalization ───
const I18N = {
    vi: {
        // Tabs
        tab_meetings: 'Cuộc họp',
        tab_recording: 'Ghi âm',
        tab_summary: 'Biên bản',

        // Header
        settings: 'Cài đặt',

        // Recording
        live_transcription: 'Phiên dịch trực tiếp',
        empty_title: 'Bắt đầu cuộc họp',
        empty_desc: 'Nhấn nút <strong>Ghi âm</strong> bên dưới để bắt đầu.<br>AI sẽ phiên dịch trực tiếp cho bạn.',
        processing: 'Đang xử lý...',
        create_minutes: 'Tạo biên bản',
        new_meeting: 'Cuộc họp mới',
        copy_transcript: 'Sao chép',

        // Audio source
        source_mic: '🎙️ Mic',
        source_system: '🔊 Hệ thống',
        source_both: '🎚️ Cả hai',

        // Translation bar
        cabin_translate: 'Dịch cabin',

        // Summary
        summary_title: 'Biên bản cuộc họp',
        summary_empty: 'Chưa có biên bản. Nhấn <strong>"Tạo biên bản"</strong> sau khi thu âm.',
        export: 'Xuất file',
        delete: 'Xóa',

        // Meetings
        meetings_title: 'Lịch sử cuộc họp',
        no_meetings: 'Chưa có cuộc họp nào',

        // Settings
        settings_title: 'Cài đặt',
        stt_section: 'Nhận dạng giọng nói',
        status_label: 'Trạng thái',
        stt_backend: 'Dịch vụ STT',
        local_desc: 'Chạy trên máy tính',
        nvidia_desc: 'Chỉ tiếng Việt · Miễn phí',
        groq_desc: 'Đa ngôn ngữ · Mất phí',
        nvidia_api_key: 'Khóa API Nvidia',
        groq_api_key: 'Khóa API Groq',
        get_key_at: 'Lấy key tại',
        preprocessing: 'Lọc nhiễu',
        preprocessing_desc: 'Giảm tiếng ồn + Lọc tần số cao + Chuẩn hóa',
        local_requirements: '⚠️ Yêu cầu',
        local_req_body: 'Python 3.10+ và ~4GB RAM',
        llm_section: 'Cấu hình AI',
        llm_hint: 'Cấu hình AI cho tóm tắt cuộc họp và dịch cabin',
        llm_base_url: 'Đường dẫn API',
        llm_base_url_hint: 'URL endpoint tương thích OpenAI API',
        llm_model: 'Tên model',
        llm_model_hint: 'Tên model LLM (ví dụ: gpt-5.1, gpt-5.2)',
        llm_api_key: 'Khóa API',
        language_label: 'Ngôn ngữ / Language',
        save_settings: 'Lưu cài đặt',
        cancel: 'Hủy',

        // Config badges
        configured: '✓ Đã cấu hình',
        not_configured: 'Chưa cấu hình',
        key_configured: '••••••• (đã cấu hình)',

        // Confirm dialog
        confirm_yes: 'Xác nhận',
        confirm_no: 'Hủy',

        // Toast messages
        toast_cabin_on: 'Dịch cabin đã bật →',
        toast_no_source_change: 'Không thể đổi nguồn âm khi đang ghi',
        toast_mic_denied_mac: 'Microphone bị từ chối. Vào System Settings → Privacy & Security → Microphone để cấp quyền cho Scribble.',
        toast_mic_denied: 'Bạn cần cấp quyền microphone để ghi âm.',
        toast_mic_not_found: 'Không tìm thấy microphone. Hãy kết nối mic và thử lại.',
        toast_mic_error: 'Không truy cập được microphone: ',
        toast_resumed: 'Tiếp tục ghi âm',
        toast_paused: 'Đã tạm dừng',
        toast_no_audio: 'Chưa có audio để tải xuống.',
        toast_converting_wav: 'Đang chuyển đổi sang WAV...',
        toast_wav_done: 'Đã tải file WAV!',
        toast_wav_error: 'Lỗi chuyển đổi WAV.',
        toast_transcript_updated: 'Đã cập nhật bản ghi.',
        toast_transcript_deleted: 'Đã xóa đoạn bản ghi.',
        toast_transcript_cleared: 'Đã xóa tất cả transcript.',
        toast_translation_updated: 'Đã cập nhật bản dịch.',
        confirm_clear_all: 'Bạn có chắc muốn xóa tất cả transcript?',
        clear_all: 'Xóa tất cả',
        toast_no_transcript_copy: 'Chưa có bản ghi để sao chép.',
        toast_copied_vtt: 'Đã sao chép bản ghi!',
        toast_minutes_done: 'Biên bản đã được tạo!',
        toast_minutes_empty: 'Không nhận được kết quả từ AI.',
        toast_minutes_error: 'Lỗi khi tạo biên bản: ',
        toast_draft_restored: 'Đã khôi phục {0} đoạn bản ghi!',
        toast_meeting_deleted: 'Đã xóa cuộc họp.',
        toast_meeting_delete_error: 'Lỗi xóa cuộc họp.',
        toast_no_transcript_export: 'Cuộc họp chưa có bản ghi.',
        toast_transcript_downloaded: 'Đã tải bản ghi!',
        toast_transcript_download_error: 'Lỗi tải bản ghi.',
        toast_loading_audio: 'Đang tải audio...',
        toast_meeting_load_error: 'Không tải được cuộc họp.',
        toast_meetings_load_error: 'Lỗi tải cuộc họp.',
        toast_no_meeting_export: 'Chưa có cuộc họp để xuất.',
        toast_md_exported: 'Đã xuất biên bản Markdown!',
        toast_md_error: 'Lỗi xuất Markdown.',
        toast_docx_exported: 'Đã xuất biên bản DOCX!',
        toast_docx_error: 'Lỗi xuất DOCX.',
        toast_save_failed: 'Lưu thất bại.',
        toast_saved: 'Đã lưu cài đặt',
        toast_save_error: 'Lưu thất bại: ',
        toast_server_error: 'Không kết nối được server.',

        // Other
        stt_online: 'Trực tuyến',
        stt_offline: 'Ngoại tuyến — Dịch vụ STT không hoạt động',
        stt_checking: 'Đang kiểm tra...',
        stt_offline_short: 'Ngoại tuyến — Không kết nối được',
        edit: 'Sửa',
        delete_item: 'Xóa',
        draft_banner: '⚡ Có bản ghi đang dở — <strong>Khôi phục ngay</strong>',
        confirm_delete: 'Xóa cuộc họp này và toàn bộ dữ liệu?',
        live: 'TRỰC TIẾP',
        download_transcript: 'Tải bản ghi',
        download_audio: 'Tải audio',
        draft_banner_msg: 'Phát hiện bản ghi chưa hoàn thành ({0} đoạn). Khôi phục?',
        restore: 'Khôi phục',
        dismiss: 'Bỏ qua',
        draft: 'Bản nháp',
        translation_error: 'Lỗi dịch',
        toast_screen_denied: 'Cần cấp quyền Screen Recording. Vào System Settings → Privacy & Security → Screen & System Audio Recording để cấp quyền cho Scribble.',
        toast_no_system_audio: 'Không có âm thanh hệ thống. Hãy phát audio từ một ứng dụng khác.',
        diagnose: '🩺 Kiểm tra cấu hình',
        diagnose_checking: 'Đang kiểm tra kết nối...',
        diagnose_fail: 'Kiểm tra thất bại',
    },

    en: {
        tab_meetings: 'Meetings',
        tab_recording: 'Recording',
        tab_summary: 'Minutes',

        settings: 'Settings',

        live_transcription: 'Live Transcription',
        empty_title: 'Start a meeting',
        empty_desc: 'Press the <strong>Record</strong> button below to start.<br>AI will transcribe in real-time.',
        processing: 'Processing...',
        create_minutes: 'Create Minutes',
        new_meeting: 'New Meeting',
        copy_transcript: 'Copy Transcript',

        source_mic: '🎙️ Mic',
        source_system: '🔊 System',
        source_both: '🎚️ Both',

        cabin_translate: 'Live translate',

        summary_title: 'Meeting Minutes',
        summary_empty: 'No minutes yet. Press <strong>"Create Minutes"</strong> after recording.',
        export: 'Export',
        delete: 'Delete',

        meetings_title: 'Meeting History',
        no_meetings: 'No meetings yet',

        settings_title: 'Settings',
        stt_section: 'Speech-to-Text',
        status_label: 'Status',
        stt_backend: 'STT Backend',
        local_desc: 'Run locally',
        nvidia_desc: 'Vietnamese only · Free',
        groq_desc: 'Multi-language · Paid',
        nvidia_api_key: 'Nvidia API Key',
        groq_api_key: 'Groq API Key',
        get_key_at: 'Get key at',
        preprocessing: 'Preprocessing',
        preprocessing_desc: 'Noise reduction + High-pass filter + Normalize',
        local_requirements: '⚠️ Requirements',
        local_req_body: 'Python 3.10+ and ~4GB RAM',
        llm_section: 'LLM Configuration',
        llm_hint: 'AI configuration for meeting summaries and live translation',
        llm_base_url: 'Base URL',
        llm_base_url_hint: 'OpenAI-compatible API endpoint',
        llm_model: 'Model',
        llm_model_hint: 'LLM model name (e.g. gpt-4o, gpt-5.2, claude-3)',
        llm_api_key: 'API Key',
        language_label: 'Ngôn ngữ / Language',
        save_settings: 'Save Settings',
        cancel: 'Cancel',

        configured: '✓ Configured',
        not_configured: 'Not configured',
        key_configured: '••••••• (configured)',

        confirm_yes: 'Confirm',
        confirm_no: 'Cancel',

        toast_cabin_on: 'Live translation on →',
        toast_no_source_change: 'Cannot change audio source while recording',
        toast_mic_denied_mac: 'Microphone denied. Go to System Settings → Privacy & Security → Microphone to grant access for Scribble.',
        toast_mic_denied: 'Microphone permission is required to record.',
        toast_mic_not_found: 'No microphone found. Connect one and try again.',
        toast_mic_error: 'Cannot access microphone: ',
        toast_resumed: 'Recording resumed',
        toast_paused: 'Paused',
        toast_no_audio: 'No audio to download.',
        toast_converting_wav: 'Converting to WAV...',
        toast_wav_done: 'WAV file downloaded!',
        toast_wav_error: 'WAV conversion error.',
        toast_transcript_updated: 'Transcript updated.',
        toast_transcript_deleted: 'Transcript segment deleted.',
        toast_transcript_cleared: 'All transcript cleared.',
        toast_translation_updated: 'Translation updated.',
        confirm_clear_all: 'Are you sure you want to clear all transcript?',
        clear_all: 'Clear all',
        toast_no_transcript_copy: 'No transcript to copy.',
        toast_copied_vtt: 'Transcript VTT copied!',
        toast_minutes_done: 'Minutes created!',
        toast_minutes_empty: 'No result from AI.',
        toast_minutes_error: 'Error creating minutes: ',
        toast_draft_restored: 'Restored {0} transcript segments!',
        toast_meeting_deleted: 'Meeting deleted.',
        toast_meeting_delete_error: 'Error deleting meeting.',
        toast_no_transcript_export: 'Meeting has no transcript.',
        toast_transcript_downloaded: 'Transcript downloaded!',
        toast_transcript_download_error: 'Error downloading transcript.',
        toast_loading_audio: 'Loading audio...',
        toast_meeting_load_error: 'Could not load meeting.',
        toast_meetings_load_error: 'Error loading meetings.',
        toast_no_meeting_export: 'No meeting to export.',
        toast_md_exported: 'Markdown exported!',
        toast_md_error: 'Markdown export error.',
        toast_docx_exported: 'DOCX exported!',
        toast_docx_error: 'DOCX export error.',
        toast_save_failed: 'Save failed.',
        toast_saved: 'Settings saved',
        toast_save_error: 'Save failed: ',
        toast_server_error: 'Cannot connect to server.',

        stt_online: 'Online',
        stt_offline: 'Offline — STT service not running',
        stt_checking: 'Checking...',
        stt_offline_short: 'Offline — Cannot connect',
        edit: 'Edit',
        delete_item: 'Delete',
        draft_banner: '⚡ A recording was interrupted — <strong>Restore now</strong>',
        confirm_delete: 'Delete this meeting and all its data?',
        live: 'LIVE',
        download_transcript: 'Download transcript',
        download_audio: 'Download audio',
        draft_banner_msg: 'Unfinished recording detected ({0} segments). Restore?',
        restore: 'Restore',
        dismiss: 'Dismiss',
        draft: 'Draft',
        translation_error: 'Translation error',
        toast_screen_denied: 'Screen Recording permission required. Go to System Settings → Privacy & Security → Screen & System Audio Recording to grant access for Scribble.',
        toast_no_system_audio: 'No system audio available. Play audio from another application.',
        diagnose: '🩺 Check configuration',
        diagnose_checking: 'Checking connections...',
        diagnose_fail: 'Check failed',
    },
};

let currentLang = localStorage.getItem('scribble_lang') || 'vi';

function t(key, ...args) {
    let str = (I18N[currentLang] && I18N[currentLang][key]) || (I18N.vi[key]) || key;
    // Replace {0}, {1}, etc. with args
    args.forEach((arg, i) => {
        str = str.replace(`{${i}}`, arg);
    });
    return str;
}

function setLanguage(lang) {
    currentLang = lang;
    localStorage.setItem('scribble_lang', lang);
    document.documentElement.lang = lang;
    applyTranslations();
}

function applyTranslations() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.dataset.i18n;
        const val = t(key);
        if (el.dataset.i18nAttr) {
            el.setAttribute(el.dataset.i18nAttr, val);
        } else {
            el.innerHTML = val;
        }
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        el.placeholder = t(el.dataset.i18nPlaceholder);
    });
}
