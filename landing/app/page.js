import Image from "next/image";

const DOWNLOAD_LINKS = {
  macArm: "https://github.com/luongndcoder/Scribble/releases/latest/download/Scribble-1.0.0-arm64.dmg",
  macIntel: "https://github.com/luongndcoder/Scribble/releases/latest/download/Scribble-1.0.0.dmg",
  windows: "https://github.com/luongndcoder/Scribble/releases/latest/download/Scribble.Setup.1.0.0.exe",
};

const FEATURES = [
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-7 h-7">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
      </svg>
    ),
    title: "Real-time Recording",
    desc: "VAD-based chunking — tự động cắt đoạn theo khoảng lặng, ghi âm mic hoặc system audio.",
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-7 h-7">
        <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
      </svg>
    ),
    title: "3 STT Backends",
    desc: "Local Parakeet (offline), Nvidia Cloud (tiếng Việt), Groq Whisper (đa ngôn ngữ, ~1.000đ/giờ).",
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-7 h-7">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456zM16.894 20.567L16.5 21.75l-.394-1.183a2.25 2.25 0 00-1.423-1.423L13.5 18.75l1.183-.394a2.25 2.25 0 001.423-1.423l.394-1.183.394 1.183a2.25 2.25 0 001.423 1.423l1.183.394-1.183.394a2.25 2.25 0 00-1.423 1.423z" />
      </svg>
    ),
    title: "AI Meeting Minutes",
    desc: "Tạo biên bản họp tự động với GPT — quyết định, action items, rủi ro, follow-up.",
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-7 h-7">
        <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 21l5.25-11.25L21 21m-9-3h7.5M3 5.621a48.474 48.474 0 016-.371m0 0c1.12 0 2.233.038 3.334.114M9 5.25V3m3.334 2.364V3M3 11.25h18" />
      </svg>
    ),
    title: "Cabin Translation",
    desc: "Dịch cabin 10 ngôn ngữ realtime qua SSE streaming. Anh, Nhật, Hàn, Trung, Pháp...",
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-7 h-7">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
      </svg>
    ),
    title: "Export Markdown & DOCX",
    desc: "Xuất biên bản cuộc họp hoàn chỉnh sang Markdown hoặc file Word (.docx).",
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-7 h-7">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
      </svg>
    ),
    title: "Privacy First",
    desc: "API keys lưu 100% trên máy bạn. Không thu thập, không gửi dữ liệu đi đâu cả.",
  },
];

const STT_BACKENDS = [
  { name: "Local Parakeet", badge: "Offline", desc: "Miễn phí, tiếng Việt, chạy offline trên máy", cost: "Miễn phí", color: "text-emerald-400" },
  { name: "Nvidia Cloud", badge: "Cloud", desc: "40 req/min miễn phí, chỉ hỗ trợ tiếng Việt", cost: "Miễn phí", color: "text-green-400" },
  { name: "Groq Whisper", badge: "Nhanh nhất", desc: "Siêu nhanh, đa ngôn ngữ, chất lượng cao", cost: "~1.000đ/giờ", color: "text-cyan-400" },
];

