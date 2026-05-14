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
CHUNK_CHARS = 15_000             # ~3.5k tokens per chunk (larger = better context)
OVERLAP_CHARS = 1_000            # context overlap between chunks
SECTION_GROUP_SIZE = 4           # group N chunk summaries into 1 section (hierarchical reduce)

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

# ─── Template: Deep Analysis (timestamp-level detail) ───
DEEP_ANALYSIS_PROMPT = """You are an expert meeting analyst who produces exhaustive, timestamp-level meeting analysis.

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
"""

# ─── Template registry ───
TEMPLATES = {
    "mom":      MOM_PROMPT,
    "summary":  SUMMARY_PROMPT,
    "bullets":  BULLETS_PROMPT,
    "deep":     DEEP_ANALYSIS_PROMPT,
}

# ─── Deep Analysis chunk prompt (preserves timestamps + quotes) ───
DEEP_CHUNK_PROMPT = """Analyze this conversation segment in exhaustive detail.

For each significant exchange, write:
**[timestamp] Speaker** — What they said, decided, or proposed.
- Include direct quotes for important statements (use > blockquote)
- Capture disagreements, corrections, and feedback verbatim
- Note decisions, action items, numbers, and technical details

Preserve ALL timestamps from the transcript. Do NOT summarize — ANALYZE.
Output: structured markdown, 600-1000 words."""

DEEP_SECTION_REDUCE_PROMPT = """Merge these detailed segment analyses into a coherent section.
Preserve ALL timestamps, quotes, speaker attributions, and details.
Remove only exact duplicates from overlapping segments.
Organize chronologically. Do NOT compress or summarize away details."""

# ─── Chunk/Reduce prompts (shared across templates, for MapReduce) ───
CHUNK_SUMMARY_PROMPT = """Summarize the following conversation segment in detail. You MUST preserve:
- ALL key points, arguments, and reasoning (not just conclusions)
- ALL decisions made with context on why
- ALL action items with assignee and deadline if mentioned
- Speaker names and their positions/opinions
- Numbers, dates, metrics mentioned
- Disagreements, concerns, or risks raised

Do not add information not present. Write in structured bullet points.
Be thorough — this summary will be used to produce the final meeting minutes.
Aim for 400-600 words."""

SECTION_REDUCE_PROMPT = """Below are detailed summaries from consecutive segments of a meeting.
Merge them into a coherent section summary that:
- Preserves ALL key details, decisions, and action items
- Removes only exact duplicates from overlapping segments
- Maintains chronological flow
- Keeps speaker attributions

Be comprehensive. This intermediate summary feeds into the final minutes."""

FINAL_REDUCE_PROMPT = """Below are section summaries from a long meeting.
Synthesize them into complete, comprehensive meeting minutes following the required structure.

IMPORTANT:
- Do NOT over-compress. A 4-hour meeting should produce detailed minutes.
- Every decision, action item, and key discussion point must appear.
- If sections contain different topics, cover ALL of them.
- Use the full output length available."""


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


