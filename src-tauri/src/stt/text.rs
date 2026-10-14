//! Vietnamese STT text post-processing.
//!
//! Ported 1:1 from the Python sidecar:
//!   - `src-python/local_stt.py`  → `_collapse_repeats`, `_maybe_lowercase_allcaps`,
//!     `_postprocess_local`, `_pcm_int16_to_float32`
//!   - `src-python/stt.py`        → `HALLUCINATION_PATTERNS`, `filter_hallucinations`,
//!     `filter_hallucinations_min_chars`, `normalize_vietnamese_text`, `_strip_wav_header`
//!
//! Every function here mirrors a behaviour that was a real bug fix on the Python
//! side (documented in `src-python/tests/test_local_stt.py`), so the comments keep
//! the original rationale. The `regex` crate has no lookaround, so the two
//! `re.split(r"(?<=[.!?…])\s+", ...)` splits from Python are done with a small
//! hand-rolled splitter that reproduces the exact same semantics.

use regex::Regex;
use std::sync::OnceLock;

// ── Hallucination patterns (stt.py HALLUCINATION_PATTERNS) ───────────────────
//
// Kept in the same order as Python. Rust's `regex` crate has no backreferences,
// so `don'?t` uses an alternation instead — semantically identical.
pub const HALLUCINATION_PATTERNS: &[&str] = &[
    r"hãy subscribe cho kênh",
    r"ghiền mì gõ",
    r"để không bỏ lỡ nh[uư]ng video hấp dẫn",
    r"đừng quên like và subscribe",
    r"nhấn nút đăng ký",
    r"cảm ơn các bạn đã theo dõi",
    r"hãy đăng ký kênh",
    r"xin chào các bạn.*kênh",
    r"hẹn gặp lại.*video",
    r"like.*share.*subscribe",
    r"thank you for watching",
    r"please subscribe",
    r"like and subscribe",
    r"don'?t forget to subscribe",
    r"hit the bell",
    r"©.*all rights reserved",
    r"subtitles? by",
    r"www\.\w+\.\w+",
    r"^meeting\.?$",
    r"^meeting discussion\.?$",
    r"^cuộc họp công việc\.?$",
    r"^\.+$",
    r"^,+$",
];

/// 2+ consecutive uppercase letters (incl. Vietnamese diacritics).
/// Mirrors the character class in Python's `_maybe_lowercase_allcaps`.
const UPPER_RUN_RE: &str =
    r"[A-ZĐÂĂÊÔƠƯÁÀẢÃẠẤẦẨẪẬẮẰẲẴẶÉÈẺẼẸẾỀỂỄỆÍÌỈĨỊÓÒỎÕỌỐỒỔỖỘỚỜỞỠỢÚÙỦŨỤỨỪỬỮỰÝỲỶỸỴ]{2,}";

// ── PCM helpers (local_stt.py) ───────────────────────────────────────────────

/// Convert raw little-endian 16-bit PCM to f32 samples in [-1, 1).
pub fn pcm_i16_to_f32(pcm: &[u8]) -> Vec<f32> {
    pcm.chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0)
        .collect()
}

/// Root-mean-square amplitude of a 16-bit PCM frame (0..32768).
pub fn rms_i16(frame: &[u8]) -> f32 {
    let n = frame.len() / 2;
    if n == 0 {
        return 0.0;
    }
    let sum: f64 = frame
        .chunks_exact(2)
        .map(|b| {
            let v = i16::from_le_bytes([b[0], b[1]]) as f64;
            v * v
        })
        .sum();
    (sum / n as f64).sqrt() as f32
}

