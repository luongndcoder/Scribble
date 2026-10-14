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

    // If no sentence splitting happened (no punctuation), fall back to
    // phrase-based grouping.
    if (grouped.length <= 1 && text.length > 120) {
        return splitByPhraseGroups(text);
    }

    return grouped.length > 0 ? grouped : [text.trim()];
}

/**
 * Vietnamese discourse markers that reliably begin a new clause.
 * Ordered longest-first so "nhưng mà" wins over "nhưng".
 *
 * The offline (Local) STT model emits unpunctuated text, so the comma-based
 * fallback never fires. These markers are the strongest available signal for
 * where a reader expects a break. Single-syllable particles that appear too
 * densely in speech ("mà", "thì", "là", "và", "còn") are deliberately NOT
 * boundaries — using them chopped sentences into 2-3 word fragments.
 */
const VI_CLAUSE_MARKERS: string[] = [
    'nhưng mà', 'tuy nhiên', 'vì vậy', 'vì thế', 'do đó', 'cho nên', 'bởi vì',
    'nghĩa là', 'tức là', 'có nghĩa là', 'thật ra', 'thực ra', 'vậy thì',
    'thế thì', 'đầu tiên', 'sau đó', 'tiếp theo', 'cuối cùng', 'ví dụ',
    'nói chung', 'tóm lại', 'mặc dù', 'sau khi', 'trước khi',
].sort((a, b) => b.length - a.length);

/** Target chunk length for unpunctuated text (chars). */
const PHRASE_CHUNK_TARGET = 150;
/** Never break before this many words into a chunk (avoids stubs). */
const PHRASE_MIN_WORDS = 14;

/**
 * Group unpunctuated text into readable lines.
 *
 * Strategy: walk words, close a chunk when it reaches the target length AND
 * the NEXT word starts a discourse marker (preferred), or when the chunk
 * simply grows too long (hard cap). This keeps most breaks at natural clause
 * starts instead of arbitrary word counts.
 */
function splitByPhraseGroups(text: string): string[] {
    const words = text.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return [text.trim()];
    if (words.length <= PHRASE_MIN_WORDS) return [text.trim()];

    const markerSet = new Set(VI_CLAUSE_MARKERS);
    const hardCap = PHRASE_CHUNK_TARGET * 1.6;
    const result: string[] = [];
    let buffer: string[] = [];

    const startsMarker = (index: number): boolean => {
        const rest = words.slice(index, index + 3).join(' ').toLowerCase();
        for (const marker of VI_CLAUSE_MARKERS) {
            if (rest === marker || rest.startsWith(marker + ' ')) {
                // Require marker as a whole-word prefix, not a substring.
                return markerSet.has(marker);
            }
        }
        return false;
    };

    for (let i = 0; i < words.length; i++) {
        const candidateLen = (buffer.join(' ') + ' ' + words[i]).trim().length;

        if (
            buffer.length >= PHRASE_MIN_WORDS &&
            candidateLen >= PHRASE_CHUNK_TARGET &&
            startsMarker(i)
        ) {
            result.push(buffer.join(' '));
            buffer = [words[i]];
            continue;
        }

        buffer.push(words[i]);

        if (buffer.join(' ').length >= hardCap) {
            result.push(buffer.join(' '));
            buffer = [];
        }
    }

    if (buffer.length) result.push(buffer.join(' '));

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
