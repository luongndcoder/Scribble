"""
Summarization module -- SSE streaming via LLM
Supports single-pass (short transcripts) and MapReduce (long transcripts).
"""

import os
import json
from typing import Generator

from logger import get_logger

log = get_logger(__name__)


# ── Thresholds ──
SINGLE_PASS_MAX_CHARS = 120_000  # ~30k tokens
CHUNK_CHARS = 8_000              # ~2k tokens per chunk
OVERLAP_CHARS = 500              # context overlap between chunks

# ── Prompts (all in English — output language controlled via instruction) ──

# ─── Template: MoM (Minutes of Meeting) ───
MOM_PROMPT = """You are a senior MoM (Minutes of Meeting) assistant for customer-facing teams.

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
"""

# ─── Template: General Summary ───
SUMMARY_PROMPT = """You are a professional content summarizer.

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
"""

# ─── Template: Bullet Points ───
BULLETS_PROMPT = """You are a content summarizer.

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
"""

# ─── Template registry ───
TEMPLATES = {
    "mom":     MOM_PROMPT,
    "summary": SUMMARY_PROMPT,
    "bullets": BULLETS_PROMPT,
}

# ─── Chunk/Reduce prompts (shared across templates, for MapReduce) ───
CHUNK_SUMMARY_PROMPT = """Summarize the following conversation segment. Keep key points, decisions, action items, and speaker names.
Do not add information. Return concise bullet points (max 300 words)."""

REDUCE_PROMPT = """Below are partial summaries from different segments of a long conversation.
Synthesize them into a complete summary following the required structure."""


def _chunk_transcript(transcript: str) -> list[str]:
    """Split transcript into overlapping chunks of ~CHUNK_CHARS each."""
    lines = transcript.split('\n')
    segments: list[str] = []
    current: list[str] = []
    current_len = 0

    for line in lines:
        current.append(line)
        current_len += len(line) + 1  # +1 for newline

        if current_len >= CHUNK_CHARS:
            segments.append('\n'.join(current))
            # Keep overlap for context continuity
            overlap_lines: list[str] = []
            overlap_len = 0
            for i in range(len(current) - 1, -1, -1):
                overlap_len += len(current[i]) + 1
                if overlap_len >= OVERLAP_CHARS:
                    break
                overlap_lines.insert(0, current[i])
            current = overlap_lines
            current_len = overlap_len

    # Don't forget the last chunk
    if current:
        segments.append('\n'.join(current))

    return segments


def summarize_stream(transcript: str, language: str, db, *, start_time: str = "", end_time: str = "", template: str = "mom", custom_prompt: str = "") -> Generator[str, None, None]:
    """Stream meeting summary token-by-token via SSE.
    Uses single-pass for short transcripts, MapReduce for long ones.

    Args:
        template: one of 'mom', 'summary', 'bullets', 'custom'
        custom_prompt: user-provided prompt (used when template='custom')
    """
    from openai import OpenAI

    api_key = db.get_setting("llm_api_key") or os.getenv("LLM_API_KEY", "")
    model = db.get_setting("llm_model") or os.getenv("LLM_MODEL", "gpt-4o-mini")

    # Resolve base URL using provider map (same logic as diagnose.py)
    from api.settings import _PROVIDER_URLS
    llm_provider = db.get_setting("llm_provider") or "openai"
    if llm_provider == "compatible":
        base_url = (db.get_setting("llm_base_url") or os.getenv("LLM_BASE_URL", "")).rstrip("/")
    else:
        base_url = _PROVIDER_URLS.get(llm_provider, "").rstrip("/")
    if not base_url:
        base_url = "https://api.openai.com/v1"

    if not api_key:
        yield f"event: error\ndata: {json.dumps({'error': 'LLM API key not set'})}\n\n"
        return

    client = OpenAI(api_key=api_key, base_url=base_url)

    # Select prompt based on template
    if template == "custom" and custom_prompt.strip():
        prompt = custom_prompt.strip()
        log.info("[summarize] Using custom prompt (%d chars)", len(prompt))
    else:
        prompt = TEMPLATES.get(template, TEMPLATES["mom"])
        log.info("[summarize] Using template '%s'", template)

    # Append language instruction
    lang_names = {
        "vi": "Vietnamese", "en": "English", "ja": "Japanese",
        "ko": "Korean", "zh": "Chinese", "fr": "French",
        "de": "German", "es": "Spanish", "th": "Thai",
        "id": "Indonesian", "pt": "Portuguese",
    }
    lang_name = lang_names.get(language, language)
    prompt += f"\n\nIMPORTANT: You MUST write the entire output in {lang_name}. All section headers and content must be in {lang_name}."

    # Build timestamp context
    time_context = ""
    if start_time or end_time:
        time_context = "\n\n--- Meeting Time Info ---\n"
        if start_time:
            time_context += f"Recording started: {start_time}\n"
        if end_time:
            time_context += f"Recording ended: {end_time}\n"
        time_context += "---\n"

    # ── Single-pass for short transcripts ──
    if len(transcript) < SINGLE_PASS_MAX_CHARS:
        yield from _single_pass(client, model, prompt, transcript, time_context)
        return

    # ── MapReduce for long transcripts ──
    yield from _map_reduce(client, model, prompt, transcript, language, time_context)


