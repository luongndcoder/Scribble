"""
Summarization module — SSE streaming via LLM
"""

import os
import json
from typing import Generator


SUMMARY_PROMPT_VI = """Bạn là trợ lý viết MoM (Minutes of Meeting) cấp senior cho đội ngũ customer-facing.

Mục tiêu MoM:
- Không chỉ tường thuật nội dung, mà phải là công cụ communication, quản trị rủi ro và điều phối kỳ vọng stakeholders.
- Người đọc gồm: người tham gia họp và người không tham gia họp.

Các nội dung bắt buộc:
1. Thời gian và thành phần tham gia (nêu rõ vai trò nếu có).
2. Link recording gốc.
3. Mục tiêu cuộc họp: vấn đề/nguyên nhân và output cần đạt.
4. Nội dung trao đổi chính (key discussion): lọc ý quan trọng, không tường thuật lan man.
5. Các quyết định quan trọng đã chốt.
6. Action items theo What - Who - When (task gì, PIC là ai/đơn vị nào, deadline/checkpoint khi nào).

Nếu là họp với khách hàng (external), cần làm rõ:
- 1-3 điểm Mobio nhất định cần khách hàng nhớ hoặc thực hiện.
- Dự báo/cảnh báo rủi ro có thể ảnh hưởng action items.
- Văn phong: chuyên nghiệp, khách quan, sắc nét, thuyết phục.

Nếu là MoM nội bộ (internal), cần bổ sung:
- Customer Insights & Politics: thái độ stakeholders, ai ủng hộ/ai gây khó khăn.
- Game Plan: kế hoạch ứng phó và chuẩn bị cho buổi họp tiếp theo.
- Ghi chú người viết: cảm nhận/đánh giá cá nhân cần lưu ý nội bộ.
- Implicit info: thông tin ngầm quan trọng cho người đọc MoM.
- Văn phong: chi tiết, thẳng thắn, không nói giảm nói tránh.

Lưu ý chất lượng:
- Không bịa thông tin. Nếu thiếu dữ liệu, ghi rõ "Chưa có dữ liệu".
- Không liệt kê toàn bộ transcript; chỉ giữ nội dung then chốt.
- Nhấn mạnh mức độ nóng/rủi ro đúng thực tế.

Yêu cầu đầu ra:
- Trả về tiếng Việt, dạng Markdown dễ đọc.
- Dòng đầu tiên bắt buộc: `# <Tên biên bản ngắn gọn>`.
- Dùng đúng cấu trúc sau:
## 1. Thời gian & thành phần tham gia
## 2. Link recording gốc
## 3. Mục tiêu cuộc họp
## 4. Key discussion
## 5. Key decisions
## 6. Action items (What - Who - When)
## 7. Rủi ro & cảnh báo
## 8. External MoM (nếu có khách hàng, không thì ghi "Không áp dụng")
## 9. Internal MoM (insights/politics, game plan, ghi chú, implicit info)
## 10. 1-3 ưu tiên follow-up ngay
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


def summarize_stream(transcript: str, language: str, db) -> Generator[str, None, None]:
    """Stream meeting summary token-by-token via SSE."""
    from openai import OpenAI

    api_key = db.get_setting("llm_api_key") or os.getenv("LLM_API_KEY", "")
    base_url = db.get_setting("llm_base_url") or os.getenv("LLM_BASE_URL", "https://api.openai.com/v1")
    model = db.get_setting("llm_model") or os.getenv("LLM_MODEL", "gpt-4o-mini")

    if not api_key:
        yield f"event: error\ndata: {json.dumps({'error': 'LLM API key not set'})}\n\n"
        return

    client = OpenAI(api_key=api_key, base_url=base_url)
    prompt = SUMMARY_PROMPT_VI if language == "vi" else SUMMARY_PROMPT_EN

    try:
        yield f"event: progress\ndata: {json.dumps({'step': 'summarizing', 'progress': 0.1})}\n\n"

        stream = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": prompt},
                {"role": "user", "content": f"Transcript:\n{transcript}"},
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
