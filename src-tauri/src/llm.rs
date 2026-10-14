//! LLM client — summarization (SSE streaming) and translation.
//!
//! Ported from `src-python/summarize.py` + `src-python/translate.py`. All
//! providers speak the OpenAI-compatible chat-completions API, so a single
//! client covers openai/deepseek/groq/mistral/openrouter/gemini/compatible.
//!
//! The SSE wire format is a hard contract with the frontend (`src/lib/sse.ts`):
//! `event: <name>\ndata: <json>\n\n`. Event names used: `chunk`, `progress`,
//! `done`, `error`. Changing them breaks summary rendering.

use futures_util::StreamExt;
use serde::Serialize;
use serde_json::json;

/// How much transcript text goes into one MapReduce chunk.
const CHUNK_CHARS: usize = 15_000;
/// Overlap carried between chunks so context isn't lost at the seam.
const OVERLAP_CHARS: usize = 1_000;
/// Transcripts shorter than this go through a single pass; longer ones use
/// MapReduce. Python's `SINGLE_PASS_MAX_CHARS = 120_000` (~30k tokens) — the
/// point where a single prompt would start losing fidelity to truncation.
const SINGLE_PASS_MAX_CHARS: usize = 120_000;
/// Group N chunk summaries into one section summary before the final reduce.
/// Python's `SECTION_GROUP_SIZE = 4` (hierarchical reduce).
const SECTION_GROUP_SIZE: usize = 4;

/// Base URL per provider (mirrors `api/settings.py::_PROVIDER_URLS`).
pub fn provider_base_url(provider: &str) -> &'static str {
    match provider {
        "openai" => "https://api.openai.com/v1",
        "mistral" => "https://api.mistral.ai/v1",
        "groq" => "https://api.groq.com/openai/v1",
        "deepseek" => "https://api.deepseek.com/v1",
        "openrouter" => "https://openrouter.ai/api/v1",
        "gemini" => "https://generativelanguage.googleapis.com/v1beta/openai",
        _ => "https://api.openai.com/v1",
    }
}

/// Map an app language code to the name we tell the model to write in.
fn language_name(code: &str) -> &str {
    match code {
        "vi" => "Vietnamese",
        "en" => "English",
        "ja" => "Japanese",
        "ko" => "Korean",
        "zh" => "Chinese",
        "fr" => "French",
        "de" => "German",
        "es" => "Spanish",
        "th" => "Thai",
        "id" => "Indonesian",
        "pt" => "Portuguese",
        other => other,
    }
}

/// A resolved LLM endpoint. Built from DB settings by the caller so this
/// module never touches storage directly.
#[derive(Debug, Clone)]
pub struct LlmConfig {
    pub api_key: String,
    pub model: String,
    pub base_url: String,
}

impl LlmConfig {
    pub fn chat_url(&self) -> String {
        format!("{}/chat/completions", self.base_url.trim_end_matches('/'))
    }
}

/// One SSE frame ready to be written to the HTTP response body.
#[derive(Debug, Clone)]
pub struct SseEvent {
    pub event: String,
    pub data: serde_json::Value,
}

impl SseEvent {
    pub fn new(event: &str, data: serde_json::Value) -> Self {
        Self { event: event.to_string(), data }
    }

    /// Render to the wire format the frontend parser expects.
    ///
    /// Two details are load-bearing and were both wrong before:
    ///
    ///  * **`token`, not `text`.** `src/lib/sse.ts` only ever calls
    ///    `onToken` for `payload.json?.token`. A `{"text": ...}` frame parses
    ///    fine but is silently ignored, so `/summarize` produced a complete
    ///    summary that rendered as an empty string in the UI.
    ///  * **Python's `json.dumps` separators.** Python emitted
    ///    `{"token": " Bi"}` with a space after the colon; `serde_json`'s
    ///    `Display` emits `{"token":" Bi"}`. The parser is whitespace
    ///    tolerant, so this is cosmetic — but the wire bytes are a documented
    ///    contract and diffs are easier to read when they match exactly.
    pub fn to_wire(&self) -> String {
        // `crate::api::pyjson::dumps` is the crate's CPython-compatible
        // serialiser (`, ` / `: ` separators), reused here so the SSE bytes
        // match Python's `json.dumps` exactly rather than serde's compact form.
        format!(
            "event: {}\ndata: {}\n\n",
            self.event,
            crate::api::pyjson::dumps(&self.data)
        )
    }
}

