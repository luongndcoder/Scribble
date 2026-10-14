# Nhiệm vụ

Sau khi port STT từ Python sidecar sang Rust, trải nghiệm hiển thị transcript lúc ghi âm kém: chữ nhảy dòng, badge speaker chớp, chữ đứng hình, mất câu cuối khi Stop, Soniox realtime không chạy. Cần phân tích và enhance cả contract Rust ↔ frontend lẫn UX live.

# Đã sửa gì

**Rust (`src-tauri/src/`)**
- `stt.rs`: `SttEvent` thêm `chunk_id`, `start_ms`, `end_ms`, `error`, `terminal`. Partial được gắn speaker hiện tại. Writer tự kết thúc khi engine drain xong rồi gửi `Close`. Bỏ `close_tx` (nó race với drain trong `select!`).
- `stt.rs` (Soniox handler): đọc `soniox_api_key` / `soniox_language_hints` từ DB khi query không có. `translate` nhận alias `translate_lang`. Lỗi có `terminal: true`. Khi stop thì chờ session tối đa 6s thay vì `abort()` ngay.
- `stt/soniox.rs`: end-of-audio gửi frame rỗng (finalize) thay vì đóng socket; dừng hẳn khi client stop (trước đây lại reconnect). Thêm field `tentative` (đuôi non-final). Xoay chunk tại `<end>` khi chunk ≥ 220 ký tự.
- `stt/local.rs`: partial mỗi 250ms (trước 800ms). Final có `chunk_id` + offset theo số sample đã feed.
- `stt/live_diarize.rs` + `api/mod.rs`: `/diarize-reset` reset profile speaker của live diarizer (trước là no-op nên speaker của cuộc họp trước bị mang sang cuộc sau). Load model embedding ngay khi worker khởi động.
- `lib.rs`: system audio khi stop gửi `{"type":"stop"}`, chờ reader drain rồi emit `system-audio-done`.

**Frontend (`src/`)**
- `components/recording/stt-message-reducer.ts` (mới): một reducer duy nhất cho cả WS mic lẫn event system audio.
- `use-streaming-stt.ts`: dùng reducer, thêm `drainWebSocket()`.
- `RecordingBar.tsx`: thêm `liveStatus` (`connecting/live/stopping/idle`). Stop = ngừng capture → drain WS + system audio → mới persist. Hiện trạng thái "Đang hoàn tất câu cuối...".
- `MeetingDetail.tsx`: interim hiện inline mờ ở cuối đoạn live (`LiveInterimTail`), đuôi tentative mờ. Interim đầu tiên hiện ngay, không bị empty-state che. Auto-scroll theo hành vi người dùng, có nút "Về đoạn mới nhất".
- Xoá `RecordingPanel.tsx` (dead code).

# Vấn đề thực sự

Không phải lỗi CSS. Gốc rễ là **contract bị lệch** sau khi port: Rust gửi/đọc field khác tên với frontend (`api_key`, `translate` vs `translate_lang`, `type:error` vs `error`, `"STOP"` vs `{"type":"stop"}`). Port giữ được *text* giống Python từng byte nhưng không giữ *ngữ nghĩa* các field phụ. Cộng thêm UI hiển thị interim ở một row riêng nên mỗi câu commit là một lần nhảy layout.

# Tại sao chọn cách này

- Sửa contract ở **phía Rust** (đọc DB, alias, thêm field) thay vì đổi frontend, vì frontend là nơi mọi client (WS mic, Tauri system audio) cùng phụ thuộc. Thêm field mới là thay đổi additive, không phá client cũ.
- Interim inline: final rơi đúng vị trí người dùng đang đọc nên không có layout shift.
- Warm-up + reset diarizer thay vì diarize bất đồng bộ (`speaker_correction`): diarize async cần lưu text theo từng chunk để có thể tách lại đoạn đã merge, độ phức tạp cao hơn nhiều. Sau khi warm-up, verdict thường mất khoảng vài chục ms nên budget 2,5s gần như không còn chạm tới.

