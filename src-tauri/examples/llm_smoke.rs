//! Smoke test: drive the Rust LLM module against the real configured provider.
use voicescribe_lib::llm::{self, LlmConfig, SseEvent};

#[tokio::main]
async fn main() {
    let key = std::env::var("DS_KEY").expect("DS_KEY");
    let cfg = LlmConfig {
        api_key: key,
        model: "deepseek-v4-flash".to_string(),
        base_url: llm::provider_base_url("deepseek").to_string(),
    };
    println!("chat_url = {}", cfg.chat_url());

    // 1) Non-streaming translate (deepseek is text-only; translate is the safe probe)
    match llm::translate_instant(&cfg, "Xin chào, hôm nay chúng ta họp về ngân sách quý 4.", "en").await {
        Ok(t) => println!("TRANSLATE OK: {t}"),
        Err(e) => println!("TRANSLATE ERR: {e}"),
    }

    // 2) Streaming completion — verify the SSE frame contract
    let mut frames: Vec<String> = Vec::new();
    let r = llm::complete_streaming(&cfg, "Trả lời ngắn gọn.", "Tóm tắt ngắn: họp về ngân sách quý 4, chốt tăng 15%.", Some(2048), |d| {
        frames.push(d.to_string());
    }).await;
    match r {
        Ok(()) => {
            let joined: String = frames.concat();
            println!("STREAM OK: {} deltas -> {:?}", frames.len(), joined.trim());
        }
        Err(e) => println!("STREAM ERR: {e}"),
    }

    // 3) SSE wire format
    let ev = SseEvent::new("chunk", serde_json::json!({"text":"xin chào"}));
    println!("SSE WIRE: {:?}", ev.to_wire());

    // 4) chunking on a long transcript
    let long = "nội dung cuộc họp rất dài\n".repeat(3000);
    let chunks = llm::chunk_transcript(&long);
    println!("CHUNKING: {} chars -> {} chunks", long.len(), chunks.len());
}
