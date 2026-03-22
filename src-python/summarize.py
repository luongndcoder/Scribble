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

# ── Prompts ──
SUMMARY_PROMPT_VI = """Ban la tro ly viet MoM (Minutes of Meeting) cap senior cho doi ngu customer-facing.

Muc tieu MoM:
- Khong chi tuong thuat noi dung, ma phai la cong cu communication, quan tri rui ro va dieu phoi ky vong stakeholders.
- Nguoi doc gom: nguoi tham gia hop va nguoi khong tham gia hop.

Cac noi dung bat buoc:
1. Thoi gian & thanh phan tham gia (neu ro vai tro neu co).
2. Link recording goc.
3. Muc tieu cuoc hop: van de/nguyen nhan va output can dat.
4. Noi dung trao doi chinh (key discussion): loc y quan trong, khong tuong thuat lan man.
5. Cac quyet dinh quan trong da chot.
6. Action items theo What - Who - When (task gi, PIC la ai/don vi nao, deadline/checkpoint khi nao).

Neu la hop voi khach hang (external), can lam ro:
- 1-3 diem Mobio nhat dinh can khach hang nho hoac thuc hien.
- Du bao/canh bao rui ro co the anh huong action items.
- Van phong: chuyen nghiep, khach quan, sac net, thuyet phuc.

Neu la MoM noi bo (internal), can bo sung:
- Customer Insights & Politics: thai do stakeholders, ai ung ho/ai gay kho khan.
- Game Plan: ke hoach ung pho va chuan bi cho buoi hop tiep theo.
- Ghi chu nguoi viet: cam nhan/danh gia ca nhan can luu y noi bo.
- Implicit info: thong tin ngam quan trong cho nguoi doc MoM.
- Van phong: chi tiet, thang than, khong noi giam noi tranh.

Luu y chat luong:
- Khong bia thong tin. Neu thieu du lieu, ghi ro "Chua co du lieu".
- Khong liet ke toan bo transcript; chi giu noi dung then chot.
- Nhan manh muc do nong/rui ro dung thuc te.

Yeu cau dau ra:
- Tra ve tieng Viet, dang Markdown de doc.
- Dong dau tien bat buoc: `# <Ten bien ban ngan gon>`.
- Dung dung cau truc sau:
## 1. Thoi gian & thanh phan tham gia
## 2. Link recording goc
## 3. Muc tieu cuoc hop
## 4. Key discussion
## 5. Key decisions
## 6. Action items (What - Who - When)
## 7. Rui ro & canh bao
## 8. External MoM (neu co khach hang, khong thi ghi "Khong ap dung")
## 9. Internal MoM (insights/politics, game plan, ghi chu, implicit info)
## 10. 1-3 uu tien follow-up ngay
"""

SUMMARY_PROMPT_EN = """You are a senior MoM (Minutes of Meeting) assistant.

Write strategic meeting minutes (not a raw transcript) for stakeholders who attended and did not attend.

Required sections:
1) Time & attendees (include role when possible)
2) Original recording link
3) Meeting objective
4) Key discussion points
5) Key decisions
6) Action items (What - Who - When)
7) Risks and warnings
8) External MoM view (if customer-facing; otherwise mark N/A)
9) Internal MoM view (politics/insights, game plan, implicit notes)
10) Top 1-3 immediate follow-ups

Rules:
- Do not invent facts. If missing, write "Missing data".
- Keep it concise, sharp, and actionable.
- First line must be: `# <Short minutes title>`.
- Return Markdown only.
"""

CHUNK_SUMMARY_PROMPT_VI = """Tom tat doan hoi thoai sau. Giu lai cac y chinh, quyet dinh, action items, va ten nguoi noi.
Khong bo sung thong tin. Tra ve tieng Viet, dang bullet points ngan gon (toi da 300 tu)."""

CHUNK_SUMMARY_PROMPT_EN = """Summarize the following conversation segment. Keep key points, decisions, action items, and speaker names.
Do not add information. Return concise bullet points (max 300 words)."""

REDUCE_PROMPT_VI = """Duoi day la cac ban tom tat tung phan cua mot cuoc hop dai.
Hay tong hop thanh MoM hoan chinh theo cau truc yeu cau."""

REDUCE_PROMPT_EN = """Below are partial summaries from different segments of a long meeting.
Synthesize them into a complete MoM following the required structure."""


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


def summarize_stream(transcript: str, language: str, db, *, start_time: str = "", end_time: str = "") -> Generator[str, None, None]:
    """Stream meeting summary token-by-token via SSE.
    Uses single-pass for short transcripts, MapReduce for long ones.
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

    # Select base prompt based on language
    if language == "vi":
        prompt = SUMMARY_PROMPT_VI
    elif language == "en":
        prompt = SUMMARY_PROMPT_EN
    else:
        # For other languages, use English prompt + language instruction
        lang_names = {
            "ja": "Japanese", "ko": "Korean", "zh": "Chinese",
            "fr": "French", "de": "German", "es": "Spanish",
            "th": "Thai", "id": "Indonesian", "pt": "Portuguese",
        }
        lang_name = lang_names.get(language, language)
        prompt = SUMMARY_PROMPT_EN + f"\n\nIMPORTANT: You MUST write the entire output in {lang_name}. All section headers and content must be in {lang_name}."

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

        chunk_prompt = CHUNK_SUMMARY_PROMPT_VI if language == "vi" else CHUNK_SUMMARY_PROMPT_EN

        # Phase 2: Map — summarize each chunk
        partial_summaries: list[str] = []
        for i, chunk_text in enumerate(chunks):
            yield f"event: progress\ndata: {json.dumps({'step': 'analyzing', 'current': i + 1, 'total': total})}\n\n"

            response = client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": chunk_prompt},
                    {"role": "user", "content": chunk_text},
                ],
                temperature=0.2,
                max_tokens=1000,
            )
            summary = response.choices[0].message.content or ""
            partial_summaries.append(f"--- Phan {i + 1}/{total} ---\n{summary}")
            log.info("[summarize] chunk %d/%d done (%d chars)", i + 1, total, len(summary))

        # Phase 3: Reduce — synthesize into final MoM
        yield f"event: progress\ndata: {json.dumps({'step': 'finalizing'})}\n\n"

        reduce_intro = REDUCE_PROMPT_VI if language == "vi" else REDUCE_PROMPT_EN
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