#[derive(Serialize)]
struct ChatMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: Vec<ChatMessage<'a>>,
    temperature: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
    stream: bool,
}

/// HTTP client for LLM calls.
///
/// No TOTAL timeout: a long minutes stream (8-16k tokens, slow or reasoning
/// models) legitimately runs for many minutes, and a whole-request deadline cut
/// it off mid-document. Instead, like the OpenAI SDK Python used
/// (`httpx.Timeout(600, connect=5)`), bound the connect and each read — a
/// stalled connection still fails, a slow-but-alive one does not.
fn llm_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .read_timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())
}

/// Non-streaming completion. Returns the assistant text.
pub async fn complete(
    cfg: &LlmConfig,
    system: &str,
    user: &str,
    max_tokens: Option<u32>,
) -> Result<String, String> {
    complete_with_temperature(cfg, system, user, max_tokens, 0.3).await
}

/// [`complete`] with an explicit temperature — the MapReduce map/section steps
/// use 0.2, as in Python.
async fn complete_with_temperature(
    cfg: &LlmConfig,
    system: &str,
    user: &str,
    max_tokens: Option<u32>,
    temperature: f32,
) -> Result<String, String> {
    let client = llm_client()?;

    let body = ChatRequest {
        model: &cfg.model,
        messages: vec![
            ChatMessage { role: "system", content: system },
            ChatMessage { role: "user", content: user },
        ],
        temperature,
        max_tokens,
        stream: false,
    };

    let resp = client
        .post(cfg.chat_url())
        .bearer_auth(&cfg.api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;

    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("LLM HTTP {status}: {}", truncate(&text, 300)));
    }

    let parsed: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("bad JSON from LLM: {e}"))?;
    if parsed["choices"][0].is_null() {
        return Err("LLM response had no choices".to_string());
    }
    // `content` is null when a reasoning model spends the whole budget on
    // `reasoning_content`. Python took `content or ""` and carried on, so one
    // thin chunk summary does not abort a 3-hour MapReduce.
    Ok(parsed["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .to_string())
}

/// Streaming completion — calls `on_chunk` for each token delta.
///
/// Kept callback-based rather than returning a stream so the caller (an axum
/// SSE handler) can push into its own channel without lifetime gymnastics.
///
/// REASONING-MODEL CAVEAT (measured 2026-10-09 against deepseek-v4-flash):
/// these models stream `reasoning_content` first while `content` stays null.
/// A small `max_tokens` is consumed ENTIRELY by that reasoning phase and the
/// visible answer never arrives:
///     max_tokens=50  -> content deltas 0,  reasoning deltas 50
///     max_tokens=200 -> content deltas 15, reasoning deltas 76
///     max_tokens=8192 -> content deltas 22 (answer complete)
/// So callers MUST pass a generous budget (summarize uses 8192). This is also
/// why we never stream `reasoning_content`: it is the model's private
/// scratchpad, and emitting it would fill summaries with chain-of-thought.
pub async fn complete_streaming<F>(
    cfg: &LlmConfig,
    system: &str,
    user: &str,
    max_tokens: Option<u32>,
    mut on_chunk: F,
) -> Result<(), String>
where
    F: FnMut(&str),
{
    let client = llm_client()?;

    let body = ChatRequest {
        model: &cfg.model,
        messages: vec![
            ChatMessage { role: "system", content: system },
            ChatMessage { role: "user", content: user },
        ],
        temperature: 0.3,
        max_tokens,
        stream: true,
    };

    let resp = client
        .post(cfg.chat_url())
        .bearer_auth(&cfg.api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("LLM HTTP {status}: {}", truncate(&text, 300)));
    }

    let mut stream = resp.bytes_stream();
    let mut lines = SseLineBuffer::default();
    while let Some(item) = stream.next().await {
        let bytes = item.map_err(|e| format!("stream error: {e}"))?;
        for line in lines.push(&bytes) {
            if handle_stream_line(&line, &mut on_chunk) {
                return Ok(());
            }
        }
    }
    // A server that closes without a trailing newline still sent a last line.
    if let Some(line) = lines.finish() {
        handle_stream_line(&line, &mut on_chunk);
    }
    Ok(())
}

