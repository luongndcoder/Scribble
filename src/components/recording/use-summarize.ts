import { useRef } from "react";
import { useAppStore } from "../../stores/appStore";
import { fetchSidecar } from "../../lib/sidecar";
import { consumeSseResponse } from "../../lib/sse";

function extractMinutesTitle(summary: string): string | null {
    const raw = String(summary || "").trim();
    if (!raw) return null;
    const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return null;

    // # Heading (h1)
    const h1 = lines.find((line) => /^#\s+/.test(line) && !/^##/.test(line));
    if (h1)
        return h1.replace(/^#\s+/, "").replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+/u, "").trim().slice(0, 160) || null;

    // ## Heading (h2)
    const h2 = lines.find((line) => /^##\s+/.test(line));
    if (h2)
        return h2.replace(/^##\s+/, "").replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+/u, "").trim().slice(0, 160) || null;

    // Explicit "Tiêu đề:" / "Title:"
    const explicitTitle = lines.find((line) => /^(tiêu đề|tieu de|title)\s*[:\-]/i.test(line));
    if (explicitTitle) {
        return explicitTitle.replace(/^(tiêu đề|tieu de|title)\s*[:\-]\s*/i, "").trim().slice(0, 160) || null;
    }

    // **Bold title** on first line
    const boldMatch = lines[0]?.match(/^\*\*(.+?)\*\*/);
    if (boldMatch) return boldMatch[1].trim().slice(0, 160) || null;

    // Fallback: first content line
    const firstContent = lines.find((line) => !/^[-*]\s+/.test(line) && !/^\d+\.\s+/.test(line) && line.length > 3);
    return firstContent
        ? firstContent.replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+/u, "").trim().slice(0, 160) || null
        : null;
}

/**
 * Hook encapsulating the summarization workflow (sync transcript → SSE stream → save).
 */
export function useSummarize() {
    const lockRef = useRef(false);

    const summarize = async () => {
        if (lockRef.current) return;
        lockRef.current = true;
        // Safety timeout: auto-release lock after 5 minutes to prevent permanent UI lock
        const lockTimeout = setTimeout(() => { lockRef.current = false; }, 5 * 60 * 1000);
        const { setSummaryLoading, setTransientSummary, lang } = useAppStore.getState();
        setSummaryLoading(true);
        setTransientSummary("");
        useAppStore.setState({ activeTab: "summary" });
        try {
            const state = useAppStore.getState();
            const mid = state.currentMeetingId || state.draftId;

            const transcriptText = JSON.stringify(
                state.transcriptParts.map((p) => ({
                    speaker: p.speaker,
                    text: p.text,
                    timestamp: p.timestamp,
                    translation: p.translation || "",
                })),
            );

            // Sync full transcript to DB before summarizing
            if (mid && state.transcriptParts.length > 0) {
                try {
                    await fetchSidecar(`/meetings/${mid}`, {
                        method: "PUT",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ transcript: transcriptText }),
                    });
                } catch (syncErr) {
                    console.warn("[summarize] Failed to sync transcript:", syncErr);
                }
            }

            const payload: any = { language: state.summaryLang || lang, template: state.summaryTemplate || "mom" };
            if (state.summaryTemplate === "custom" && state.customPrompt) {
                payload.customPrompt = state.customPrompt;
            }
            if (state.recordingStartedAt) payload.startTime = state.recordingStartedAt;
            payload.endTime = new Date().toLocaleString("sv-SE") + " " + Intl.DateTimeFormat().resolvedOptions().timeZone;
            if (mid) {
                payload.meetingId = mid;
                payload.transcript = transcriptText;
            } else {
                payload.transcript = transcriptText;
            }

            const res = await fetchSidecar("/summarize", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });

            let accumulated = "";
            await consumeSseResponse(res, {
                onToken: (token) => {
                    accumulated += token;
                    setTransientSummary(accumulated);
                    if (!mid) return;
                    useAppStore.setState((s) => {
                        const idx = s.meetings.findIndex((m) => m.id === mid);
                        if (idx >= 0) {
                            const next = [...s.meetings];
                            next[idx] = { ...next[idx], summary: accumulated };
                            return { meetings: next };
                        }
                        return {
                            meetings: [
                                {
                                    id: mid,
                                    title: `Meeting ${mid}`,
                                    transcript: "",
                                    summary: accumulated,
                                    audio_duration: s.seconds,
                                    created_at: new Date().toISOString(),
                                    status: state.currentMeetingId ? "saved" : "draft",
                                },
                                ...s.meetings,
                            ],
                        };
                    });
                },
                onErrorEvent: (message) => {
                    console.warn("[summarize] SSE error:", message);
                    setTransientSummary(
                        lang === "vi"
                            ? `Không thể tạo biên bản: ${message}`
                            : `Cannot create minutes: ${message}`,
                    );
                },
            });

            // Save final summary to DB
            if (mid && accumulated) {
                try {
                    const extractedTitle = extractMinutesTitle(accumulated);
                    const putBody: any = { summary: accumulated, status: "saved" };
                    if (extractedTitle) putBody.title = extractedTitle;
                    const putRes = await fetchSidecar(`/meetings/${mid}`, {
                        method: "PUT",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(putBody),
                    });
                    if (!putRes.ok) {
                        console.warn("[summarize] PUT failed:", putRes.status);
                    }

                    const refreshed = await fetchSidecar(`/meetings/${mid}`);
                    if (refreshed.ok) {
                        const meeting = await refreshed.json();
                        useAppStore.setState((s) => {
                            const idx = s.meetings.findIndex((m) => m.id === mid);
                            if (idx >= 0) {
                                const next = [...s.meetings];
                                next[idx] = meeting;
                                return { meetings: next };
                            }
                            return { meetings: [meeting, ...s.meetings] };
                        });
                    } else if (extractedTitle) {
                        useAppStore.setState((s) => {
                            const idx = s.meetings.findIndex((m) => m.id === mid);
                            if (idx < 0) return s;
                            const next = [...s.meetings];
                            next[idx] = { ...next[idx], title: extractedTitle };
                            return { meetings: next };
                        });
                    }
                } catch (saveErr) {
                    console.warn("[summarize] Failed to save:", saveErr);
                }
            }
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e || "");
            const { lang: uiLang } = useAppStore.getState();
            setTransientSummary(
                uiLang === "vi"
                    ? `Không thể tạo biên bản: ${message || "Lỗi không xác định"}`
                    : `Cannot create minutes: ${message || "Unknown error"}`,
            );
        } finally {
            clearTimeout(lockTimeout);
            lockRef.current = false;
            setSummaryLoading(false);
        }
    };

    return { summarize };
}