def _single_pass(client, model: str, prompt: str, transcript: str, time_context: str = "") -> Generator[str, None, None]:
    """Single LLM call for short transcripts."""
    try:
        yield f"event: progress\ndata: {json.dumps({'step': 'summarizing', 'progress': 0.1})}\n\n"

        user_content = f"{time_context}Transcript:\n{transcript}" if time_context else f"Transcript:\n{transcript}"
        stream = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": prompt},
                {"role": "user", "content": user_content},
            ],
            temperature=0.3,
            max_tokens=4000,
            stream=True,
        )

        for chunk in stream:
            token = chunk.choices[0].delta.content if chunk.choices[0].delta.content else None
            if token:
                yield f"data: {json.dumps({'token': token})}\n\n"

        yield f"event: done\ndata: {json.dumps({})}\n\n"
    except Exception as e:
        yield f"event: error\ndata: {json.dumps({'error': str(e)})}\n\n"


def _map_reduce(client, model: str, final_prompt: str, transcript: str, language: str, time_context: str = "") -> Generator[str, None, None]:
    """MapReduce: chunk -> summarize each -> synthesize final summary."""
    try:
        # Phase 1: Split
        chunks = _chunk_transcript(transcript)
        total = len(chunks)
        log.info("[summarize] MapReduce: %d chars -> %d chunks", len(transcript), total)

        yield f"event: progress\ndata: {json.dumps({'step': 'chunking', 'total': total})}\n\n"

        # Phase 2: Map — summarize each chunk
        partial_summaries: list[str] = []
        for i, chunk_text in enumerate(chunks):
            yield f"event: progress\ndata: {json.dumps({'step': 'analyzing', 'current': i + 1, 'total': total})}\n\n"

            response = client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": CHUNK_SUMMARY_PROMPT},
                    {"role": "user", "content": chunk_text},
                ],
                temperature=0.2,
                max_tokens=1000,
            )
            summary = response.choices[0].message.content or ""
            partial_summaries.append(f"--- Part {i + 1}/{total} ---\n{summary}")
            log.info("[summarize] chunk %d/%d done (%d chars)", i + 1, total, len(summary))

        # Phase 3: Reduce — synthesize into final summary
        yield f"event: progress\ndata: {json.dumps({'step': 'finalizing'})}\n\n"

        reduce_intro = REDUCE_PROMPT
        combined = "\n\n".join(partial_summaries)

        user_content = f"{time_context}{combined}" if time_context else combined
        stream = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": f"{final_prompt}\n\n{reduce_intro}"},
                {"role": "user", "content": user_content},
            ],
            temperature=0.3,
            max_tokens=4000,
            stream=True,
        )

        for chunk in stream:
            token = chunk.choices[0].delta.content if chunk.choices[0].delta.content else None
            if token:
                yield f"data: {json.dumps({'token': token})}\n\n"

        yield f"event: done\ndata: {json.dumps({})}\n\n"
    except Exception as e:
        log.error("[summarize] MapReduce error: %s", e)
        yield f"event: error\ndata: {json.dumps({'error': str(e)})}\n\n"