# Hình dạng production

```
mic PCM ──WS──> /ws/local-stream ──> sherpa worker ──partial(250ms, +speaker)──┐
                                         └─final(+chunk_id,+ms)─> diarizer ─────┤
                                                                                 ▼
Tauri system audio ──WS──> (cùng route) ──event──> applySttMessage() ──> zustand store
Stop: ngừng capture → {"type":"stop"} → server drain → Close → FE persist
```

# Các cách khác khả thi

1. **Diarize async + `speaker_correction`**: gửi final ngay, verdict gửi sau. Text không bao giờ chờ diarize.
2. **Frontend gửi `api_key` trong URL** thay vì Rust đọc DB.
3. **Giữ row interim riêng** và chỉ animate chuyển tiếp (FLIP animation).
4. **Server tự phát marker "paragraph break"** thay vì frontend tự tách đoạn theo độ dài/khoảng lặng.

# Tại sao không chọn các cách đó

1. Diarize async: store hiện không lưu ranh giới text theo chunk trong một paragraph đã merge, nên correction sẽ đổi speaker cả đoạn. Nên chọn khi diarize thật sự chậm (CPU yếu) hoặc khi cần độ trễ text < 100ms.
2. Key trong URL: key bị lộ vào log/history của WS URL, và Python vốn đọc từ DB. Chỉ hợp lý khi server không có quyền truy cập settings.
3. FLIP animation vẫn làm mắt người dùng phải nhảy theo chữ, chỉ là mượt hơn thôi.
4. Marker từ server là cách đúng về lâu dài (server biết endpoint/silence chính xác), nhưng phải đổi contract cho cả hai provider. Heuristic ở frontend đủ tốt cho hiện tại.

# Khái niệm cốt lõi cần nắm

- **Parity text ≠ parity contract**: test byte-identical chỉ chứng minh text đúng, không chứng minh UI nhận đúng field.
- **Graceful drain**: muốn không mất câu cuối thì phải *ngừng input → báo stop → chờ server flush → server Close*, không được close ngay.
- **`tokio::select!` chọn ngẫu nhiên** giữa các nhánh đã sẵn sàng: dùng một kênh close song song với kênh data sẽ làm rơi data.
- **Narrow subscription (zustand selector)**: interim cập nhật nhiều lần mỗi giây, chỉ component nhỏ nên subscribe.
- **Singleton có state** (diarizer process-wide) phải có cơ chế reset theo session.

# Lỗi thường gặp

- Dựa vào `serde` bỏ qua field lạ: query `translate_lang` bị bỏ qua mà không báo lỗi gì.
- Auto-scroll đo khoảng cách *sau khi* content đã lớn lên: một đoạn mới cao 3 dòng là vượt threshold, auto-follow tắt mà không ai biết.
- Lưu banner trạng thái (`🔄 Đang kết nối lại...`) vào transcript vì nó dùng chung slot với `interimText`.
- Đóng WebSocket ngay sau khi gửi stop.

# Ví dụ nhỏ

```ts
// Drain đúng cách: detach trước (ngừng gửi PCM, chặn reconnect), rồi chờ server Close.
wsRef.current = null;
await new Promise<void>((resolve) => {
  const t = setTimeout(resolve, 6000);
  ws.addEventListener("close", () => { clearTimeout(t); resolve(); }, { once: true });
  ws.send(JSON.stringify({ type: "stop" }));
});
```

# Lần sau nên nghĩ thế nào

Khi port một service sang ngôn ngữ khác, viết **contract test cho mọi message shape** (error, info, stop, query param) chứ không chỉ test output chính. Trước khi chỉnh UI, kiểm tra xem "UX tệ" có phải do dữ liệu bên dưới sai hay không. Lần này phần lớn nguyên nhân nằm ở contract, không nằm ở CSS.