/// Splits a byte stream into complete lines, decoding UTF-8 only per line.
///
/// Network chunks cut anywhere — including inside a multi-byte character
/// ("ạ" is 3 bytes). Decoding each chunk on its own turned both halves into
/// U+FFFD, so Vietnamese minutes came out with random "�". `\n` never occurs
/// inside a UTF-8 sequence, so a complete line is always decodable.
#[derive(Default)]
struct SseLineBuffer {
    buf: Vec<u8>,
}

impl SseLineBuffer {
    fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(bytes);
        let mut out = Vec::new();
        while let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=pos).collect();
            out.push(String::from_utf8_lossy(&line).into_owned());
        }
        out
    }

    fn finish(self) -> Option<String> {
        (!self.buf.is_empty()).then(|| String::from_utf8_lossy(&self.buf).into_owned())
    }
}

/// Handle one line of the provider's SSE stream. Returns true on `[DONE]`.
fn handle_stream_line<F: FnMut(&str)>(line: &str, on_chunk: &mut F) -> bool {
    let line = line.trim();
    let Some(payload) = line.strip_prefix("data:") else { return false };
    let payload = payload.trim();
    if payload == "[DONE]" {
        return true;
    }
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(payload) {
        let delta = &v["choices"][0]["delta"];
        // Only `content` is user-facing. Reasoning models (DeepSeek v4,
        // o-series) stream chain-of-thought in `reasoning_content`
        // FIRST and keep `content` null during that phase — verified:
        // a short prompt produced 55 reasoning deltas then 4 content
        // deltas. Streaming `reasoning_content` would dump the model's
        // private scratchpad into the summary. So we ignore it and
        // simply wait for `content` to start.
        if let Some(text) = delta["content"].as_str() {
            if !text.is_empty() {
                on_chunk(text);
            }
        }
    }
    false
}

fn truncate(s: &str, n: usize) -> String {
    if s.len() <= n {
        s.to_string()
    } else {
        format!("{}…", &s[..s.floor_char_boundary(n)])
    }
}

// ── Prompt templates (ported from summarize.py) ──────────────────────────────

const MOM_PROMPT: &str = r#"You are a senior MoM (Minutes of Meeting) assistant for customer-facing teams.

MoM Goals:
- Not just a transcript recap, but a communication tool for risk management and stakeholder expectation alignment.
- Readers include both meeting attendees and non-attendees.

Required content:
1. Time & attendees (include roles when possible).
2. Original recording link.
3. Meeting objective: problem/root cause and expected output.
4. Key discussion points: filter important ideas only, no rambling transcript.
5. Key decisions made.
6. Action items following What - Who - When (task, PIC/owner, deadline/checkpoint).

For external meetings (with customers), clarify:
- 1-3 points the customer must remember or act on.
- Risk forecasts/warnings that may affect action items.
- Tone: professional, objective, sharp, persuasive.

For internal meetings, add:
- Customer Insights & Politics: stakeholder attitudes, who supports/who blocks.
- Game Plan: strategy and preparation for the next meeting.
- Writer's notes: personal observations/assessments for internal awareness.
- Implicit info: important unspoken context for MoM readers.
- Tone: detailed, candid, no sugarcoating.

Quality rules:
- Do not invent facts. If data is missing, write "No data available".
- Do not list the entire transcript; keep only key content.
- Emphasize urgency/risk levels accurately.

Output requirements:
- Return readable Markdown.
- First line must be: `# <Short minutes title>`.
- Use this exact structure:
## 1. Time & Attendees
## 2. Original Recording Link
## 3. Meeting Objective
## 4. Key Discussion
## 5. Key Decisions
## 6. Action Items (What - Who - When)
## 7. Risks & Warnings
## 8. External MoM (if customer-facing; otherwise "N/A")
## 9. Internal MoM (insights/politics, game plan, notes, implicit info)
## 10. Top 1-3 Immediate Follow-ups
"#;

const SUMMARY_PROMPT: &str = r#"You are a professional content summarizer.

Write a detailed, comprehensive summary of the recording/conversation below.
Do NOT use meeting minutes (MoM) format. Instead:

1. Start with a short title reflecting the main topic: `# <Title>`
2. Write a brief overview (2-3 sentences) describing the overall content.
3. Present key points in logical order, each as a paragraph or bullet group.
4. Preserve speaker names and roles when available.
5. Don't omit important information, but don't transcribe every sentence either.
6. If there are decisions, action items, or critical info — highlight them clearly.

Rules:
- Do not invent facts. If missing, write "No data available".
- Return Markdown only.
- Keep it clear, readable, and professional.
"#;