/// Return the raw PCM payload of a RIFF/WAVE buffer.
///
/// Falls back to a fixed 44-byte skip (or the full buffer) when the RIFF
/// structure is malformed — exactly like Python's `_strip_wav_header`.
pub fn strip_wav_header(wav: &[u8]) -> Vec<u8> {
    if wav.len() < 44 || &wav[..4] != b"RIFF" {
        return wav.to_vec();
    }
    let idx = match find_subslice(&wav[12..], b"data") {
        Some(i) => i + 12,
        None => return wav[44..].to_vec(),
    };
    if idx + 8 > wav.len() {
        return wav[44..].to_vec();
    }
    let size = u32::from_le_bytes([wav[idx + 4], wav[idx + 5], wav[idx + 6], wav[idx + 7]]) as usize;
    let start = idx + 8;
    let end = (start + size).min(wav.len());
    wav[start..end].to_vec()
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

// ── Case handling (local_stt.py `_maybe_lowercase_allcaps`) ──────────────────

/// Lowercase sherpa output so the VI normalizer can re-capitalize properly.
///
/// Both bundled sherpa Vietnamese models (offline + streaming Zipformer) emit
/// unpunctuated ALL-CAPS text. Mixed-case input from cloud providers is left
/// untouched.
///
/// The old rule required >70% of letters to be uppercase, which missed real
/// streaming segments that mix cases — e.g. "POPPY vào trong" (capital letters
/// are only 5/16). The reliable signal is: any run of 2+ consecutive uppercase
/// letters means the model shouted this segment and it should be normalized.
pub fn maybe_lowercase_allcaps(text: &str) -> String {
    let alpha: Vec<char> = text.chars().filter(|c| c.is_alphabetic()).collect();
    if alpha.is_empty() {
        return text.to_string();
    }
    let upper = alpha.iter().filter(|c| c.is_uppercase()).count();
    let upper_ratio = upper as f64 / alpha.len() as f64;
    if upper_ratio > 0.7 {
        return text.to_lowercase();
    }
    // Partial-shout case: the model emitted an uppercase token inside a
    // lowercase sentence ("POPPY vào trong"). Two or more consecutive uppercase
    // letters is not normal Vietnamese prose, so normalize the whole segment
    // (the normalizer restores sentence-case afterwards).
    if upper_run_re().is_match(text) {
        return text.to_lowercase();
    }
    text.to_string()
}

fn upper_run_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(UPPER_RUN_RE).expect("valid UPPER_RUN_RE"))
}

// ── Repeat collapse (local_stt.py `_collapse_repeats`) ───────────────────────

/// Collapse runaway repetition from the streaming transducer.
///
/// RNNT models occasionally enter a repeat loop on long/unclear audio. Two
/// shapes were observed in the wild:
///   - single-token stall:  "nó nó nó nó nó …"
///   - phrase stall:        "Poppy vào trong cái capid đó Poppy vào trong …"
///
/// We collapse immediate repeats of the same token to at most 2 (keeping
/// natural Vietnamese reduplication like "rất rất", "từ từ") and cut a
/// repeated multi-word cycle down to a single occurrence. Consecutive
/// identical sentences are dropped too.
pub fn collapse_repeats(text: &str) -> String {
    if text.is_empty() {
        return text.to_string();
    }

    let mut tokens: Vec<String> = text.split_whitespace().map(|s| s.to_string()).collect();

    // 1) Collapse an immediate repeating CYCLE of length 2..12 (phrase stall).
    //    A cycle of length 1 is deliberately NOT collapsed here: a single word
    //    said twice is normal Vietnamese reduplication ("rất rất", "từ từ",
    //    "nó nó"), while 3+ identical words is a stall — handled in step 2.
    if tokens.len() >= 4 {
        let mut collapsed: Vec<String> = Vec::with_capacity(tokens.len());
        let mut i = 0usize;
        while i < tokens.len() {
            let mut found = false;
            // Longest cycle first so a 6-word phrase wins over a shorter match
            // inside it. Python: range(min(12, len(collapsed), len(tokens)-i), 1, -1)
            let upper = 12usize.min(collapsed.len()).min(tokens.len() - i);
            let mut size = upper;
            while size > 1 {
                let prev: Vec<String> = collapsed[collapsed.len() - size..]
                    .iter()
                    .map(|t| t.to_lowercase())
                    .collect();
                let nxt: Vec<String> = tokens[i..i + size]
                    .iter()
                    .map(|t| t.to_lowercase())
                    .collect();
                if nxt.len() == size && prev == nxt {
                    i += size; // skip the duplicated cycle
                    found = true;
                    break;
                }
                size -= 1;
            }
            if !found {
                collapsed.push(tokens[i].clone());
                i += 1;
            }
        }
        tokens = collapsed;
    }

    // 2) Cap a single token repeated 3+ times in a row at 2 occurrences
    //    (keeps "rất rất", kills "nó nó nó nó").
    if tokens.len() >= 3 {
        let mut capped: Vec<String> = Vec::with_capacity(tokens.len());
        for tok in tokens.iter() {
            let tl = tok.to_lowercase();
            if capped.len() >= 2
                && capped[capped.len() - 1].to_lowercase() == tl
                && capped[capped.len() - 2].to_lowercase() == tl
            {
                continue;
            }
            capped.push(tok.clone());
        }
        tokens = capped;
    }

    let text = tokens.join(" ");

    // 3) Sentence-level: drop consecutive identical sentences.
    //    Python: re.split(r"(?<=[.!?…])\s+", text) — split AFTER the punctuation,
    //    dropping the run of whitespace.
    let parts = split_after_sentence_punct(&text);
    if parts.len() > 1 {
        let mut deduped: Vec<String> = Vec::with_capacity(parts.len());
        for s in parts {
            if let Some(last) = deduped.last() {
                if s.trim().to_lowercase() == last.trim().to_lowercase() {
                    continue;
                }
            }
            deduped.push(s);
        }
        return deduped.join(" ");
    }

    text
}

