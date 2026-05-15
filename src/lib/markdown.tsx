import { Fragment, ReactNode } from 'react';

/**
 * Open an external URL via the Tauri shell plugin (system browser). Imported
 * lazily so the renderer still runs in plain browser dev (`pnpm dev`) — the
 * plugin module throws at import time outside a Tauri shell.
 */
function openExternal(url: string) {
    if (typeof window !== 'undefined' && window.__TAURI_INTERNALS__) {
        import('@tauri-apps/plugin-shell')
            .then(({ open }) => open(url))
            .catch((e) => console.warn('[markdown] shell.open failed:', e));
    } else {
        window.open(url, '_blank', 'noopener,noreferrer');
    }
}

/**
 * Minimal markdown-to-React renderer scoped specifically to GitHub Release
 * notes. We pull in zero dependencies (react-markdown + rehype + remark is
 * ~60kB gzipped — overkill for a single surface).
 *
 * Supported syntax (everything else falls through as literal text):
 *   #, ##, ###   → <h3>, <h4>, <h5>
 *   - / *        → bullet list items (consecutive lines collapsed into <ul>)
 *   **bold**     → <strong>
 *   `code`       → <code>
 *   [text](url)  → clickable link via @tauri-apps/plugin-shell open() —
 *                  the webview doesn't open URLs natively because we run
 *                  inside Tauri's <a target=_blank> sandbox; routing
 *                  through the shell plugin pops the system browser.
 *
 * Why not parse emoji shortcodes :rocket:? GitHub release bodies already
 * carry literal UTF-8 emoji glyphs (🚀, 📝, ...). They round-trip fine.
 */

function renderInline(text: string, keyPrefix: string): ReactNode {
    // Walk the string, peeling off the earliest of three patterns:
    //   **bold**, `code`, [text](url). Falls through to plain text otherwise.
    const out: ReactNode[] = [];
    let remaining = text;
    let i = 0;

    const patterns: Array<{ kind: 'bold' | 'code' | 'link'; re: RegExp }> = [
        { kind: 'bold', re: /\*\*([^*\n]+)\*\*/ },
        { kind: 'code', re: /`([^`\n]+)`/ },
        { kind: 'link', re: /\[([^\]\n]+)\]\(([^)\n]+)\)/ },
    ];

    while (remaining.length > 0) {
        let earliestKind: typeof patterns[number]['kind'] | null = null;
        let earliestIdx = Infinity;
        let earliestMatch: RegExpMatchArray | null = null;

        for (const { kind, re } of patterns) {
            const m = remaining.match(re);
            if (m && m.index !== undefined && m.index < earliestIdx) {
                earliestKind = kind;
                earliestIdx = m.index;
                earliestMatch = m;
            }
        }

        if (!earliestKind || !earliestMatch) {
            out.push(remaining);
            break;
        }

        if (earliestIdx > 0) {
            out.push(remaining.slice(0, earliestIdx));
        }

        const k = `${keyPrefix}-${i++}`;
        if (earliestKind === 'bold') {
            out.push(<strong key={k}>{earliestMatch[1]}</strong>);
        } else if (earliestKind === 'code') {
            out.push(<code key={k}>{earliestMatch[1]}</code>);
        } else {
            // Clickable link. We use button-styled <a> + onClick rather than
            // href because Tauri's <a target=_blank> doesn't pop the system
            // browser by default — we have to route through the shell plugin.
            const url = earliestMatch[2];
            out.push(
                <a
                    key={k}
                    href={url}
                    className="md-link"
                    onClick={(e) => { e.preventDefault(); openExternal(url); }}
                >
                    {earliestMatch[1]}
                </a>,
            );
        }

        remaining = remaining.slice(earliestIdx + earliestMatch[0].length);
    }

    return out.length === 1 ? out[0] : <>{out}</>;
}

export function renderMarkdown(text: string): ReactNode[] {
    if (!text) return [];

    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const blocks: ReactNode[] = [];
    let listBuffer: string[] = [];
    let blockIdx = 0;

    const flushList = () => {
        if (listBuffer.length > 0) {
            blocks.push(
                <ul key={`l-${blockIdx++}`} className="md-list">
                    {listBuffer.map((item, idx) => (
                        <li key={idx}>{renderInline(item, `l${blockIdx}-${idx}`)}</li>
                    ))}
                </ul>,
            );
            listBuffer = [];
        }
    };

    for (const raw of lines) {
        const line = raw.trimEnd();
        if (/^### /.test(line)) {
            flushList();
            blocks.push(<h5 key={`h-${blockIdx++}`} className="md-h5">{renderInline(line.slice(4), `h${blockIdx}`)}</h5>);
        } else if (/^## /.test(line)) {
            flushList();
            blocks.push(<h4 key={`h-${blockIdx++}`} className="md-h4">{renderInline(line.slice(3), `h${blockIdx}`)}</h4>);
        } else if (/^# /.test(line)) {
            flushList();
            blocks.push(<h3 key={`h-${blockIdx++}`} className="md-h3">{renderInline(line.slice(2), `h${blockIdx}`)}</h3>);
        } else if (/^[-*] /.test(line)) {
            listBuffer.push(line.slice(2));
        } else if (line.trim() === '') {
            // Blank line ends a list (paragraph separator). We intentionally
            // don't emit a <br> — successive paragraphs get natural spacing
            // from the block element CSS margins.
            flushList();
        } else {
            flushList();
            blocks.push(<p key={`p-${blockIdx++}`} className="md-p">{renderInline(line, `p${blockIdx}`)}</p>);
        }
    }
    flushList();

    return blocks;
}

/** Wrapper component for convenience — `<Markdown>{notes}</Markdown>`. */
export function Markdown({ children }: { children: string }) {
    const blocks = renderMarkdown(children);
    return <Fragment>{blocks}</Fragment>;
}
