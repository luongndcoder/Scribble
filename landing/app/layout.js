import "./globals.css";

export const metadata = {
  title: "Scribble — AI Meeting Minutes | Ghi chú cuộc họp thông minh",
  description: "Ứng dụng ghi chú cuộc họp thông minh — ghi âm, phiên dịch realtime, dịch cabin đa ngôn ngữ và tạo biên bản tự động bằng AI. Smart meeting notes app.",
  keywords: "meeting minutes, AI, transcription, STT, ghi âm, biên bản họp, Electron",
  openGraph: {
    title: "Scribble — AI Meeting Minutes",
    description: "Record, transcribe, translate, and summarize meetings with AI.",
    type: "website",
  },
};

export default function RootLayout({ children }) {
  return (
    <html lang="vi">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet" />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
