//! Split a recognizer utterance into per-speaker pieces by token timestamps.
//!
//! Sherpa reports BPE pieces (`" CHẠY"`, `" L"`, `"Í"`); a piece starting with a
//! space begins a new word. A speaker boundary must never cut a word in half,
//! so each WORD takes the speaker at its first piece and consecutive words of
//! the same speaker form one group.

/// A run of tokens `[start, end)` spoken by `speaker`.
#[derive(Debug, Clone, PartialEq)]
pub struct TokenGroup {
    pub start: usize,
    pub end: usize,
    pub speaker: i64,
}

/// Group `tokens[from..to]` by speaker, using `times[i]` (stream samples) and
/// `speaker_at` to label each word.
pub fn group_by_speaker(
    tokens: &[String],
    times: &[u64],
    from: usize,
    to: usize,
    speaker_at: impl Fn(u64) -> i64,
) -> Vec<TokenGroup> {
    let to = to.min(tokens.len()).min(times.len());
    let mut groups: Vec<TokenGroup> = Vec::new();
    let mut word_speaker = 0i64;
    for i in from..to {
        if i == from || tokens[i].starts_with(' ') {
            word_speaker = speaker_at(times[i]);
        }
        match groups.last_mut() {
            Some(g) if g.speaker == word_speaker => g.end = i + 1,
            _ => groups.push(TokenGroup { start: i, end: i + 1, speaker: word_speaker }),
        }
    }
    groups
}

/// Raw text of `tokens[start..end]` (pieces already carry their spaces).
pub fn tokens_text(tokens: &[String], start: usize, end: usize) -> String {
    tokens[start..end.min(tokens.len())].concat().trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn toks(s: &[&str]) -> Vec<String> {
        s.iter().map(|t| t.to_string()).collect()
    }

    #[test]
    fn splits_at_word_start_where_speaker_changes() {
        let t = toks(&[" XIN", " CHÀO", " CÁC", " B", "ẠN"]);
        let times = [0, 10, 20, 30, 40];
        // Speaker 1 from sample 25 on.
        let g = group_by_speaker(&t, &times, 0, 5, |s| if s >= 25 { 1 } else { 0 });
        assert_eq!(
            g,
            vec![
                TokenGroup { start: 0, end: 3, speaker: 0 },
                TokenGroup { start: 3, end: 5, speaker: 1 },
            ]
        );
        assert_eq!(tokens_text(&t, 3, 5), "BẠN");
    }

    #[test]
    fn never_cuts_inside_a_word() {
        // The change falls on the second piece of "BẠN" — the whole word goes
        // to the speaker of its first piece.
        let t = toks(&[" XIN", " B", "ẠN"]);
        let times = [0, 10, 20];
        let g = group_by_speaker(&t, &times, 0, 3, |s| if s >= 15 { 1 } else { 0 });
        assert_eq!(g, vec![TokenGroup { start: 0, end: 3, speaker: 0 }]);
    }

    #[test]
    fn respects_from_offset() {
        let t = toks(&[" A", " B", " C"]);
        let times = [0, 10, 20];
        let g = group_by_speaker(&t, &times, 1, 3, |_| 2);
        assert_eq!(g, vec![TokenGroup { start: 1, end: 3, speaker: 2 }]);
    }
}