/// Reproduce Python's `re.split(r"(?<=[.!?…])\s+", text)`.
///
/// A split happens at each position right after a `[.!?…]` character that is
/// followed by one or more whitespace characters. The punctuation stays on the
/// preceding part; the whole whitespace run is consumed.
fn split_after_sentence_punct(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut parts: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut i = 0usize;
    while i < chars.len() {
        let c = chars[i];
        current.push(c);
        // Need: a leading whitespace run to consume (re.split only splits when
        // `\s+` matches at least one char).
        if matches!(c, '.' | '!' | '?' | '…') && i + 1 < chars.len() && chars[i + 1].is_whitespace() {
            let mut j = i + 1;
            while j < chars.len() && chars[j].is_whitespace() {
                j += 1;
            }
            parts.push(std::mem::take(&mut current));
            i = j;
            continue;
        }
        i += 1;
    }
    parts.push(current);
    parts
}

// ── Hallucination filtering (stt.py) ─────────────────────────────────────────

fn hallucination_res() -> &'static Vec<Regex> {
    static RES: OnceLock<Vec<Regex>> = OnceLock::new();
    RES.get_or_init(|| {
        HALLUCINATION_PATTERNS
            .iter()
            .map(|p| Regex::new(&format!("(?i){p}")).expect("valid hallucination pattern"))
            .collect()
    })
}

/// Filter out hallucinated text from STT output.
///
/// The <=3 char rule exists because cloud STT sometimes emits stray 1-3 char
/// noise on silence. It must NOT apply to the streaming path, where each short
/// utterance is its own segment — legit Vietnamese replies ("OK", "Vâng", "Dạ",
/// "Ừ", "Đúng") are 2-4 chars and were being silently dropped. Callers that need
/// the noise guard use [`filter_hallucinations_min_chars`].
pub fn filter_hallucinations(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    for re in hallucination_res().iter() {
        if re.is_match(text) {
            return String::new();
        }
    }
    text.to_string()
}

/// Cloud-path variant: also drops sub-`min_chars` noise blips.
pub fn filter_hallucinations_min_chars(text: &str, min_chars: usize) -> String {
    let text = filter_hallucinations(text);
    if !text.is_empty() && text.chars().count() < min_chars {
        return String::new();
    }
    text
}

// ── Vietnamese normalization (stt.py `normalize_vietnamese_text`) ────────────

/// Lowercase everything, only capitalize first word of each sentence.
/// Keep acronyms (all-caps 2-5 chars) like AI, CNTT, ASEAN.
pub fn normalize_vietnamese_text(text: &str) -> String {
    if text.is_empty() {
        return text.to_string();
    }

    let sentences = split_after_sentence_punct(text);
    let mut result: Vec<String> = Vec::new();

    for sentence in sentences {
        if sentence.is_empty() {
            continue;
        }
        let words: Vec<&str> = sentence.split_whitespace().collect();
        if words.is_empty() {
            continue;
        }

        let mut normalized: Vec<String> = Vec::with_capacity(words.len());
        for (i, word) in words.iter().enumerate() {
            let wchars: Vec<char> = word.chars().collect();
            // Keep acronyms (all-caps, 2-5 chars).
            // Python `str.isupper()` requires >=1 cased char and no lowercase ones.
            if is_upper_str(word) && (2..=5).contains(&wchars.len()) {
                normalized.push((*word).to_string());
            } else if i == 0 {
                // Capitalize first word of sentence
                if wchars.len() > 1 {
                    let first = wchars[0].to_uppercase().collect::<String>();
                    let rest: String = wchars[1..].iter().collect::<String>().to_lowercase();
                    normalized.push(format!("{first}{rest}"));
                } else {
                    normalized.push(word.to_uppercase());
                }
            } else {
                normalized.push(word.to_lowercase());
            }
        }

        result.push(normalized.join(" "));
    }

    result.join(" ")
}