const BULLETS_PROMPT: &str = r#"You are a content summarizer.

Summarize the recording/conversation below as a concise list of key points (bullet points).

Requirements:
1. First line: `# <Short title>`
2. List key points as bullets (`-`), grouped by topic if needed.
3. Each bullet should be concise and clear (1-2 sentences max).
4. Preserve speaker names when relevant.
5. If there are decisions or action items, separate them into `## Decisions` and `## Action Items`.

Rules:
- Do not invent facts. If missing, write "No data available".
- Return Markdown only.
- Maximum 30 bullet points.
"#;

const DEEP_ANALYSIS_PROMPT: &str = r#"You are an expert meeting analyst who produces exhaustive, timestamp-level meeting analysis.

Your output must be a comprehensive document that captures EVERYTHING discussed, organized chronologically by topic sections.

## Required format for EACH section:

### PHẦN N: <Section Title> (start_time → end_time)

#### Nội dung chính
For each significant statement, write:
**[timestamp range] Speaker Name** — What they said/proposed/decided.
- Use exact quotes when the statement is important (wrap in > blockquote)
- Include reasoning, context, and nuance — not just conclusions
- Capture back-and-forth discussions, disagreements, and resolutions

#### Vấn đề phát hiện
List problems, concerns, mistakes, or confusion that emerged:
- What was the issue
- Who raised it
- Direct quote if impactful
- Use > blockquote for critical feedback

#### Điểm kỹ thuật rút ra
Summary table of key technical decisions/facts from this section:
| Thông tin | Giá trị/Ghi chú |
|-----------|-----------------|
| ... | ... |

## Rules:
1. **Chronological order** — follow the meeting flow, section by section
2. **Every decision must be captured** with who decided and why
3. **Every action item** with What - Who - When
4. **Disagreements/feedback** — capture exact quotes, especially critical feedback
5. **Speaker attribution** — always name who said what
6. **Timestamp references** — use [MM:SS] or [HH:MM:SS] format from transcript
7. **Do NOT summarize away details** — this is an ANALYSIS, not a summary
8. **Tables for structured data** — use markdown tables for comparisons, specs, decisions
9. Start with:
   - `# <Meeting Title>`
   - Date, duration, attendees with roles
   - Brief meeting purpose (2-3 sentences)
10. End with:
    - `## Tổng kết & Action Items` — master list of all action items
    - `## Vấn đề mở` — unresolved questions

Output length: Be as detailed as needed. A 2-hour meeting should produce 500-700 lines of analysis.
"#;

const CHUNK_SUMMARY_PROMPT: &str = r#"Summarize the following conversation segment in detail. You MUST preserve:
- ALL key points, arguments, and reasoning (not just conclusions)
- ALL decisions made with context on why
- ALL action items with assignee and deadline if mentioned
- Speaker names and their positions/opinions
- Numbers, dates, metrics mentioned
- Disagreements, concerns, or risks raised

Do not add information not present. Write in structured bullet points.
Be thorough — this summary will be used to produce the final meeting minutes.
Aim for 400-600 words."#;

const SECTION_REDUCE_PROMPT: &str = r#"Below are detailed summaries from consecutive segments of a meeting.
Merge them into a coherent section summary that:
- Preserves ALL key details, decisions, and action items
- Removes only exact duplicates from overlapping segments
- Maintains chronological flow
- Keeps speaker attributions

Be comprehensive. This intermediate summary feeds into the final minutes."#;

/// Deep-analysis map step — keeps timestamps and verbatim quotes.
const DEEP_CHUNK_PROMPT: &str = r#"Analyze this conversation segment in exhaustive detail.

For each significant exchange, write:
**[timestamp] Speaker** — What they said, decided, or proposed.
- Include direct quotes for important statements (use > blockquote)
- Capture disagreements, corrections, and feedback verbatim
- Note decisions, action items, numbers, and technical details

Preserve ALL timestamps from the transcript. Do NOT summarize — ANALYZE.
Output: structured markdown, 600-1000 words."#;

/// Deep-analysis section reduce step.
const DEEP_SECTION_REDUCE_PROMPT: &str = r#"Merge these detailed segment analyses into a coherent section.
Preserve ALL timestamps, quotes, speaker attributions, and details.
Remove only exact duplicates from overlapping segments.
Organize chronologically. Do NOT compress or summarize away details."#;

