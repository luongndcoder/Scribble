//! Parity check of the Rust text pipeline against the Python reference.
//!
//! Reads the JSON oracle produced by `/tmp/gen_text_oracle.py` (which calls
//! `local_stt._collapse_repeats` / `_maybe_lowercase_allcaps` / `_postprocess_local`
//! and `stt.normalize_vietnamese_text` / `filter_hallucinations*`) and asserts
//! the Rust port returns the exact same string for every case.
//!
//! Regenerate the oracle with:
//!   cd src-python && .venv/bin/python /tmp/gen_text_oracle.py
//!
//! Run this test with:
//!   cargo test --test stt_text_parity -- --nocapture

use serde_json::Value;
use voicescribe_lib::stt::text::{
    collapse_repeats, filter_hallucinations, filter_hallucinations_min_chars,
    maybe_lowercase_allcaps, normalize_vietnamese_text, postprocess_local,
};

const ORACLE: &str = "/tmp/py_text_oracle.json";

#[test]
fn text_pipeline_matches_python_oracle() {
    let raw = match std::fs::read_to_string(ORACLE) {
        Ok(r) => r,
        Err(_) => {
            eprintln!("SKIP: {ORACLE} not present — run /tmp/gen_text_oracle.py first");
            return;
        }
    };
    let oracle: Value = serde_json::from_str(&raw).expect("valid oracle json");

    let mut checked = 0;
    let mut failures: Vec<String> = Vec::new();

    let mut check = |section: &str, f: &dyn Fn(&str) -> String| {
        let cases = match oracle.get(section).and_then(|v| v.as_object()) {
            Some(c) => c,
            None => {
                failures.push(format!("oracle section '{section}' missing"));
                return;
            }
        };
        for (input, expected) in cases {
            let expected = expected.as_str().unwrap_or("");
            let got = f(input);
            checked += 1;
            if got != expected {
                failures.push(format!(
                    "[{section}] input={input:?}\n      python={expected:?}\n      rust  ={got:?}"
                ));
            }
        }
    };

    check("collapse", &|s| collapse_repeats(s));
    check("lowercase", &|s| maybe_lowercase_allcaps(s));
    check("normalize", &|s| normalize_vietnamese_text(s));
    check("postprocess", &|s| postprocess_local(s, "vi"));
    check("hallucination", &|s| filter_hallucinations(s));
    check("hallucination_min4", &|s| filter_hallucinations_min_chars(s, 4));

    if !failures.is_empty() {
        for f in &failures {
            eprintln!("MISMATCH {f}");
        }
        panic!("{} of {checked} text cases differ from Python", failures.len());
    }
    eprintln!("TEXT PARITY: *** all {checked} cases byte-identical to Python ***");
    assert!(checked > 30, "expected a substantive oracle, got {checked}");
}

/// The three cases the shared task names explicitly, asserted unconditionally
/// (not just when the oracle file happens to exist).
#[test]
fn board_named_repeat_cases() {
    let spam = vec!["Poppy vào trong cái capid đó"; 8].join(" ");
    assert_eq!(collapse_repeats(&spam), "Poppy vào trong cái capid đó");
    assert_eq!(collapse_repeats("nút nút nút nút"), "nút nút");
    assert_eq!(collapse_repeats("rất rất thích"), "rất rất thích");
}