def summarize_stream(
    transcript: str,
    language: str,
    db,
    *,
    start_time: str = "",
    end_time: str = "",
    template: str = "mom",
    custom_prompt: str = "",
    meeting_id: int | None = None,
) -> Generator[str, None, None]:
    """Stream meeting summary token-by-token via SSE.
    Uses single-pass for short transcripts, MapReduce for long ones.

    Args:
        template: one of 'mom', 'summary', 'bullets', 'custom'
        custom_prompt: user-provided prompt (used when template='custom')
        meeting_id: when supplied, attached reference materials (md/txt
            uploaded via /meetings/{id}/attachments) are fetched and
            included as system context. Optional so callers without a
            persisted meeting (ad-hoc transcript) still work.
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

    # If the user attached reference materials, lift their importance at the
    # system level too (the user-content block alone wasn't enough — LLMs tend
    # to treat user-content as conversational data and skim it).
    if meeting_id is not None:
        try:
            _ref_probe = db.get_attachments_combined_text(meeting_id)
        except Exception:
            _ref_probe = ""
        if _ref_probe:
            prompt += (
                "\n\nCRITICAL: The user attached REFERENCE MATERIALS (documents) "
                "to this meeting. Those documents are authoritative context — "
                "use them to correct mistranscribed names, ground the minutes "
                "in project-specific terminology, and cross-check what was "
                "discussed vs. what was planned. Treat them with at least the "
                "same weight as the transcript when they contradict it."
            )

    # Build timestamp context
    time_context = ""
    if start_time or end_time:
        time_context = "\n\n--- Meeting Time Info ---\n"
        if start_time:
            time_context += f"Recording started: {start_time}\n"
        if end_time:
            time_context += f"Recording ended: {end_time}\n"
        time_context += "---\n"

    # Build reference-materials context from attachments (md/txt). Injected
    # only at the user-content layer of single-pass + final reduce — adding
    # to every map step would multiply token cost without much win since
    # chunk summaries are already abstractive.
    reference_context = ""
    if meeting_id is not None:
        try:
            ref_text = db.get_attachments_combined_text(meeting_id)
        except Exception as exc:
            log.warning("[summarize] failed to load attachments for %s: %s", meeting_id, exc)
            ref_text = ""
        if ref_text:
            # Strong, action-oriented framing — earlier "background only / do
            # NOT copy verbatim" wording made the LLM ignore the materials and
            # produced minutes that looked identical to ones without context.
            # Now we explicitly tell it to use the info, cite it, and reconcile
            # discrepancies between transcript and docs.
            reference_context = (
                "\n\n=== REFERENCE MATERIALS (USE THESE) ===\n"
                "The user attached the following document(s) as REQUIRED CONTEXT for "
                "this meeting. You MUST:\n"
                "  1. Use names, titles, terminology, project codes from these docs "
                "as the source of truth (transcripts often mistranscribe proper nouns).\n"
                "  2. Cross-reference the meeting against agendas / briefs / specs — "
                "note which items WERE covered and which were SKIPPED.\n"
                "  3. When the meeting decision differs from what the doc proposed, "
                "call it out explicitly (e.g. 'agenda đề xuất X, cuộc họp chốt Y').\n"
                "  4. Pull in background details (deadlines, prior decisions, "
                "stakeholders) that clarify what was said in the meeting.\n"
                "  5. At the END of the minutes, add a short section "
                "'## Tài liệu tham khảo / Reference Materials' listing the file "
                "names you used.\n\n"
                "Do NOT copy long passages verbatim, but DO weave the information "
                "throughout the minutes wherever it adds value.\n\n"
                f"{ref_text}\n"
                "=== END REFERENCE MATERIALS ===\n"
            )
            log.info(
                "[summarize] including %d chars of reference materials for meeting %s",
                len(ref_text), meeting_id,
            )

    is_deep = template == "deep"

    # ── Single-pass for short transcripts ──
    if len(transcript) < SINGLE_PASS_MAX_CHARS:
        yield from _single_pass(
            client, model, prompt, transcript, time_context,
            max_tokens=16000 if is_deep else 8000,
            reference_context=reference_context,
        )
        return

    # ── MapReduce for long transcripts ──
    yield from _map_reduce(
        client, model, prompt, transcript, language, time_context,
        deep=is_deep, reference_context=reference_context,
    )


def _single_pass(
    client,
    model: str,
    prompt: str,
    transcript: str,
    time_context: str = "",
    max_tokens: int = 8000,
    *,
    reference_context: str = "",
) -> Generator[str, None, None]:
    """Single LLM call for short transcripts."""
    try:
        yield f"event: progress\ndata: {json.dumps({'step': 'summarizing', 'progress': 0.1})}\n\n"

        # Order: time → reference materials → transcript.
        # Reference goes BEFORE transcript so the model reads it as a setup
        # before the conversation it has to summarize.
        prefix = f"{time_context}{reference_context}" if (time_context or reference_context) else ""
        user_content = f"{prefix}Transcript:\n{transcript}"
        stream = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": prompt},
                {"role": "user", "content": user_content},
            ],
            temperature=0.3,
            max_tokens=max_tokens,
            stream=True,
        )

        try:
            for chunk in stream:
                token = chunk.choices[0].delta.content if chunk.choices[0].delta.content else None
                if token:
                    yield f"data: {json.dumps({'token': token})}\n\n"
        finally:
            stream.close()

        yield f"event: done\ndata: {json.dumps({})}\n\n"
    except Exception as e:
        yield f"event: error\ndata: {json.dumps({'error': str(e)})}\n\n"


def _map_reduce(
    client,
    model: str,
    final_prompt: str,
    transcript: str,
    language: str,
    time_context: str = "",
    deep: bool = False,
    *,
    reference_context: str = "",
) -> Generator[str, None, None]:
    """Hierarchical MapReduce: chunk → map → section reduce → final reduce.

    For a 4-hour meeting (~200k chars):
      Phase 1: Split into ~14 chunks (15k each)
      Phase 2: Map — detailed summary per chunk (400-600 words each)
      Phase 3: Section reduce — group 4 chunks → 1 section summary
      Phase 4: Final reduce — combine sections → comprehensive minutes
    """
    try:
        # Phase 1: Split
        chunks = _chunk_transcript(transcript)
        total = len(chunks)
        log.info("[summarize] MapReduce: %d chars -> %d chunks", len(transcript), total)

        yield f"event: progress\ndata: {json.dumps({'step': 'chunking', 'total': total})}\n\n"

        # Phase 2: Map — detailed summary per chunk
        map_prompt = DEEP_CHUNK_PROMPT if deep else CHUNK_SUMMARY_PROMPT
        map_max_tokens = 4000 if deep else 2000
        chunk_summaries: list[str] = []
        for i, chunk_text in enumerate(chunks):
            yield f"event: progress\ndata: {json.dumps({'step': 'analyzing', 'current': i + 1, 'total': total})}\n\n"

            response = client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": map_prompt},
                    {"role": "user", "content": f"Segment {i + 1}/{total}:\n\n{chunk_text}"},
                ],
                temperature=0.2,
                max_tokens=map_max_tokens,
            )
            summary = response.choices[0].message.content or ""
            chunk_summaries.append(summary)
            log.info("[summarize] chunk %d/%d done (%d chars)", i + 1, total, len(summary))

        # Phase 3: Section reduce (hierarchical) — only if many chunks
        if total > SECTION_GROUP_SIZE:
            yield f"event: progress\ndata: {json.dumps({'step': 'consolidating'})}\n\n"

            section_summaries: list[str] = []
            for g in range(0, total, SECTION_GROUP_SIZE):
                group = chunk_summaries[g:g + SECTION_GROUP_SIZE]
                group_label = f"Segments {g + 1}-{min(g + SECTION_GROUP_SIZE, total)}/{total}"
                combined_group = "\n\n".join(
                    f"--- Segment {g + j + 1} ---\n{s}" for j, s in enumerate(group)
                )

                section_prompt = DEEP_SECTION_REDUCE_PROMPT if deep else SECTION_REDUCE_PROMPT
                section_max_tokens = 6000 if deep else 3000
                response = client.chat.completions.create(
                    model=model,
                    messages=[
                        {"role": "system", "content": section_prompt},
                        {"role": "user", "content": f"{group_label}:\n\n{combined_group}"},
                    ],
                    temperature=0.2,
                    max_tokens=section_max_tokens,
                )
                section = response.choices[0].message.content or ""
                section_summaries.append(f"## Section: {group_label}\n{section}")
                log.info("[summarize] section %s done (%d chars)", group_label, len(section))

            combined_for_final = "\n\n".join(section_summaries)
        else:
            # Few chunks — skip section reduce
            combined_for_final = "\n\n".join(
                f"--- Part {i + 1}/{total} ---\n{s}" for i, s in enumerate(chunk_summaries)
            )

        # Phase 4: Final reduce — comprehensive minutes
        yield f"event: progress\ndata: {json.dumps({'step': 'finalizing'})}\n\n"

        final_max_tokens = 16000 if deep else 8000
        prefix = f"{time_context}{reference_context}" if (time_context or reference_context) else ""
        user_content = f"{prefix}{combined_for_final}" if prefix else combined_for_final
        stream = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": f"{final_prompt}\n\n{FINAL_REDUCE_PROMPT}"},
                {"role": "user", "content": user_content},
            ],
            temperature=0.3,
            max_tokens=final_max_tokens,
            stream=True,
        )

        try:
            for chunk in stream:
                token = chunk.choices[0].delta.content if chunk.choices[0].delta.content else None
                if token:
                    yield f"data: {json.dumps({'token': token})}\n\n"
        finally:
            stream.close()

        yield f"event: done\ndata: {json.dumps({})}\n\n"
    except Exception as e:
        log.error("[summarize] MapReduce error: %s", e)
        yield f"event: error\ndata: {json.dumps({'error': str(e)})}\n\n"