const FINAL_REDUCE_PROMPT: &str = r#"Below are section summaries from a long meeting.
Synthesize them into complete, comprehensive meeting minutes following the required structure.

IMPORTANT:
- Do NOT over-compress. A 4-hour meeting should produce detailed minutes.
- Every decision, action item, and key discussion point must appear.
- If sections contain different topics, cover ALL of them.
- Use the full output length available."#;

/// Resolve the prompt for a template id.
fn template_prompt(template: &str, custom_prompt: &str) -> String {
    if template == "custom" && !custom_prompt.trim().is_empty() {
        return custom_prompt.trim().to_string();
    }
    match template {
        "summary" => SUMMARY_PROMPT,
        "bullets" => BULLETS_PROMPT,
        "deep" => DEEP_ANALYSIS_PROMPT,
        _ => MOM_PROMPT,
    }
    .to_string()
}

/// Split a long transcript into overlapping chunks (mirrors `_chunk_transcript`).
pub fn chunk_transcript(transcript: &str) -> Vec<String> {
    let lines: Vec<&str> = transcript.split('\n').collect();
    let mut segments: Vec<String> = Vec::new();
    let mut current: Vec<&str> = Vec::new();
    let mut current_len = 0usize;

    // Lengths are CHARACTERS, as Python's `len(str)`. Byte length counts most
    // Vietnamese letters 2-3x, which made chunks half the intended size and
    // doubled the number of map calls.
    for line in lines {
        current.push(line);
        current_len += line.chars().count() + 1;

        if current_len >= CHUNK_CHARS {
            segments.push(current.join("\n"));
            // Carry a tail of overlap so the next chunk has context.
            let mut overlap: Vec<&str> = Vec::new();
            let mut overlap_len = 0usize;
            for l in current.iter().rev() {
                overlap_len += l.chars().count() + 1;
                if overlap_len >= OVERLAP_CHARS {
                    break;
                }
                overlap.insert(0, l);
            }
            current = overlap;
            current_len = overlap_len;
        }
    }
    if !current.is_empty() {
        segments.push(current.join("\n"));
    }
    segments
}

/// Extra context injected around the transcript, mirroring the pieces
/// `summarize.py::summarize_stream` threads through to its prompts.
///
/// Both fields are full pre-rendered blocks (see `api::transcription`), because
/// the formatting rules — the `--- Meeting Time Info ---` fence and the
/// REFERENCE MATERIALS framing — are presentation concerns that belong with the
/// HTTP layer, not the LLM client.
#[derive(Debug, Clone, Default)]
pub struct SummaryContext {
    /// `--- Meeting Time Info ---` block, or "" when no times were supplied.
    pub time_context: String,
    /// Attachment block for the user-content layer, or "".
    pub reference_context: String,
    /// System-level reminder that the attached reference materials are
    /// authoritative, or "".
    ///
    /// Python added this separately from `reference_context` and the comment
    /// there explains why: user-content alone was not enough, because the model
    /// treats it as conversational data and skims it. Restating the instruction
    /// at the system level is what made the attachments actually get used.
    pub reference_system_note: String,
}

/// Summarize a transcript, emitting SSE frames through `emit`.
///
/// Single-pass for short transcripts; MapReduce (chunk → summarize each →
/// reduce) for long ones, matching the Python behaviour.
///
/// Thin wrapper over [`summarize_stream_with_context`] with no extra context,
/// kept so existing callers keep compiling unchanged.
pub async fn summarize_stream<F>(
    cfg: &LlmConfig,
    transcript: &str,
    language: &str,
    template: &str,
    custom_prompt: &str,
    emit: F,
) -> Result<(), String>
where
    F: FnMut(SseEvent),
{
    summarize_stream_with_context(
        cfg,
        transcript,
        language,
        template,
        custom_prompt,
        SummaryContext::default(),
        emit,
    )
    .await
}

