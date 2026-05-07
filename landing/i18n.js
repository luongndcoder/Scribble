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
    "hero.metric.size": "Nhẹ",
    "hero.metric.private": "Riêng tư",
    "hero.metric.lang": "Ngôn ngữ",

    // Demo
    "demo.title": "Scribble — Bản demo",

    // Features
    "features.tag": "Tính năng",
    "features.title1": "Mọi thứ bạn cần cho",
    "features.title2": "cuộc họp hoàn hảo",
    "features.sub": "Không phụ thuộc cloud. Không đăng ký. AI mạnh mẽ chạy ngay trên máy bạn.",
    "features.f1.title": "Phiên âm thời gian thực",
    "features.f1.desc": "Nvidia Riva hoặc Soniox streaming với độ trễ dưới một giây. Chữ hiện ngay khi được nói.",
    "features.f2.title": "Nhận diện người nói",
    "features.f2.desc": "Nhận diện ai đang nói dựa trên pitch và đặc trưng giọng nói. Mỗi giọng nói được tự động gán nhãn.",
    "features.f3.title": "Dịch trực tiếp",
    "features.f3.desc": "Dịch trực tiếp sang 12+ ngôn ngữ. Bản dịch hiển thị ngay dưới mỗi dòng phiên âm.",
    "features.f4.title": "Biên bản cuộc họp AI",
    "features.f4.desc": "Tóm tắt một cú click: tiêu đề, ý chính, hành động, quyết định, rủi ro. Xuất Markdown hoặc Word.",
    "features.f5.title": "Tự động lưu & Khôi phục",
    "features.f5.desc": "Bản ghi lưu liên tục vào SQLite. Dù ứng dụng crash, dữ liệu cuộc họp vẫn an toàn.",
    "features.f6.title": "Bảo mật trên hết",
    "features.f6.desc": "Mọi thứ chạy cục bộ. API keys chỉ lưu trên máy bạn. Không dữ liệu nào rời đi mà không có sự đồng ý.",

    // How it works
    "how.tag": "Bắt đầu nhanh",
    "how.title1": "Bắt đầu trong",
    "how.title2": "3 bước đơn giản",
    "how.s1.title": "Tải & Cài đặt",
    "how.s1.desc": "Tải bản cài đặt cho macOS hoặc Windows. Cài đặt một click, không cần cấu hình.",
    "how.s2.title": "Thêm API Key",
    "how.s2.desc": "Nhập Nvidia Riva hoặc Soniox key trong Cài đặt. Gói miễn phí có tại build.nvidia.com hoặc soniox.com.",
    "how.s3.title": "Bắt đầu ghi âm",
    "how.s3.desc": "Nhấn Record — phiên âm trực tiếp, nhãn người nói, và dịch thuật hiện ngay lập tức.",

    // Download
    "dl.tag": "Tải xuống",
    "dl.title1": "Sẵn sàng để ",
    "dl.title2": "thay đổi\ncuộc họp của bạn",
    "dl.title3": "?",
    "dl.sub": "Miễn phí và mã nguồn mở. Có sẵn cho macOS và Windows.",
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
    "m2.desc": "Double-click file <code>.dmg</code>. macOS có thể hiện cảnh báo <strong>\"Scribble_1.1.2_aarch64.dmg Not Opened\"</strong> vì file chưa được ký. Nhấn <strong>\"Done\"</strong> — chúng ta sẽ sửa ở bước tiếp.",
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
    "m9.desc": "Ứng dụng khởi chạy thành công. Bạn sẽ thấy giao diện chính Scribble. Tiếp tục Phase 2 để thiết lập API key.",

    // Windows steps
    "w1.title": "Tải bộ cài đặt",
    "w1.desc": "Nhấn nút <strong>Tải xuống</strong> ở <a href=\"#download\">phần bên trên</a> để tải file <code>.exe</code>. Trình duyệt có thể hiện cảnh báo file ít được tải — điều này bình thường với ứng dụng mới.",
    "w2.title": "Nhấn menu \"⋯\" → Keep",
    "w2.desc": "Nhấn <strong>menu ba chấm (⋯)</strong> trên thanh cảnh báo tải xuống. Chọn <strong>\"Keep\"</strong> từ dropdown để giữ file thay vì xóa.",
    "w3.title": "Nhấn \"Keep anyway\"",
    "w3.desc": "Xác nhận lần hai xuất hiện. Nhấn <strong>\"Keep anyway\"</strong> để xác nhận lưu bộ cài.",
    "w4.title": "Mở bộ cài đặt",
    "w4.desc": "Vào thư mục <strong>Downloads</strong> và double-click <code>Scribble_1.1.2_x64-setup.exe</code> để bắt đầu cài đặt.",
    "w5.title": "Bỏ qua SmartScreen — nhấn \"Show more\"",
    "w5.desc": "Windows Defender SmartScreen sẽ hiện <strong>\"This app might harm your device\"</strong>. Nhấn <strong>\"Show more ∨\"</strong> để hiện tùy chọn tiếp tục.",
    "w6.title": "Nhấn \"Install anyway\"",
    "w6.desc": "Sau khi nhấn \"Show more\", nút <strong>\"Install anyway\"</strong> xuất hiện. Nhấn để tiếp tục cài đặt.",
    "w7.title": "Cài đặt hoàn tất!",
    "w7.desc": "Trình cài đặt sẽ hướng dẫn bạn qua các bước còn lại. Chọn ngôn ngữ, vị trí cài đặt, và Scribble sẽ sẵn sàng trong vài giây. Tiếp tục Phase 2 để thiết lập API key.",

    // Phase 2: NVIDIA
    "p2.title": "Lấy API Key NVIDIA miễn phí",
    "p2.sub": "Cần thiết cho tính năng phiên âm và AI (có gói miễn phí)",
    "n1.title": "Truy cập build.nvidia.com",
    "n1.desc": "Vào <a href=\"https://build.nvidia.com\" target=\"_blank\" rel=\"noopener\"><strong>build.nvidia.com</strong></a> và nhấn nút <strong>\"Login\"</strong> ở góc trên bên phải. Nếu chưa có tài khoản, bạn cần tạo mới.",
    "n2.title": "Tạo tài khoản",
    "n2.desc": "Điền <strong>email</strong>, <strong>mật khẩu</strong>, hoàn thành hCaptcha, rồi nhấn <strong>\"Create Account\"</strong>. Bạn cũng có thể đăng ký qua Google hoặc GitHub.",
    "n3.title": "Xác minh email",
    "n3.desc": "NVIDIA sẽ gửi <strong>mã 6 chữ số</strong> đến email. Nhập mã và nhấn <strong>\"Continue\"</strong>.",
    "n4.title": "Hoàn tất đăng ký",
    "n4.desc": "Xem lại cài đặt tùy chọn (không bắt buộc). Nhấn <strong>\"Submit\"</strong> để hoàn tất tài khoản. Bạn sẽ được chuyển đến trang quản trị NVIDIA.",
    "n5.title": "Tạo NVIDIA Cloud Account",
    "n5.desc": "Bạn sẽ được yêu cầu tạo <strong>NVIDIA Cloud Account</strong>. Nhập <strong>Cloud Account Name</strong> (ví dụ: tên bạn hoặc tổ chức), rồi nhấn <strong>\"Create NVIDIA Cloud Account\"</strong>.",
    "n6.title": "Nhấn \"Verify\" để được cấp quyền API",
    "n6.desc": "Sau khi đăng nhập, bạn sẽ thấy banner vàng phía trên: <strong>\"Please verify your account to get API access\"</strong>. Nhấn nút <strong>\"Verify\"</strong> bên phải banner.",
    "n6.tip": "Bước này bắt buộc — bạn không thể tạo API key mà không xác minh số điện thoại.",
    "n7.title": "Xác minh số điện thoại",
    "n7.desc": "Hộp thoại yêu cầu <strong>số điện thoại</strong> sẽ xuất hiện. Chọn <strong>Location</strong>, nhập <strong>Phone Number</strong>, rồi nhấn <strong>\"Send Code via SMS\"</strong>. Nhập mã OTP nhận được để hoàn tất xác minh.",
    "n8.title": "Đi tới API Keys",
    "n8.desc": "Nhấn <strong>icon hồ sơ</strong> ở góc trên bên phải, rồi chọn <strong>\"API Keys\"</strong> từ menu dropdown.",
    "n9.title": "Tạo API Key",
    "n9.desc": "Nhấn <strong>\"Generate API Key\"</strong>. <strong>Sao chép key ngay lập tức</strong> và lưu ở nơi an toàn — bạn sẽ không thể xem lại nó!",
    "n9.tip": "Gói miễn phí cho bạn 1.000 API credit/tháng — đủ dùng cho cá nhân.",

    // Phase 3: Config
    "p3.title": "Cấu hình Scribble",
    "p3.sub": "Dán API key và thiết lập mô hình AI",
    "c1.title": "Mở Settings → Riva (Phiên âm)",
    "c1.desc": "Mở Scribble, nhấn biểu tượng <strong>⚙️ Settings</strong> ở góc trên bên phải. Trong phần <strong>Riva</strong>, bạn sẽ thấy các trường cấu hình kết nối.",
    "c2.title": "Nhập Riva API Key & Server URL",
    "c2.desc": "Dán NVIDIA API key vào trường <strong>API Key</strong>. Sau đó nhập server URL và nhấn <strong>\"Test Connection\"</strong> để kiểm tra.",
    "c3.title": "Cấu hình AI Assistant API Key",
    "c3.desc": "Cuộn xuống phần <strong>AI Assistant</strong>. Dán cùng NVIDIA API key vào trường <strong>API Key</strong>.",
    "c4.title": "Đặt AI Server URL & Model",
    "c4.desc": "Nhập địa chỉ server và tên model trong phần AI Assistant. Nhấn <strong>\"Save\"</strong> để áp dụng tất cả cài đặt.",
    "c4.tip": "Bạn có thể dùng bất kỳ AI model tương thích nào. DeepSeek v3.2 được khuyên dùng cho kết quả tốt nhất.",

    // Phase 4: Permissions
    "p4.title": "Bắt đầu ghi âm",
    "p4.sub": "Cấp quyền và bắt đầu phiên đầu tiên",
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
    "faq.a2": "Scribble dùng backend Python (đóng gói bằng PyInstaller) mà một số phần mềm diệt virus nhầm báo là mã độc. Đây là lỗi dương tính giả phổ biến ảnh hưởng nhiều ứng dụng Python.",
    "faq.q3": "Có cần trả phí cho API không?",
    "faq.a3": "Không. Cả NVIDIA và Soniox đều cung cấp gói miễn phí. NVIDIA tại <a href=\"https://build.nvidia.com\" target=\"_blank\" rel=\"noopener\">build.nvidia.com</a>, Soniox tại <a href=\"https://soniox.com\" target=\"_blank\" rel=\"noopener\">soniox.com</a>. Đăng ký và tạo API key miễn phí.",

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
    "hero.metric.size": "Lightweight",
    "hero.metric.private": "Private",
    "hero.metric.lang": "Languages",
    "demo.title": "Scribble — Live Demo",
    "features.tag": "Features",
    "features.title1": "Everything you need for",
    "features.title2": "perfect meetings",
    "features.sub": "No cloud dependency. No subscription. Just powerful AI running on your machine.",
    "features.f1.title": "Real-time Transcription",
    "features.f1.desc": "Nvidia Riva or Soniox streaming with sub-second latency. Words appear the moment they're spoken.",
    "features.f2.title": "Speaker Identification",
    "features.f2.desc": "Pitch-based and voice feature diarization identifies who's speaking. Each voice auto-labeled in real-time.",
    "features.f3.title": "Live Translation",
    "features.f3.desc": "Real-time cabin translation into 12+ languages. Translations stream below each transcript line.",
    "features.f4.title": "AI Meeting Minutes",
    "features.f4.desc": "One-click summaries: title, key points, action items, decisions, risks. Export as Markdown or Word.",
    "features.f5.title": "Auto-save & Recovery",
    "features.f5.desc": "Transcripts save incrementally to SQLite. Even if the app crashes, your meeting data stays safe.",
    "features.f6.title": "Privacy First",
    "features.f6.desc": "Everything runs locally. API keys stored on your machine only. No data leaves without your consent.",
    "how.tag": "Quick Start",
    "how.title1": "Get started in",
    "how.title2": "3 simple steps",
    "how.s1.title": "Download & Install",
    "how.s1.desc": "Grab the installer for macOS or Windows. One-click install, zero configuration.",
    "how.s2.title": "Add Your API Key",
    "how.s2.desc": "Enter your Nvidia Riva or Soniox key in Settings. Free tiers available at build.nvidia.com or soniox.com.",
    "how.s3.title": "Start Recording",
    "how.s3.desc": "Hit record — live transcription, speaker labels, and translation appear instantly.",
    "dl.tag": "Download",
    "dl.title1": "Ready to ",
    "dl.title2": "transform\nyour meetings",
    "dl.title3": "?",
    "dl.sub": "Free and open-source. Available for macOS and Windows.",
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
    "m2.desc": "Double-click the <code>.dmg</code> file. macOS may show a <strong>\"Scribble_1.1.2_aarch64.dmg Not Opened\"</strong> warning because it's unsigned. Click <strong>\"Done\"</strong> for now — we'll fix this in the next step.",
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
    "m9.desc": "The app launches successfully. You'll see the main Scribble interface. Continue to Phase 2 to set up your API key.",
    "w1.title": "Download the installer",
    "w1.desc": "Click the <strong>Download</strong> button in the <a href=\"#download\">section above</a> to download the <code>.exe</code> file. Your browser may show a warning that it\u2019s not commonly downloaded \u2014 this is normal for new apps.",
    "w2.title": "Click the \"⋯\" menu → Keep",
    "w2.desc": "Click the <strong>three-dot menu (⋯)</strong> on the download warning bar. Select <strong>\"Keep\"</strong> from the dropdown to keep the file instead of deleting it.",
    "w3.title": "Click \"Keep anyway\"",
    "w3.desc": "A second confirmation appears. Click <strong>\"Keep anyway\"</strong> to confirm saving the installer.",
    "w4.title": "Open the installer",
    "w4.desc": "Go to your <strong>Downloads</strong> folder and double-click <code>Scribble_1.1.2_x64-setup.exe</code> to start the installation.",
    "w5.title": "Bypass SmartScreen — click \"Show more\"",
    "w5.desc": "Windows Defender SmartScreen will show <strong>\"This app might harm your device\"</strong>. Click <strong>\"Show more ∨\"</strong> to reveal the option to proceed.",
    "w6.title": "Click \"Install anyway\"",
    "w6.desc": "After clicking \"Show more\", the <strong>\"Install anyway\"</strong> button appears. Click it to proceed with the installation.",
    "w7.title": "Installation complete!",
    "w7.desc": "The installer wizard will guide you through the remaining steps. Choose your language, install location, and Scribble will be ready in seconds. Continue to Phase 2 to set up your API key.",
    "p2.title": "Get your free NVIDIA API Key",
    "p2.sub": "Required for speech-to-text and AI features (free tier available)",
    "n1.title": "Go to build.nvidia.com",
    "n1.desc": "Visit <a href=\"https://build.nvidia.com\" target=\"_blank\" rel=\"noopener\"><strong>build.nvidia.com</strong></a> and click the <strong>\"Login\"</strong> button in the top-right corner. If you don't have an account yet, you'll need to create one.",
    "n2.title": "Create your account",
    "n2.desc": "Fill in your <strong>email</strong>, <strong>password</strong>, complete the hCaptcha, then click <strong>\"Create Account\"</strong>. You can also sign up with Google or GitHub.",
    "n3.title": "Verify your email",
    "n3.desc": "NVIDIA will send a <strong>6-digit verification code</strong> to your email. Enter the code and click <strong>\"Continue\"</strong>.",
    "n4.title": "Complete registration",
    "n4.desc": "Review your preference settings (optional). Click <strong>\"Submit\"</strong> to finalize your account. You'll be redirected to the NVIDIA dashboard.",
    "n5.title": "Create NVIDIA Cloud Account",
    "n5.desc": "You'll be asked to create an <strong>NVIDIA Cloud Account</strong>. Enter a <strong>Cloud Account Name</strong> (e.g. your name or organization), then click <strong>\"Create NVIDIA Cloud Account\"</strong>.",
    "n6.title": "Click \"Verify\" to get API access",
    "n6.desc": "After logging in, you'll see a yellow banner at the top: <strong>\"Please verify your account to get API access\"</strong>. Click the <strong>\"Verify\"</strong> button on the right side of the banner.",
    "n6.tip": "This step is required — you cannot generate API keys without verifying your phone number.",
    "n7.title": "Verify your phone number",
    "n7.desc": "A dialog will appear asking for your <strong>phone number</strong>. Select your <strong>Location</strong>, enter your <strong>Phone Number</strong>, then click <strong>\"Send Code via SMS\"</strong>. Enter the OTP code you receive to complete verification.",
    "n8.title": "Navigate to API Keys",
    "n8.desc": "Click your <strong>profile icon</strong> in the top-right corner, then select <strong>\"API Keys\"</strong> from the dropdown menu.",
    "n9.title": "Generate your API Key",
    "n9.desc": "Click <strong>\"Generate API Key\"</strong>. <strong>Copy the key immediately</strong> and save it somewhere safe — you won't be able to see it again!",
    "n9.tip": "The free tier gives you 1,000 API credits/month — plenty for personal use.",
    "p3.title": "Configure Scribble",
    "p3.sub": "Paste your API key and set up the AI model",
    "c1.title": "Open Settings → Riva (Speech-to-Text)",
    "c1.desc": "Launch Scribble, click the <strong>⚙️ Settings</strong> icon in the top-right corner. In the <strong>Riva</strong> section, you'll see the connection configuration fields.",
    "c2.title": "Enter Riva API Key & Server URL",
    "c2.desc": "Paste your NVIDIA API key into the <strong>API Key</strong> field. Then enter the server URL and click <strong>\"Test Connection\"</strong> to verify.",
    "c3.title": "Configure AI Assistant API Key",
    "c3.desc": "Scroll down to the <strong>AI Assistant</strong> section. Paste the same NVIDIA API key into the <strong>API Key</strong> field.",
    "c4.title": "Set AI Server URL & Model",
    "c4.desc": "Enter the server address and model name in the AI Assistant section. Click <strong>\"Save\"</strong> to apply all settings.",
    "c4.tip": "You can use any compatible AI model. DeepSeek v3.2 is recommended for best results.",
    "p4.title": "Start Recording",
    "p4.sub": "Grant permissions and begin your first session",
    "perm1.title": "Grant Screen & System Audio ",
    "perm1.desc": "When you first click <strong>\"Record\"</strong>, macOS will ask for <strong>Screen & System Audio Recording</strong> permission. Click <strong>\"Open System Settings\"</strong> to go directly to the permission panel.",
    "perm2.title": "Enable Scribble in System Settings ",
    "perm2.desc": "In <strong>System Settings → Privacy & Security → Screen & System Audio Recording</strong>, find <strong>Scribble</strong> in the list and <strong>toggle it ON</strong>. You may need to enter your password.",
    "perm3.title": "You're all set! Start your first meeting",
    "perm3.desc": "Create a new meeting, hit <strong>Record</strong>, and watch real-time transcription with speaker diarization appear instantly. Scribble identifies speakers automatically and streams the transcript live.",
    "faq.title": "Frequently Asked Questions",
    "faq.q1": "Is Scribble safe to use?",
    "faq.a1": "Yes. Scribble is 100% open source — you can inspect every line of code on <a href=\"https://github.com/luongndcoder/Scribble\" target=\"_blank\" rel=\"noopener\">GitHub</a>. Security warnings appear because the app has not been signed with a commercial code signing certificate.",
    "faq.q2": "Why does my antivirus flag Scribble?",
    "faq.a2": "Scribble uses a Python backend (packaged with PyInstaller) that some antivirus engines mistakenly flag. This is a well-known false positive affecting many Python applications.",
    "faq.q3": "Do I need to pay for the API?",
    "faq.a3": "No. Both NVIDIA and Soniox offer free tiers. NVIDIA at <a href=\"https://build.nvidia.com\" target=\"_blank\" rel=\"noopener\">build.nvidia.com</a>, Soniox at <a href=\"https://soniox.com\" target=\"_blank\" rel=\"noopener\">soniox.com</a>. Sign up and generate an API key for free.",
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

  localStorage.setItem('scribble-lang', lang);
}

function initI18n() {
  const saved = localStorage.getItem('scribble-lang');
  const lang = saved || 'vi'; // default Vietnamese
  applyLanguage(lang);

  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.addEventListener('click', () => applyLanguage(btn.dataset.lang));
  });
}

document.addEventListener('DOMContentLoaded', initI18n);
