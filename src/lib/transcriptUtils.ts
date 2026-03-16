/**
 * Transcript display utilities
 * 
 * Splits long transcript parts into readable sentence groups with
 * proportionally-mapped inline translations. Pure display-layer logic.
 */

/** Split text into sentences, grouping very short ones together */
export function splitTextIntoSentences(text: string): string[] {
    if (!text || !text.trim()) return [];

    // Split on sentence-ending punctuation, keeping the punctuation
    const raw = text.trim().split(/(?<=[.!?。！？])\s+/);

    // Group very short fragments (< 40 chars) with the next sentence
    const grouped: string[] = [];
    let buffer = '';

    for (const segment of raw) {
        const trimmed = segment.trim();
        if (!trimmed) continue;

        if (buffer) {
            buffer += ' ' + trimmed;
        } else {
            buffer = trimmed;
        }

        // Flush when buffer is long enough or ends with sentence punctuation
        if (buffer.length >= 60 || /[.!?。！？]$/.test(buffer)) {
            grouped.push(buffer);
            buffer = '';
        }
    }

    if (buffer) {
        if (grouped.length > 0 && grouped[grouped.length - 1].length < 80) {
            grouped[grouped.length - 1] += ' ' + buffer;
        } else {
            grouped.push(buffer);
        }
    }

    // If no sentence splitting happened (no punctuation), split by comma groups
    if (grouped.length <= 1 && text.length > 120) {
        return splitByCommaGroups(text);
    }

    return grouped.length > 0 ? grouped : [text.trim()];
}

/** Fallback: split long text by comma groups (~100 chars each) */
function splitByCommaGroups(text: string): string[] {
    const parts = text.split(/,\s*/);
    const result: string[] = [];
    let buffer = '';

    for (const part of parts) {
        const candidate = buffer ? buffer + ', ' + part : part;
        if (candidate.length >= 100 && buffer) {
            result.push(buffer);
            buffer = part;
        } else {
            buffer = candidate;
        }
    }
    if (buffer) result.push(buffer);

    return result.length > 0 ? result : [text.trim()];
}

/** 
 * Proportionally map a translation to original sentences.
 * Since translations aren't sentence-aligned, we split the translation
 * based on character ratios of the original sentences.
 */
export function splitTranslationForSentences(
    originalSentences: string[],
    translation: string
): string[] {
    if (!translation || !translation.trim() || originalSentences.length <= 1) {
        return originalSentences.length === 1 ? [translation || ''] : originalSentences.map(() => '');
    }

    const totalOrigLen = originalSentences.reduce((sum, s) => sum + s.length, 0);
    if (totalOrigLen === 0) return originalSentences.map(() => '');

    // Try to split translation on sentence boundaries first
    const translationSentences = translation.trim().split(/(?<=[.!?。！？])\s+/).filter(s => s.trim());

    if (translationSentences.length === originalSentences.length) {
        return translationSentences;
    }

    // Proportional split by character ratio (word-boundary aware)
    const words = translation.trim().split(/\s+/);
    const totalWords = words.length;
    const result: string[] = [];
    let wordIdx = 0;

    for (let i = 0; i < originalSentences.length; i++) {
        const ratio = originalSentences[i].length / totalOrigLen;
        const wordCount = i === originalSentences.length - 1
            ? totalWords - wordIdx
            : Math.max(1, Math.round(ratio * totalWords));

        const chunk = words.slice(wordIdx, wordIdx + wordCount).join(' ');
        result.push(chunk);
        wordIdx += wordCount;
    }

    // Append any remaining words to the last chunk
    if (wordIdx < totalWords) {
        const remaining = words.slice(wordIdx).join(' ');
        if (result.length > 0) {
            result[result.length - 1] += ' ' + remaining;
        } else {
            result.push(remaining);
        }
    }

    return result;
}