/// Summarize with meeting-time and reference-material context.
pub async fn summarize_stream_with_context<F>(
    cfg: &LlmConfig,
    transcript: &str,
    language: &str,
    template: &str,
    custom_prompt: &str,
    ctx: SummaryContext,
    mut emit: F,
) -> Result<(), String>
where
    F: FnMut(SseEvent),
{
    let mut prompt = template_prompt(template, custom_prompt);
    prompt.push_str(&format!(
        "\n\nIMPORTANT: You MUST write the entire output in {}. All section headers and content must be in {}.",
        language_name(language),
        language_name(language)
    ));

    // Raise the attached documents' importance at the SYSTEM level too.
    // Python did this in addition to the user-content block because
    // user-content alone was not enough — the model treated it as
    // conversational data and skimmed it, producing minutes identical to a run
    // with no attachments at all.
    if !ctx.reference_system_note.is_empty() {
        prompt.push_str(&ctx.reference_system_note);
    }

    // Reference materials + time info go in front of the transcript so the
    // model reads them as setup before the conversation it must summarize.
    let prefix = format!("{}{}", ctx.time_context, ctx.reference_context);
    let is_deep = template == "deep";

    // ── Single pass for short transcripts ──
    // Python switched on CHARACTER COUNT, not chunk count: everything under
    // SINGLE_PASS_MAX_CHARS went through one call, and only longer transcripts
    // took the MapReduce path. Gating on `chunks.len() > 1` instead would send
    // a 119k-char meeting through MapReduce, which changes both the output
    // structure and the cost.
    if transcript.chars().count() < SINGLE_PASS_MAX_CHARS {
        emit(SseEvent::new("progress", json!({ "step": "summarizing", "progress": 0.1 })));
        let mut errored = false;
        // Python always built `f"{prefix}Transcript:\n{transcript}"` — the
        // label tells the model where the conversation starts, prefix or not.
        let user_content = format!("{prefix}Transcript:\n{transcript}");
        let max_tokens = if is_deep { 16_000 } else { 8_000 };
        complete_streaming(cfg, &prompt, &user_content, Some(max_tokens), |delta| {
            emit(SseEvent::new("chunk", json!({ "token": delta })));
        })
        .await
        .unwrap_or_else(|e| {
            errored = true;
            emit(SseEvent::new("error", json!({ "error": e })));
        });
        if !errored {
            emit(SseEvent::new("done", json!({})));
        }
        return Ok(());
    }

    // ── MapReduce for long transcripts ──
    // Phase 1: split. Phase 2: map (per chunk). Phase 3: section reduce, only
    // when there are more chunks than one section can hold. Phase 4: final
    // reduce, which is the only phase that streams.
    let chunks = chunk_transcript(transcript);
    let total = chunks.len();
    emit(SseEvent::new("progress", json!({ "step": "chunking", "total": total })));

    // Phase 2 — map. Deep analysis keeps timestamps and quotes, so it uses a
    // different prompt and a larger token budget.
    let map_prompt = if is_deep { DEEP_CHUNK_PROMPT } else { CHUNK_SUMMARY_PROMPT };
    let map_max_tokens = if is_deep { 4_000 } else { 2_000 };
    let mut chunk_summaries: Vec<String> = Vec::new();
    for (i, chunk_text) in chunks.iter().enumerate() {
        emit(SseEvent::new(
            "progress",
            json!({ "step": "analyzing", "current": i + 1, "total": total }),
        ));
        let user = format!("Segment {}/{total}:\n\n{chunk_text}", i + 1);
        let summary =
            complete_with_temperature(cfg, map_prompt, &user, Some(map_max_tokens), 0.2).await?;
        chunk_summaries.push(summary);
    }

    // Phase 3 — hierarchical section reduce, only for many chunks.
    let combined_for_final = if total > SECTION_GROUP_SIZE {
        emit(SseEvent::new("progress", json!({ "step": "consolidating" })));
        let section_prompt = if is_deep {
            DEEP_SECTION_REDUCE_PROMPT
        } else {
            SECTION_REDUCE_PROMPT
        };
        let section_max_tokens = if is_deep { 6_000 } else { 3_000 };

        let mut section_summaries: Vec<String> = Vec::new();
        for g in (0..total).step_by(SECTION_GROUP_SIZE) {
            let end = (g + SECTION_GROUP_SIZE).min(total);
            let group = &chunk_summaries[g..end];
            let group_label = format!("Segments {}-{}/{}", g + 1, end, total);
            let combined_group = group
                .iter()
                .enumerate()
                .map(|(j, s)| format!("--- Segment {} ---\n{s}", g + j + 1))
                .collect::<Vec<_>>()
                .join("\n\n");

            let user = format!("{group_label}:\n\n{combined_group}");
            let section = complete_with_temperature(
                cfg,
                section_prompt,
                &user,
                Some(section_max_tokens),
                0.2,
            )
            .await?;
            section_summaries.push(format!("## Section: {group_label}\n{section}"));
        }
        section_summaries.join("\n\n")
    } else {
        // Few chunks — skip the section reduce entirely.
        chunk_summaries
            .iter()
            .enumerate()
            .map(|(i, s)| format!("--- Part {}/{total} ---\n{s}", i + 1))
            .collect::<Vec<_>>()
            .join("\n\n")
    };

    // Phase 4 — final reduce, streamed to the client.
    emit(SseEvent::new("progress", json!({ "step": "finalizing" })));
    let mut errored = false;
    // Python appended FINAL_REDUCE_PROMPT to the template for this phase, and
    // prefixed the reduce input with time + reference context.
    let reduce_system = format!("{prompt}\n\n{FINAL_REDUCE_PROMPT}");
    let reduce_input = if prefix.is_empty() {
        combined_for_final
    } else {
        format!("{prefix}{combined_for_final}")
    };
    let final_max_tokens = if is_deep { 16_000 } else { 8_000 };
    complete_streaming(cfg, &reduce_system, &reduce_input, Some(final_max_tokens), |delta| {
        emit(SseEvent::new("chunk", json!({ "token": delta })));
    })
    .await
    .unwrap_or_else(|e| {
        errored = true;
        emit(SseEvent::new("error", json!({ "error": e })));
    });
    if !errored {
        emit(SseEvent::new("done", json!({})));
    }
    Ok(())
}

