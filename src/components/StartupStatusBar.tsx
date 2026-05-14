/**
 * StartupStatusBar — slim status strip anchored to the bottom of the app
 * while the backend is warming up.
 *
 * Why bottom-anchored (not centered modal):
 *   Earlier we used a 420×N modal in the center of the screen, which felt
 *   like the app was frozen. The strip lets users see the app shell (logo,
 *   nav, list area) so they get a sense of structure while waiting, and
 *   the strip itself communicates exactly what step we're on plus how
 *   long it's been running. Click "Chi tiết" to expand the full step list.
 *
 * Steps map (driven by App.tsx polling):
 *   0  → waiting for sidecar /health
 *   1  → sidecar online, waiting for diarizer model
 *   2  → diarizer loaded, finalizing
 *   3+ → ready (parent unmounts the bar before this is rendered)
 *
 * First boot can take 20-40s on slow disks because the Rust shell extracts
 * a ~110MB tar.gz of the Python sidecar. Subsequent boots are ~5-10s.
 * The elapsed-time counter helps users distinguish "still going" from
 * "actually stuck".
 */

interface Props {
    lang: 'vi' | 'en';
    /** 0..3 — current high-level step (see module doc). */
    step: number;
    /** Seconds since startup began — drives the elapsed-time chip. */
    elapsed: number;
    /** When true, expand to show the full step list. */
    expanded: boolean;
    onToggleExpand: () => void;
}

interface StepDef {
    label: string;
    /** Hint shown when this step is the active one. */
    hint?: string;
}

function fmtElapsed(s: number, lang: 'vi' | 'en'): string {
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const r = s % 60;
    return lang === 'vi' ? `${m}p ${r}s` : `${m}m ${r}s`;
}

export function StartupStatusBar({ lang, step, elapsed, expanded, onToggleExpand }: Props) {
    const tr = lang === 'vi'
        ? {
              starting: 'Đang khởi động',
              ready: 'Hoàn tất',
              details: 'Chi tiết',
              slowHint: 'Lần đầu chạy có thể mất 20-40 giây để giải nén AI engine.',
              steps: [
                  {
                      label: 'Khởi tạo dịch vụ AI',
                      hint: 'Lần đầu sẽ giải nén ~110MB AI engine.',
                  },
                  {
                      label: 'Tải mô hình nhận diện giọng nói',
                      hint: 'Khởi tạo CAM++ ONNX và kết nối Nvidia Riva.',
                  },
                  {
                      label: 'Hoàn tất',
                  },
              ] as StepDef[],
          }
        : {
              starting: 'Starting',
              ready: 'Complete',
              details: 'Details',
              slowHint: 'First launch may take 20-40s to extract the AI engine.',
              steps: [
                  {
                      label: 'Initialising AI service',
                      hint: 'First launch extracts a ~110MB AI engine.',
                  },
                  {
                      label: 'Loading speech models',
                      hint: 'Initialising CAM++ ONNX and connecting to Nvidia Riva.',
                  },
                  {
                      label: 'Ready',
                  },
              ] as StepDef[],
          };

    // Map the 0..3 numeric step into the 3-entry step list above. Numeric:
    //   0 → list index 0 active
    //   1 → list index 1 active
    //   2 → list index 1 still active (finalising)
    //   3 → list index 2 (ready) — parent unmounts before this normally
    const activeIdx = step <= 0 ? 0 : step >= 3 ? 2 : 1;
    const currentLabel = tr.steps[activeIdx].label;
    const currentHint = tr.steps[activeIdx].hint;

    // Past 25s on first launch the user might worry — surface the hint
    // automatically so they don't think it's stuck.
    const isSlow = elapsed >= 25;

    return (
        <div
            className={`startup-status ${expanded ? 'startup-status--expanded' : ''}`}
            role="status"
            aria-live="polite"
        >
            <div className="startup-status-bar">
                <span className="startup-status-spinner" aria-hidden>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
                        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                </span>
                <span className="startup-status-text">
                    <strong>{tr.starting}</strong>
                    <span className="startup-status-dim"> · {currentLabel}</span>
                </span>
                <span className="startup-status-elapsed" aria-label="elapsed time">
                    {fmtElapsed(elapsed, lang)}
                </span>
                <button
                    type="button"
                    className="startup-status-toggle"
                    onClick={onToggleExpand}
                    aria-expanded={expanded}
                >
                    {tr.details}
                    <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        style={{ transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 200ms ease' }}
                    >
                        <polyline points="6 15 12 9 18 15" />
                    </svg>
                </button>
            </div>

            {expanded && (
                <div className="startup-status-details">
                    {tr.steps.map((s, i) => {
                        const state =
                            i < activeIdx ? 'done' : i === activeIdx ? 'active' : 'pending';
                        return (
                            <div key={i} className={`startup-status-step startup-status-step--${state}`}>
                                <span className={`startup-status-dot startup-status-dot--${state}`} aria-hidden />
                                <div className="startup-status-step-body">
                                    <div className="startup-status-step-label">{s.label}</div>
                                    {state === 'active' && s.hint && (
                                        <div className="startup-status-step-hint">{s.hint}</div>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                    {isSlow && currentHint && !expanded && (
                        <div className="startup-status-slow-hint">{tr.slowHint}</div>
                    )}
                </div>
            )}

            {/* Inline slow-launch hint without forcing expand — appears once
                we crossed the 25s mark on the same boot. */}
            {!expanded && isSlow && (
                <div className="startup-status-inline-hint">{tr.slowHint}</div>
            )}
        </div>
    );
}
