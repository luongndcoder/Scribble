/**
 * i18n — Minimal internationalization (vi/en)
 */

type LangKey = 'vi' | 'en';

const translations: Record<string, Record<LangKey, string>> = {
    // App
    'app.title': { vi: 'VoiceScribe', en: 'VoiceScribe' },
    'app.newRecording': { vi: 'Ghi âm mới', en: 'New Recording' },

    // Recording
    'rec.start': { vi: '🎙️ Bắt đầu ghi', en: '🎙️ Start Recording' },
    'rec.stop': { vi: '⏹️ Dừng', en: '⏹️ Stop' },
    'rec.pause': { vi: '⏸️ Tạm dừng', en: '⏸️ Pause' },
    'rec.resume': { vi: '▶️ Tiếp tục', en: '▶️ Resume' },
    'rec.recording': { vi: 'Đang ghi', en: 'Recording' },
    'rec.paused': { vi: 'Tạm dừng', en: 'Paused' },

    // Transcript
    'transcript.empty': { vi: 'Transcript sẽ hiển thị ở đây khi bạn bắt đầu ghi âm', en: 'Transcript will appear here when you start recording' },
    'transcript.title': { vi: 'Bản ghi', en: 'Transcript' },

    // Translation
    'translate.on': { vi: '🌐 Bật', en: '🌐 On' },
    'translate.off': { vi: '🌐 Tắt', en: '🌐 Off' },

    // Meetings
    'meetings.recent': { vi: 'Cuộc họp gần đây', en: 'Recent Meetings' },
    'meetings.empty': { vi: 'Chưa có cuộc họp nào. Bắt đầu ghi âm!', en: 'No meetings yet. Start a recording!' },
    'meetings.draft': { vi: 'Bản nháp', en: 'Draft' },

    // Settings
    'settings.title': { vi: '⚙️ Cài đặt', en: '⚙️ Settings' },
    'settings.save': { vi: '💾 Lưu', en: '💾 Save Settings' },
    'settings.saving': { vi: 'Đang lưu...', en: 'Saving...' },
    'settings.diagnose': { vi: '🔍 Kiểm tra kết nối', en: '🔍 Run Diagnostics' },

    // Summary
    'summary.generate': { vi: '✨ Tạo tóm tắt', en: '✨ Generate' },
    'summary.generating': { vi: '⏳ Đang tạo...', en: '⏳ Generating...' },
    'summary.title': { vi: '📋 Tóm tắt cuộc họp', en: '📋 Meeting Summary' },

    // Common
    'common.back': { vi: '← Quay lại', en: '← Back' },
    'common.delete': { vi: 'Xóa', en: 'Delete' },
    'common.export': { vi: 'Xuất', en: 'Export' },
};

let currentLang: LangKey = 'vi';

export function setLang(lang: LangKey) {
    currentLang = lang;
}

export function t(key: string): string {
    return translations[key]?.[currentLang] || key;
}

export function getLang(): LangKey {
    return currentLang;
}