// ── Translation ──────────────────────────────────────────────────────────────

const TRANSLATE_SYSTEM: &str = r#"You are a professional translator for meeting transcripts.
Translate the user's text faithfully, preserving meaning, tone, names,
numbers and technical terms. Output ONLY the translation — no notes,
no explanations, no quotes around it. If the text is already in the target
language, return it unchanged."#;

/// Translate a single piece of text (used for the live bilingual column).
pub async fn translate_instant(
    cfg: &LlmConfig,
    text: &str,
    target_lang: &str,
) -> Result<String, String> {
    if text.trim().is_empty() {
        return Ok(String::new());
    }
    let user = format!(
        "Translate to {}:\n\n{}",
        language_name(target_lang),
        text
    );
    let out = complete(cfg, TRANSLATE_SYSTEM, &user, Some(4096)).await?;
    Ok(out.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_wire_format_matches_frontend_contract() {
        let ev = SseEvent::new("chunk", json!({ "token": "xin chào" }));
        // Python emitted `data: {"token": "xin chào"}` — space after the colon.
        assert_eq!(ev.to_wire(), "event: chunk\ndata: {\"token\": \"xin chào\"}\n\n");
    }

    /// The frame must carry `token`, because `src/lib/sse.ts` only fires
    /// `onToken` for `payload.json?.token`. A `text` field parses fine and is
    /// then silently dropped, leaving the summary UI blank.
    #[test]
    fn chunk_frames_use_the_token_field_the_frontend_reads() {
        let ev = SseEvent::new("chunk", json!({ "token": "abc" }));
        assert!(ev.to_wire().contains("\"token\""));
        assert!(!ev.to_wire().contains("\"text\""));
    }

    /// `done` frames carry an empty object, exactly as Python sent `{}`.
    #[test]
    fn done_frame_is_an_empty_object() {
        assert_eq!(
            SseEvent::new("done", json!({})).to_wire(),
            "event: done\ndata: {}\n\n"
        );
    }

    /// Network chunks split "ạ" (3 bytes) in the middle; the token must still
    /// arrive intact, not as two U+FFFD.
    #[test]
    fn multibyte_char_split_across_network_chunks_stays_intact() {
        let wire = "data: {\"choices\":[{\"delta\":{\"content\":\"Biên bản cuộc họp ạ\"}}]}\ndata: [DONE]\n";
        let bytes = wire.as_bytes();
        let cut = wire.find('ạ').unwrap() + 1; // inside the 3-byte sequence
        let mut buf = SseLineBuffer::default();
        let mut got = String::new();
        let mut done = false;
        for part in [&bytes[..cut], &bytes[cut..]] {
            for line in buf.push(part) {
                done |= handle_stream_line(&line, &mut |t: &str| got.push_str(t));
            }
        }
        assert!(done);
        assert_eq!(got, "Biên bản cuộc họp ạ");
    }

    /// Chunk size is measured in characters like Python's `len()`, so
    /// Vietnamese text does not produce twice as many map calls.
    #[test]
    fn chunk_size_counts_characters_not_bytes() {
        // 50 chars, ~70 bytes per line.
        let line = "nội dung cuộc họp tiếng việt có dấu đầy đủ ở đây.";
        let transcript = vec![line; 1200].join("\n"); // ~61k chars
        let chunks = chunk_transcript(&transcript);
        assert_eq!(chunks.len(), 5, "61k chars / 15k ≈ 5 chunks, got {}", chunks.len());
    }

    #[test]
    fn short_transcript_is_a_single_chunk() {
        let chunks = chunk_transcript("dòng một\ndòng hai");
        assert_eq!(chunks.len(), 1);
        assert!(chunks[0].contains("dòng một"));
    }

    #[test]
    fn long_transcript_splits_with_overlap() {
        let line = "nội dung cuộc họp khá dài để vượt ngưỡng chunk\n";
        let transcript = line.repeat(2000);
        let chunks = chunk_transcript(&transcript);
        assert!(chunks.len() > 1, "expected multiple chunks, got {}", chunks.len());
        // Overlap means consecutive chunks share a line.
        let first_tail: Vec<&str> = chunks[0].split('\n').rev().take(3).collect();
        let second_head: Vec<&str> = chunks[1].split('\n').take(5).collect();
        assert!(
            first_tail.iter().any(|t| second_head.contains(t)),
            "chunks should overlap at the seam"
        );
    }

    #[test]
    fn custom_template_wins_when_provided() {
        let p = template_prompt("custom", "  tóm tắt ngắn gọn  ");
        assert_eq!(p, "tóm tắt ngắn gọn");
    }

    /// The prompt texts are a user-visible product contract: the MoM template
    /// is the customer-facing minutes format with mandated sections. Each of
    /// these was previously an abbreviated rewrite, which silently changed the
    /// document users received. Pin a distinctive phrase from every prompt so
    /// a future edit that "tidies up" the wording fails loudly instead of
    /// quietly changing the deliverable.
    #[test]
    fn prompt_texts_match_the_python_originals() {
        // MoM: the 10 mandated section headings.
        assert!(MOM_PROMPT.contains("## 1. Time & Attendees"));
        assert!(MOM_PROMPT.contains("## 8. External MoM"));
        assert!(MOM_PROMPT.contains("## 10. Top 1-3 Immediate Follow-ups"));
        assert!(MOM_PROMPT.contains("You are a senior MoM (Minutes of Meeting) assistant"));
        // The templates are distinct documents, not one shared blob.
        assert!(SUMMARY_PROMPT.contains("Do NOT use meeting minutes (MoM) format"));
        assert!(BULLETS_PROMPT.contains("Maximum 30 bullet points"));
        assert!(DEEP_ANALYSIS_PROMPT.contains("#### Vấn đề phát hiện"));
        assert!(DEEP_ANALYSIS_PROMPT.contains("500-700 lines of analysis"));
        // MapReduce steps.
        assert!(CHUNK_SUMMARY_PROMPT.contains("Aim for 400-600 words"));
        assert!(SECTION_REDUCE_PROMPT.contains("This intermediate summary feeds into the final minutes"));
        assert!(FINAL_REDUCE_PROMPT.contains("Do NOT over-compress"));
        assert!(DEEP_CHUNK_PROMPT.contains("600-1000 words"));
        assert!(DEEP_SECTION_REDUCE_PROMPT.contains("Do NOT compress or summarize away details"));
    }

    /// Python routed on character count (120k), not chunk count. A transcript
    /// just under the limit must stay single-pass: sending it through MapReduce
    /// would change both the output structure and the API cost.
    #[test]
    fn single_pass_threshold_matches_python() {
        assert_eq!(SINGLE_PASS_MAX_CHARS, 120_000);
        assert_eq!(CHUNK_CHARS, 15_000);
        assert_eq!(OVERLAP_CHARS, 1_000);
        assert_eq!(SECTION_GROUP_SIZE, 4);
    }

    #[test]
    fn unknown_template_falls_back_to_mom() {
        let p = template_prompt("nonsense", "");
        assert!(p.contains("Minutes of Meeting") || p.contains("meeting-minutes"));
    }

    #[test]
    fn language_names_are_mapped() {
        assert_eq!(language_name("vi"), "Vietnamese");
        assert_eq!(language_name("en"), "English");
        assert_eq!(language_name("xx"), "xx");
    }
}
