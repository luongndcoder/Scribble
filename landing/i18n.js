const translations = {
  vi: {
    // Nav
    "nav.features": "Tính năng",
    "nav.how": "Cách hoạt động",
    "nav.install": "Hướng dẫn cài đặt",
    "nav.download": "Tải xuống",

    // Hero
    "hero.badge": "Mã nguồn mở · Giấy phép MIT",
    "hero.title1": "Cuộc họp của bạn,",
    "hero.title2": "ghi chép hoàn hảo.",
    "hero.sub": "Trợ lý cuộc họp AI ghi âm, phiên âm thời gian thực, nhận diện người nói, và tạo biên bản tự động — tất cả chạy trên máy của bạn.",
    "hero.btn.download": "Tải miễn phí",
    "hero.btn.github": "Xem trên GitHub",
    "hero.metric.val.size": "~100MB",
    "hero.metric.size": "Nhẹ",
    "hero.metric.val.private": "100%",
    "hero.metric.private": "Riêng tư",
    "hero.metric.val.lang": "60+",
    "hero.metric.lang": "Ngôn ngữ",

    // Demo
    "demo.title": "Scribble — Bản demo",

    // Features
    "features.tag": "Tính năng",
    "features.title1": "Mọi thứ bạn cần cho",
    "features.title2": "cuộc họp hoàn hảo",
    "features.sub": "Không phụ thuộc cloud. Không đăng ký. AI mạnh mẽ chạy ngay trên máy bạn.",
    "features.f1.title": "Phiên âm thời gian thực",
    "features.f1.desc": "Soniox streaming hoặc mô hình on-device cục bộ với độ trễ dưới một giây. Chữ hiện ngay khi được nói.",
    "features.f2.title": "Nhận diện người nói",
    "features.f2.desc": "Nhận diện ai đang nói dựa trên pitch và đặc trưng giọng nói. Mỗi giọng nói được tự động gán nhãn.",
    "features.f3.title": "Dịch trực tiếp",
    "features.f3.desc": "Dịch trực tiếp sang 30+ ngôn ngữ. Bản dịch hiển thị ngay dưới mỗi dòng phiên âm.",
    "features.f4.title": "Biên bản cuộc họp AI",
    "features.f4.desc": "Tóm tắt một cú click: tiêu đề, ý chính, hành động, quyết định, rủi ro. Xuất Markdown hoặc Word.",
    "features.f5.title": "Tự động lưu & Khôi phục",
    "features.f5.desc": "Bản ghi lưu liên tục vào SQLite. Dù ứng dụng crash, dữ liệu cuộc họp vẫn an toàn.",
    "features.f6.title": "Bảo mật trên hết",
    "features.f6.desc": "Mọi thứ chạy cục bộ. API keys chỉ lưu trên máy bạn. Không dữ liệu nào rời đi mà không có sự đồng ý.",
    "features.f7.title": "Upload file ghi âm",
    "features.f7.desc": "Có sẵn file mp3/m4a/mp4? Upload trực tiếp — pipeline tự phiên âm, tách người nói, tạo biên bản. Resumable khi mất kết nối.",
    "features.f8.title": "Tài liệu tham khảo",
    "features.f8.desc": "Đính kèm brief, agenda hoặc glossary (.md/.txt) vào meeting — AI dùng làm context để tạo biên bản chính xác hơn, đúng tên riêng và thuật ngữ dự án.",

    // How it works
    "how.tag": "Bắt đầu nhanh",
    "how.title1": "Bắt đầu trong",
    "how.title2": "3 bước đơn giản",
    "how.s1.title": "Tải & Cài đặt",
    "how.s1.desc": "Tải bản cài đặt cho macOS, Windows hoặc Linux. Cài đặt một click, không cần cấu hình.",
    "how.s2.title": "Chọn STT & Thêm Key",
    "how.s2.desc": "Chọn mô hình Local tích hợp sẵn (miễn phí, offline) hoặc nhập Soniox key trong Cài đặt.",
    "how.s3.title": "Bắt đầu ghi âm",
    "how.s3.desc": "Nhấn Record — phiên âm trực tiếp, nhãn người nói, và dịch thuật hiện ngay lập tức.",

    // Download
    "dl.tag": "Tải xuống",
    "dl.title1": "Sẵn sàng để ",
    "dl.title2": "thay đổi\ncuộc họp của bạn",
    "dl.title3": "?",
    "dl.sub": "Miễn phí và mã nguồn mở. Có sẵn cho macOS, Windows và Linux.",
    "dl.latest": "Phiên bản mới nhất:",
    "dl.note": "Lần đầu cài đặt? Xem ",
    "dl.note.link": "Hướng dẫn cài đặt",
    "dl.note.suffix": " bên dưới để biết hướng dẫn thiết lập cho từng nền tảng.",

    // Install Guide
    "install.tag": "Hướng dẫn cài đặt",
    "install.title1": "Hướng dẫn ",
    "install.title2": "cài đặt đầy đủ",
    "install.sub": "Làm theo các bước sau để Scribble hoạt động trong vòng 5 phút. Ảnh chụp màn hình kèm theo mỗi bước.",

    // Phase 1
    "p1.title": "Tải & Cài đặt",
    "p1.sub": "Cài Scribble lên máy của bạn",

    // macOS steps
    "m1.title": "Tải file DMG",
    "m1.desc": "Nhấn nút <strong>Tải xuống</strong> ở <a href=\"#download\">phần bên trên</a> để tải file <code>.dmg</code>. Tìm file trong thư mục <strong>Downloads</strong> của bạn.",
    "m2.title": "Xử lý cảnh báo \"Not Opened\"",
    "m2.desc": "Double-click file <code>.dmg</code> bạn vừa tải. macOS có thể hiện cảnh báo <strong>\"Scribble … Not Opened\"</strong> vì file chưa được ký. Nhấn <strong>\"Done\"</strong> — chúng ta sẽ sửa ở bước tiếp.",
    "m3.title": "Cho phép trong Privacy & Security",
    "m3.desc": "Mở <strong>System Settings → Privacy & Security</strong>. Cuộn xuống tìm thông báo Scribble và nhấn <strong>\"Open Anyway\"</strong> để cho phép DMG chạy.",
    "m3.tip": "Hoặc chạy lệnh: <code>xattr -cr ~/Downloads/Scribble*.dmg</code> trong Terminal",
    "m4.title": "Xác nhận mở DMG",
    "m4.desc": "Hộp thoại xác nhận sẽ xuất hiện. Nhấn <strong>\"Open Anyway\"</strong> và nhập mật khẩu để tiếp tục.",
    "m5.title": "Kéo Scribble vào Applications",
    "m5.desc": "DMG sẽ mở hiện icon Scribble và shortcut thư mục <strong>Applications</strong>. <strong>Kéo icon Scribble vào Applications</strong> để cài đặt.",
    "m6.title": "Xử lý cảnh báo \"Not Opened\" của ứng dụng",
    "m6.desc": "Khi bạn lần đầu mở Scribble từ Applications, macOS hiện thêm cảnh báo <strong>\"Scribble Not Opened\"</strong>. Nhấn <strong>\"Done\"</strong> — cần cho phép qua Privacy & Security lần nữa.",
    "m7.title": "Cho phép ứng dụng trong Privacy & Security",
    "m7.desc": "Quay lại <strong>System Settings → Privacy & Security</strong>. Bạn sẽ thấy Scribble bị chặn. Nhấn <strong>\"Open Anyway\"</strong> một lần nữa.",
    "m7.tip": "Hoặc chạy: <code>xattr -cr /Applications/Scribble.app</code> để bỏ qua bước này",
    "m8.title": "Xác nhận & mở ứng dụng",
    "m8.desc": "Hộp thoại Gatekeeper xuất hiện lần cuối. Nhấn <strong>\"Open Anyway\"</strong> và xác thực bằng mật khẩu hoặc Touch ID.",
    "m9.title": "Đã cài xong Scribble!",
    "m9.desc": "Ứng dụng khởi chạy thành công. Bạn sẽ thấy giao diện chính Scribble. Tiếp tục Phase 2 để thiết lập cấu hình.",

    // Windows steps
    "w1.title": "Tải bộ cài đặt",
    "w1.desc": "Nhấn nút <strong>Tải xuống</strong> ở <a href=\"#download\">phần bên trên</a> để tải file <code>.exe</code>. Trình duyệt có thể hiện cảnh báo file ít được tải — điều này bình thường với ứng dụng mới.",
    "w2.title": "Nhấn menu \"⋯\" → Keep",
    "w2.desc": "Nhấn <strong>menu ba chấm (⋯)</strong> trên thanh cảnh báo tải xuống. Chọn <strong>\"Keep\"</strong> từ dropdown để giữ file thay vì xóa.",
    "w3.title": "Nhấn \"Keep anyway\"",
    "w3.desc": "Xác nhận lần hai xuất hiện. Nhấn <strong>\"Keep anyway\"</strong> để xác nhận lưu bộ cài.",
    "w4.title": "Mở bộ cài đặt",
    "w4.desc": "Vào thư mục <strong>Downloads</strong> và double-click file <code>Scribble_…_x64-setup.exe</code> bạn vừa tải để bắt đầu cài đặt.",
    "w5.title": "Bỏ qua SmartScreen — nhấn \"Show more\"",
    "w5.desc": "Windows Defender SmartScreen sẽ hiện <strong>\"This app might harm your device\"</strong>. Nhấn <strong>\"Show more ∨\"</strong> để hiện tùy chọn tiếp tục.",
    "w6.title": "Nhấn \"Install anyway\"",
    "w6.desc": "Sau khi nhấn \"Show more\", nút <strong>\"Install anyway\"</strong> xuất hiện. Nhấn để tiếp tục cài đặt.",
    "w7.title": "Cài đặt hoàn tất!",
    "w7.desc": "Trình cài đặt sẽ hướng dẫn bạn qua các bước còn lại. Chọn ngôn ngữ, vị trí cài đặt, và Scribble sẽ sẵn sàng trong vài giây. Tiếp tục Phase 2 để thiết lập cấu hình.",

    // Phase 2: Config
    "p2.title": "Cấu hình Scribble",
    "p2.sub": "Cấu hình Speech-to-Text và Trợ lý AI",
    "c1.title": "Cấu hình Speech-to-Text (Phiên âm)",
    "c1.desc": "Mở Scribble, nhấn biểu tượng <strong>⚙️ Settings</strong> ở góc trên bên phải và chọn tab <strong>Speech-to-Text</strong>. Bạn có thể chọn mô hình <strong>Local</strong> (Zipformer 30M hoặc Nemotron 0.6B) để nhận diện giọng nói 100% offline trên máy không cần internet, hoặc chọn <strong>Soniox</strong> để dùng Cloud STT độ chính xác cao.",
    "c2.title": "Cấu hình Trợ lý AI (Tóm tắt & Biên bản)",
    "c2.desc": "Chuyển sang tab <strong>AI Assistant</strong> để cấu hình mô hình tạo tóm tắt và biên bản họp. Scribble hỗ trợ đầy đủ các nhà cung cấp phổ biến: OpenAI, DeepSeek, Google Gemini, Groq, Mistral, OpenRouter hoặc mô hình chạy cục bộ qua Ollama / LM Studio. Chọn nhà cung cấp và dán API Key của bạn.",
    "c2.tip": "Linh hoạt lựa chọn: Bạn có thể dùng API trả phí hoặc các dịch vụ có gói miễn phí như Groq, OpenRouter, Google AI Studio hoặc chạy mô hình local hoàn toàn miễn phí với Ollama.",

    // Phase 3: Permissions
    "p3.title": "Cấp quyền & Bắt đầu ghi âm",
    "p3.sub": "Cấp quyền hệ thống và bắt đầu cuộc họp đầu tiên",
    "perm1.title": "Cấp quyền Screen & System Audio ",
    "perm1.desc": "Khi bạn nhấn <strong>\"Record\"</strong> lần đầu, macOS sẽ yêu cầu quyền <strong>Screen & System Audio Recording</strong>. Nhấn <strong>\"Open System Settings\"</strong> để đến thẳng bảng cấp quyền.",
    "perm2.title": "Bật Scribble trong System Settings ",
    "perm2.desc": "Trong <strong>System Settings → Privacy & Security → Screen & System Audio Recording</strong>, tìm <strong>Scribble</strong> trong danh sách và <strong>bật ON</strong>. Có thể cần nhập mật khẩu.",
    "perm3.title": "Hoàn tất! Bắt đầu cuộc họp đầu tiên",
    "perm3.desc": "Tạo cuộc họp mới, nhấn <strong>Record</strong>, và xem phiên âm thời gian thực với nhận diện người nói xuất hiện ngay lập tức. Scribble tự động nhận diện người nói và phát trực tiếp bản ghi.",

    // FAQ
    "faq.title": "Câu hỏi thường gặp",
    "faq.q1": "Scribble có an toàn không?",
    "faq.a1": "Có. Scribble 100% mã nguồn mở — bạn có thể kiểm tra từng dòng code trên <a href=\"https://github.com/luongndcoder/Scribble\" target=\"_blank\" rel=\"noopener\">GitHub</a>. Cảnh báo bảo mật xuất hiện vì ứng dụng chưa được ký bằng chứng chỉ thương mại.",
    "faq.q2": "Tại sao phần mềm diệt virus báo Scribble?",
    "faq.a2": "Scribble là ứng dụng Rust + Tauri mã nguồn mở. Cảnh báo bảo mật xuất hiện do ứng dụng chưa được mua chứng chỉ ký số thương mại (code signing certificate), hoàn toàn không chứa mã độc.",
    "faq.q3": "Có cần trả phí cho API không?",
    "faq.a3": "Không bắt buộc. Bạn có thể dùng hoàn toàn Offline miễn phí bằng mô hình Local (Zipformer/Nemotron). Nếu dùng Cloud STT, Soniox có gói miễn phí tại <a href=\"https://soniox.com\" target=\"_blank\" rel=\"noopener\">soniox.com</a>. Với AI tóm tắt biên bản, bạn có thể dùng API từ OpenAI, DeepSeek, Google Gemini, Groq, OpenRouter hoặc mô hình cục bộ như Ollama.",

    // Footer
    "footer.tagline": "Trợ lý cuộc họp AI mã nguồn mở",
  },

  en: {
    "nav.features": "Features",
    "nav.how": "How it works",
    "nav.install": "Install Guide",
    "nav.download": "Download",
    "hero.badge": "Open Source · MIT License",
    "hero.title1": "Your meetings,",
    "hero.title2": "perfectly captured.",
    "hero.sub": "AI-powered meeting assistant that records, transcribes in real-time, identifies speakers, and generates comprehensive minutes — all running locally on your machine.",
    "hero.btn.download": "Download Free",
    "hero.btn.github": "View on GitHub",
    "hero.metric.val.size": "~100MB",
    "hero.metric.size": "Lightweight",
    "hero.metric.val.private": "100%",
    "hero.metric.private": "Private",
    "hero.metric.val.lang": "60+",
    "hero.metric.lang": "Languages",
    "demo.title": "Scribble — Live Demo",
    "features.tag": "Features",
    "features.title1": "Everything you need for",
    "features.title2": "perfect meetings",
    "features.sub": "No cloud dependency. No subscription. Just powerful AI running on your machine.",
    "features.f1.title": "Real-time Transcription",
    "features.f1.desc": "Soniox streaming or on-device local models with sub-second latency. Words appear the moment they're spoken.",
    "features.f2.title": "Speaker Identification",
    "features.f2.desc": "Pitch-based and voice feature diarization identifies who's speaking. Each voice auto-labeled in real-time.",
    "features.f3.title": "Live Translation",
    "features.f3.desc": "Real-time cabin translation into 30+ languages. Translations stream below each transcript line.",
    "features.f4.title": "AI Meeting Minutes",
    "features.f4.desc": "One-click summaries: title, key points, action items, decisions, risks. Export as Markdown or Word.",
    "features.f5.title": "Auto-save & Recovery",
    "features.f5.desc": "Transcripts save incrementally to SQLite. Even if the app crashes, your meeting data stays safe.",
    "features.f6.title": "Privacy First",
    "features.f6.desc": "Everything runs locally. API keys stored on your machine only. No data leaves without your consent.",
    "features.f7.title": "Upload Audio Files",
    "features.f7.desc": "Got existing mp3/m4a/mp4 recordings? Drop them in — automatic pipeline transcribes, diarizes, and generates minutes. Resumable across crashes.",
    "features.f8.title": "Reference Materials",
    "features.f8.desc": "Attach project briefs, agendas, or glossaries (.md/.txt) to a meeting — the AI uses them as context so minutes get names, terms, and decisions right.",
    "how.tag": "Quick Start",
    "how.title1": "Get started in",
    "how.title2": "3 simple steps",
    "how.s1.title": "Download & Install",
    "how.s1.desc": "Grab the installer for macOS, Windows, or Linux. One-click install, zero configuration.",
    "how.s2.title": "Choose STT & Add Key",
    "how.s2.desc": "Choose built-in Local models (free, offline) or enter your Soniox key in Settings.",
    "how.s3.title": "Start Recording",
    "how.s3.desc": "Hit record — live transcription, speaker labels, and translation appear instantly.",
    "dl.tag": "Download",
    "dl.title1": "Ready to ",
    "dl.title2": "transform\nyour meetings",
    "dl.title3": "?",
    "dl.sub": "Free and open-source. Available for macOS, Windows, and Linux.",
    "dl.latest": "Latest version:",
    "dl.note": "First time installing? Check our ",
    "dl.note.link": "Installation Guide",
    "dl.note.suffix": " below for platform-specific setup instructions.",
    "install.tag": "Setup Guide",
    "install.title1": "Complete ",
    "install.title2": "setup walkthrough",
    "install.sub": "Follow these steps to get Scribble running in under 5 minutes. Screenshots included for every step.",
    "p1.title": "Download & Install",
    "p1.sub": "Get Scribble on your machine",
    "m1.title": "Download the DMG file",
    "m1.desc": "Click the <strong>Download</strong> button in the <a href=\"#download\">section above</a> to download the <code>.dmg</code> file. Find it in your <strong>Downloads</strong> folder.",
    "m2.title": "Handle \"Not Opened\" warning",
    "m2.desc": "Double-click the <code>.dmg</code> file you just downloaded. macOS may show a <strong>\"Scribble … Not Opened\"</strong> warning because it's unsigned. Click <strong>\"Done\"</strong> for now — we'll fix this in the next step.",
    "m3.title": "Allow in Privacy & Security",
    "m3.desc": "Open <strong>System Settings → Privacy & Security</strong>. Scroll down to find the Scribble message and click <strong>\"Open Anyway\"</strong> to allow the DMG to run.",
    "m3.tip": "Alternative: run <code>xattr -cr ~/Downloads/Scribble*.dmg</code> in Terminal",
    "m4.title": "Confirm opening the DMG",
    "m4.desc": "A confirmation dialog will appear asking to open the DMG. Click <strong>\"Open Anyway\"</strong> and enter your password to proceed.",
    "m5.title": "Drag Scribble to Applications",
    "m5.desc": "The DMG will open showing the Scribble app icon and an <strong>Applications</strong> folder shortcut. <strong>Drag the Scribble icon into Applications</strong> to install.",
    "m6.title": "Handle app \"Not Opened\" warning",
    "m6.desc": "When you first launch Scribble from Applications, macOS shows another <strong>\"Scribble Not Opened\"</strong> warning. Click <strong>\"Done\"</strong> — we need to allow it through Privacy & Security again.",
    "m7.title": "Allow app in Privacy & Security",
    "m7.desc": "Go back to <strong>System Settings → Privacy & Security</strong>. You'll see the Scribble app has been blocked. Click <strong>\"Open Anyway\"</strong> once more.",
    "m7.tip": "Or run: <code>xattr -cr /Applications/Scribble.app</code> to skip this step",
    "m8.title": "Confirm & open the app",
    "m8.desc": "The Gatekeeper dialog appears one last time. Click <strong>\"Open Anyway\"</strong> and authenticate with your password or Touch ID.",
    "m9.title": "Scribble is installed!",
    "m9.desc": "The app launches successfully. You'll see the main Scribble interface. Continue to Phase 2 for configuration.",
    "w1.title": "Download the installer",
    "w1.desc": "Click the <strong>Download</strong> button in the <a href=\"#download\">section above</a> to download the <code>.exe</code> file. Your browser may show a warning that it\u2019s not commonly downloaded \u2014 this is normal for new apps.",
    "w2.title": "Click the \"⋯\" menu → Keep",
    "w2.desc": "Click the <strong>three-dot menu (⋯)</strong> on the download warning bar. Select <strong>\"Keep\"</strong> from the dropdown to keep the file instead of deleting it.",
    "w3.title": "Click \"Keep anyway\"",
    "w3.desc": "A second confirmation appears. Click <strong>\"Keep anyway\"</strong> to confirm saving the installer.",
    "w4.title": "Open the installer",
    "w4.desc": "Go to your <strong>Downloads</strong> folder and double-click the <code>Scribble_…_x64-setup.exe</code> file you just downloaded to start the installation.",
    "w5.title": "Bypass SmartScreen — click \"Show more\"",
    "w5.desc": "Windows Defender SmartScreen will show <strong>\"This app might harm your device\"</strong>. Click <strong>\"Show more ∨\"</strong> to reveal the option to proceed.",
    "w6.title": "Click \"Install anyway\"",
    "w6.desc": "After clicking \"Show more\", the <strong>\"Install anyway\"</strong> button appears. Click it to proceed with the installation.",
    "w7.title": "Installation complete!",
    "w7.desc": "The installer wizard will guide you through the remaining steps. Choose your language, install location, and Scribble will be ready in seconds. Continue to Phase 2 for configuration.",

    // Phase 2: Config
    "p2.title": "Configure Scribble",
    "p2.sub": "Set up Speech-to-Text and AI Assistant",
    "c1.title": "Configure Speech-to-Text",
    "c1.desc": "Launch Scribble, click the <strong>⚙️ Settings</strong> icon in the top-right corner and select the <strong>Speech-to-Text</strong> tab. You can choose <strong>Local</strong> models (Zipformer 30M or Nemotron 0.6B) for 100% on-device offline transcription without internet, or choose <strong>Soniox</strong> for high-accuracy cloud STT.",
    "c2.title": "Configure AI Assistant (Summaries & Minutes)",
    "c2.desc": "Switch to the <strong>AI Assistant</strong> tab to configure summary and minutes generation. Scribble supports all popular providers: OpenAI, DeepSeek, Google Gemini, Groq, Mistral, OpenRouter, or local models via Ollama / LM Studio. Select your provider and paste your API key.",
    "c2.tip": "Flexible choice: You can use paid API keys, generous free tiers like Groq, OpenRouter, Google AI Studio, or run local offline LLMs completely free with Ollama.",

    // Phase 3: Permissions
    "p3.title": "Permissions & Start Recording",
    "p3.sub": "Grant system permissions and begin your first session",
    "perm1.title": "Grant Screen & System Audio ",
    "perm1.desc": "When you first click <strong>\"Record\"</strong>, macOS will ask for <strong>Screen & System Audio Recording</strong> permission. Click <strong>\"Open System Settings\"</strong> to go directly to the permission panel.",
    "perm2.title": "Enable Scribble in System Settings ",
    "perm2.desc": "In <strong>System Settings → Privacy & Security → Screen & System Audio Recording</strong>, find <strong>Scribble</strong> in the list and <strong>toggle it ON</strong>. You may need to enter your password.",
    "perm3.title": "You're all set! Start your first meeting",
    "perm3.desc": "Create a new meeting, hit <strong>Record</strong>, and watch real-time transcription with speaker diarization appear instantly. Scribble identifies speakers automatically and streams the transcript live.",

    // FAQ
    "faq.title": "Frequently Asked Questions",
    "faq.q1": "Is Scribble safe to use?",
    "faq.a1": "Yes. Scribble is 100% open source — you can inspect every line of code on <a href=\"https://github.com/luongndcoder/Scribble\" target=\"_blank\" rel=\"noopener\">GitHub</a>. Security warnings appear because the app has not been signed with a commercial code signing certificate.",
    "faq.q2": "Why does my antivirus flag Scribble?",
    "faq.a2": "Scribble is an open-source Rust + Tauri desktop application. Security warnings appear solely because it has not been signed with an expensive commercial code signing certificate, and it is completely free of malware.",
    "faq.q3": "Do I need to pay for the API?",
    "faq.a3": "Not required. You can use Scribble completely free and offline with local models (Zipformer/Nemotron). For cloud STT, Soniox offers a free tier at <a href=\"https://soniox.com\" target=\"_blank\" rel=\"noopener\">soniox.com</a>. For meeting minutes summaries, you can use your own keys from OpenAI, DeepSeek, Google Gemini, Groq, OpenRouter, or local models via Ollama.",
    "footer.tagline": "Open-source AI meeting assistant",
  }
};

// ─── i18n Engine ───
function applyLanguage(lang) {
  const t = translations[lang];
  if (!t) return;

  document.documentElement.lang = lang === 'vi' ? 'vi' : 'en';

  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (t[key]) el.innerHTML = t[key];
  });

  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.getAttribute('data-i18n-title');
    if (t[key]) el.title = t[key];
  });

  // Update switcher
  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.lang === lang);
  });
}

function initI18n() {
  // English is always prioritized by default unless user explicitly chose otherwise
  const userPref = localStorage.getItem('scribble-user-lang');
  const lang = userPref === 'vi' ? 'vi' : 'en';
  applyLanguage(lang);

  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const chosen = btn.dataset.lang;
      applyLanguage(chosen);
      try {
        localStorage.setItem('scribble-user-lang', chosen);
      } catch (e) {}
    });
  });
}

document.addEventListener('DOMContentLoaded', initI18n);