/// Python `str.isupper()`: at least one cased character and no lowercase cased
/// character.
fn is_upper_str(s: &str) -> bool {
    let mut has_cased = false;
    for c in s.chars() {
        if c.is_lowercase() {
            return false;
        }
        if c.is_uppercase() {
            has_cased = true;
        }
    }
    has_cased
}

// ── Shared local-engine pipeline (local_stt.py `_postprocess_local`) ─────────

/// Shared text cleanup for local engines (repeat collapse + case + VI
/// normalization + hallucination filter).
///
/// Regression 2026-10-09: the interim preview used to return RAW recognizer
/// output, so the live row was unpunctuated ALL-CAPS while committed finals
/// looked normal. Interim and final MUST go through the same pipeline — this
/// single function is what both paths call.
pub fn postprocess_local(text: &str, language: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    let text = collapse_repeats(text);
    let text = maybe_lowercase_allcaps(&text);
    let text = if language.starts_with("vi") {
        normalize_vietnamese_text(&text)
    } else {
        text
    };
    filter_hallucinations(&text)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── PCM ──────────────────────────────────────────────────────────────

    #[test]
    fn pcm_conversion_normalizes() {
        // int16 min -> -1.0 ; 0 -> 0.0
        let mut pcm = Vec::new();
        pcm.extend_from_slice(&(-32768i16).to_le_bytes());
        pcm.extend_from_slice(&0i16.to_le_bytes());
        let out = pcm_i16_to_f32(&pcm);
        assert_eq!(out.len(), 2);
        assert!((out[0] - (-1.0)).abs() < 1e-4);
        assert!(out[1].abs() < 1e-4);
    }

    // ── all-caps ─────────────────────────────────────────────────────────

    #[test]
    fn allcaps_leaves_mixed_case() {
        assert_eq!(
            maybe_lowercase_allcaps("Xin chào mọi người"),
            "Xin chào mọi người"
        );
        assert_eq!(maybe_lowercase_allcaps("ÂM LƯỢNG TV GIẢM"), "âm lượng tv giảm");
    }

    #[test]
    fn mixed_case_segment_is_normalised() {
        // Regression 2026-10-09: the >70%-uppercase rule missed mixed segments
        // from the streaming model ("POPPY vào trong").
        assert_eq!(maybe_lowercase_allcaps("POPPY vào trong"), "poppy vào trong");
        assert_eq!(
            maybe_lowercase_allcaps("NHƯNG TUY NHIÊN Ở OCB"),
            "nhưng tuy nhiên ở ocb"
        );
        // Already-proper text (cloud providers) is left alone.
        assert_eq!(
            maybe_lowercase_allcaps("Poppy vào trong"),
            "Poppy vào trong"
        );
        assert_eq!(
            maybe_lowercase_allcaps("Chạy lí từ các đối tác"),
            "Chạy lí từ các đối tác"
        );
    }

    // ── repeat collapse ──────────────────────────────────────────────────

    #[test]
    fn collapse_repeats_kills_phrase_stall() {
        // Reported bug 2026-10-09: a long unbroken segment made the streaming
        // model emit the same phrase over and over, flooding the transcript.
        let spam = vec!["Poppy vào trong cái capid đó"; 8].join(" ");
        assert_eq!(collapse_repeats(&spam), "Poppy vào trong cái capid đó");
        assert_eq!(collapse_repeats(&"đúng rồi ".repeat(5)), "đúng rồi");
    }

    #[test]
    fn collapse_repeats_caps_token_stall_at_two() {
        assert_eq!(collapse_repeats("nút nút nút nút"), "nút nút");
        assert_eq!(collapse_repeats("nó nó nó nó nó nó"), "nó nó");
        assert_eq!(collapse_repeats("là là là là"), "là là");
    }

    #[test]
    fn collapse_repeats_preserves_vietnamese_reduplication() {
        // Two identical words in a row is normal Vietnamese (từ láy) — kept.
        for natural in ["rất rất thích", "từ từ đã", "nó nó"] {
            assert_eq!(collapse_repeats(natural), natural);
        }
    }

    #[test]
    fn collapse_repeats_leaves_ordinary_speech_untouched() {
        let sentence =
            "Poppy vào trong cái capid đó đúng không thì cái đấy nó là một cái tình huống";
        assert_eq!(collapse_repeats(sentence), sentence);
    }

    #[test]
    fn collapse_repeats_drops_consecutive_identical_sentences() {
        assert_eq!(
            collapse_repeats("Xin chào. Xin chào. Cảm ơn."),
            "Xin chào. Cảm ơn."
        );
    }

    // ── hallucinations ───────────────────────────────────────────────────

    #[test]
    fn hallucination_patterns_are_dropped() {
        assert_eq!(filter_hallucinations("hãy subscribe cho kênh"), "");
        assert_eq!(
            filter_hallucinations_min_chars("hãy subscribe cho kênh", 4),
            ""
        );
        assert_eq!(filter_hallucinations("meeting"), "");
        assert_eq!(filter_hallucinations("..."), "");
    }

    #[test]
    fn streaming_keeps_short_vietnamese_replies() {
        // Regression 2026-10-09: filter_hallucinations dropped every text <=3
        // chars, so streaming segments like 'OK' / 'Vâng' / 'Dạ' vanished.
        for reply in ["OK", "Vâng", "Dạ", "Ừ", "Đúng"] {
            assert_eq!(filter_hallucinations(reply), reply);
        }
        // Cloud path still suppresses 1-3 char noise blips.
        assert_eq!(filter_hallucinations_min_chars("OK", 4), "");
    }

    // ── normalize ────────────────────────────────────────────────────────

    #[test]
    fn normalize_capitalizes_sentence_start_only() {
        assert_eq!(
            normalize_vietnamese_text("rồi cũng hỗ trợ cho lâu lâu"),
            "Rồi cũng hỗ trợ cho lâu lâu"
        );
        // Acronyms 2-5 chars survive.
        assert_eq!(normalize_vietnamese_text("dùng AI và CNTT"), "Dùng AI và CNTT");
    }

    #[test]
    fn interim_preview_is_normalised_like_final() {
        // Regression 2026-10-09: the interim preview showed RAW recognizer
        // output (unpunctuated ALL-CAPS) while committed finals were normalised.
        let raw = "À MẤY CÁI ÔNG GIÁO SƯ ĐẠI HỌC ÔNG LÀM CÁI GÌ";
        let shown = postprocess_local(raw, "vi");
        assert_ne!(shown, raw, "interim text must go through post-processing");
        let letters: Vec<char> = shown.chars().filter(|c| c.is_alphabetic()).collect();
        let upper = letters.iter().filter(|c| c.is_uppercase()).count();
        let ratio = upper as f64 / letters.len() as f64;
        assert!(ratio < 0.3, "interim still shouting: {shown:?}");
        assert!(shown.starts_with('À'), "sentence case restored: {shown:?}");
    }

    #[test]
    fn postprocess_pipeline_matches_expected_order() {
        // collapse -> lowercase -> normalize -> filter
        assert_eq!(
            postprocess_local("XIN CHÀO MỌI NGƯỜI", "vi"),
            "Xin chào mọi người"
        );
        assert_eq!(postprocess_local("hãy subscribe cho kênh", "vi"), "");
    }

    // ── wav ──────────────────────────────────────────────────────────────

    #[test]
    fn strip_wav_header_extracts_data_chunk() {
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&100u32.to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&[0u8; 24]);
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&4u32.to_le_bytes());
        wav.extend_from_slice(&[1, 2, 3, 4, 9, 9]);
        assert_eq!(strip_wav_header(&wav), vec![1u8, 2, 3, 4]);
    }

    #[test]
    fn strip_wav_header_passthrough_for_non_riff() {
        let junk = vec![0u8; 10];
        assert_eq!(strip_wav_header(&junk), junk);
    }
}