export default function Home() {
  return (
    <main className="min-h-screen overflow-hidden">
      {/* ── Navbar ── */}
      <nav className="fixed top-0 left-0 right-0 z-50 glass">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Image src="/favicon.png" alt="Scribble" width={32} height={32} className="rounded-lg" />
            <span className="text-lg font-bold tracking-tight">Scribble</span>
          </div>
          <div className="hidden md:flex items-center gap-8 text-sm text-text-muted">
            <a href="#features" className="hover:text-white transition-colors">Features</a>
            <a href="#backends" className="hover:text-white transition-colors">STT Backends</a>
            <a href="#demo" className="hover:text-white transition-colors">Demo</a>
            <a href="https://github.com/luongndcoder/Scribble" target="_blank" rel="noopener" className="hover:text-white transition-colors flex items-center gap-1.5">
              <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" /></svg>
              GitHub
            </a>
          </div>
          <a href="#download" className="btn-shimmer text-white text-sm font-medium px-5 py-2 rounded-full transition-all hover:scale-105">
            Download
          </a>
        </div>
      </nav>

      {/* ── Hero Section ── */}
      <section className="hero-bg grid-pattern relative pt-32 pb-20 px-6">
        {/* Decorative orbs */}
        <div className="absolute top-20 left-1/4 w-72 h-72 bg-primary/10 rounded-full blur-[100px] animate-float" />
        <div className="absolute top-40 right-1/4 w-60 h-60 bg-accent/10 rounded-full blur-[100px] animate-float animation-delay-200" />

        <div className="max-w-4xl mx-auto text-center relative z-10">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full glass text-xs font-medium text-text-muted mb-8 animate-fade-in-up">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            Open Source · MIT License
          </div>

          <h1 className="text-5xl md:text-7xl font-black tracking-tight mb-6 animate-fade-in-up animation-delay-200">
            Meeting Minutes,<br />
            <span className="gradient-text">Powered by AI</span>
          </h1>

          <p className="text-lg md:text-xl text-text-muted max-w-2xl mx-auto mb-10 leading-relaxed animate-fade-in-up animation-delay-400">
            Ghi âm, phiên dịch realtime, dịch cabin đa ngôn ngữ và tạo biên bản tự động.
            <br className="hidden md:block" />
            Tất cả trong một ứng dụng desktop miễn phí.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 animate-fade-in-up animation-delay-600">
            <a href="#download" className="btn-shimmer text-white font-semibold px-8 py-3.5 rounded-full text-base transition-all hover:scale-105 flex items-center gap-2">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-5 h-5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
              </svg>
              Tải miễn phí
            </a>
            <a href="https://github.com/luongndcoder/Scribble" target="_blank" rel="noopener"
              className="flex items-center gap-2 px-8 py-3.5 rounded-full border border-border text-text-muted hover:text-white hover:border-primary transition-all text-base font-medium">
              <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" /></svg>
              View Source
            </a>
          </div>
        </div>
      </section>

      {/* ── Demo Section ── */}
      <section id="demo" className="py-20 px-6">
        <div className="max-w-5xl mx-auto">
          <div className="relative rounded-2xl overflow-hidden glow-primary border border-border bg-surface-2">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-surface-3/50">
              <div className="w-3 h-3 rounded-full bg-red-500/80" />
              <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
              <div className="w-3 h-3 rounded-full bg-green-500/80" />
              <span className="ml-2 text-xs text-text-muted">Scribble — AI Meeting Notes</span>
            </div>
            <Image src="/demo.gif" alt="Scribble Demo" width={1200} height={675} className="w-full" unoptimized />
          </div>
        </div>
      </section>

      {/* ── Features Section ── */}
      <section id="features" className="py-20 px-6">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold mb-4">
              Mọi thứ bạn cần cho <span className="gradient-text">cuộc họp hiệu quả</span>
            </h2>
            <p className="text-text-muted text-lg max-w-2xl mx-auto">
              Từ ghi âm đến biên bản chỉ trong một click
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {FEATURES.map((f, i) => (
              <div key={i} className="feature-card glass rounded-2xl p-6 cursor-pointer">
                <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center text-primary-light mb-4">
                  {f.icon}
                </div>
                <h3 className="text-lg font-semibold mb-2">{f.title}</h3>
                <p className="text-text-muted text-sm leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── STT Backends Section ── */}
      <section id="backends" className="py-20 px-6">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold mb-4">
              Chọn <span className="gradient-text">STT Backend</span> phù hợp
            </h2>
            <p className="text-text-muted text-lg">3 lựa chọn cho mọi nhu cầu</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {STT_BACKENDS.map((b, i) => (
              <div key={i} className="glass rounded-2xl p-6 text-center hover:border-primary transition-all duration-300 cursor-pointer">
                <span className={`inline-block text-xs font-bold uppercase tracking-wider px-3 py-1 rounded-full mb-4 ${b.color} bg-white/5`}>
                  {b.badge}
                </span>
                <h3 className="text-xl font-bold mb-2">{b.name}</h3>
                <p className="text-text-muted text-sm mb-4">{b.desc}</p>
                <div className={`text-2xl font-black ${b.color}`}>{b.cost}</div>
              </div>
            ))}
          </div>

          <div className="mt-8 glass rounded-xl p-4 flex items-start gap-3 max-w-2xl mx-auto">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-5 h-5 text-emerald-400 mt-0.5 shrink-0">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
            </svg>
            <p className="text-sm text-text-muted">
              <strong className="text-white">API keys an toàn:</strong> Được lưu trữ hoàn toàn trên máy tính của bạn. Chúng tôi không thu thập, gửi đi hay sử dụng API key cho bất kỳ mục đích nào.
            </p>
          </div>
        </div>
      </section>

      {/* ── Download Section ── */}
      <section id="download" className="py-20 px-6">
        <div className="max-w-4xl mx-auto text-center">
          <h2 className="text-3xl md:text-4xl font-bold mb-4">
            Tải <span className="gradient-text">Scribble</span> miễn phí
          </h2>
          <p className="text-text-muted text-lg mb-12">Có sẵn cho macOS và Windows</p>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 max-w-3xl mx-auto">
            {/* macOS Apple Silicon */}
            <a href={DOWNLOAD_LINKS.macArm} className="glass rounded-2xl p-6 hover:border-primary transition-all duration-300 group cursor-pointer">
              <div className="text-4xl mb-3">🍎</div>
              <h3 className="font-bold mb-1">macOS</h3>
              <p className="text-text-muted text-xs mb-4">Apple Silicon (M1-M4)</p>
              <span className="inline-flex items-center gap-1.5 text-sm text-primary-light font-medium group-hover:text-accent transition-colors">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                </svg>
                Download .dmg
              </span>
            </a>

            {/* macOS Intel */}
            <a href={DOWNLOAD_LINKS.macIntel} className="glass rounded-2xl p-6 hover:border-primary transition-all duration-300 group cursor-pointer">
              <div className="text-4xl mb-3">🍎</div>
              <h3 className="font-bold mb-1">macOS</h3>
              <p className="text-text-muted text-xs mb-4">Intel</p>
              <span className="inline-flex items-center gap-1.5 text-sm text-primary-light font-medium group-hover:text-accent transition-colors">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                </svg>
                Download .dmg
              </span>
            </a>

            {/* Windows */}
            <a href={DOWNLOAD_LINKS.windows} className="glass rounded-2xl p-6 hover:border-primary transition-all duration-300 group cursor-pointer">
              <div className="text-4xl mb-3">🪟</div>
              <h3 className="font-bold mb-1">Windows</h3>
              <p className="text-text-muted text-xs mb-4">64-bit</p>
              <span className="inline-flex items-center gap-1.5 text-sm text-primary-light font-medium group-hover:text-accent transition-colors">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-4 h-4">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                </svg>
                Download .exe
              </span>
            </a>
          </div>

          <p className="text-text-muted text-xs mt-6">
            macOS: Nếu gặp cảnh báo Gatekeeper, chạy <code className="px-1.5 py-0.5 rounded bg-surface-3 text-text font-mono text-xs">xattr -cr /Applications/Scribble.app</code>
          </p>
        </div>
      </section>

      {/* ── Quick Start Section ── */}
      <section className="py-20 px-6 border-t border-border">
        <div className="max-w-3xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-3xl md:text-4xl font-bold mb-4">
              Hoặc <span className="gradient-text">chạy từ source</span>
            </h2>
          </div>

          <div className="glass rounded-2xl overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-surface-3/50">
              <div className="w-3 h-3 rounded-full bg-red-500/80" />
              <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
              <div className="w-3 h-3 rounded-full bg-green-500/80" />
              <span className="ml-2 text-xs text-text-muted">Terminal</span>
            </div>
            <pre className="p-6 text-sm leading-relaxed overflow-x-auto">
              <code>
                <span className="text-text-muted"># Clone repository</span>{"\n"}
                <span className="text-accent">$</span> git clone https://github.com/luongndcoder/Scribble.git{"\n"}
                <span className="text-accent">$</span> cd Scribble{"\n\n"}
                <span className="text-text-muted"># Install & run</span>{"\n"}
                <span className="text-accent">$</span> npm install{"\n"}
                <span className="text-accent">$</span> npm start{"\n\n"}
                <span className="text-text-muted"># → http://localhost:3000</span>
              </code>
            </pre>
          </div>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="border-t border-border py-12 px-6">
        <div className="max-w-6xl mx-auto flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-3">
            <Image src="/favicon.png" alt="Scribble" width={24} height={24} className="rounded-md" />
            <span className="text-sm text-text-muted">
              © 2025 Scribble. MIT License.
            </span>
          </div>

          <p className="text-xs text-text-muted text-center md:text-right">
            Inspired by{" "}
            <a href="https://github.com/Zackriya-Solutions/meetily" target="_blank" rel="noopener" className="text-primary-light hover:text-accent transition-colors">
              Meetily
            </a>{" "}
            by Zackriya Solutions
          </p>

          <div className="flex items-center gap-6">
            <a href="https://github.com/luongndcoder/Scribble" target="_blank" rel="noopener" className="text-text-muted hover:text-white transition-colors">
              <svg viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" /></svg>
            </a>
          </div>
        </div>
      </footer>
    </main>
  );
}
