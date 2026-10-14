//! Python-compatible JSON serialisation.
//!
//! `serde_json`'s compact `to_string` differs from Python's `json.dumps` in two
//! ways that are observable in the database and therefore in the API contract:
//!
//! | value                      | Python `json.dumps`        | `serde_json::to_string` |
//! |----------------------------|----------------------------|-------------------------|
//! | `[{"text": "a"}, {"b":1}]` | `[{"text": "a"}, {"b": 1}]`| `[{"text":"a"},{"b":1}]`|
//!
//! Python's defaults are `separators=(', ', ': ')` with `ensure_ascii=False`
//! (the Python code passes `ensure_ascii=False` explicitly in drafts.py).
//!
//! Key ORDER also matters: Python preserves insertion order, but
//! `serde_json::Map` is BTree-backed by default. Rather than enable the
//! `preserve_order` feature (which would change `Map` behaviour crate-wide and
//! affect the frontend payloads), the ordered representation used when merging
//! draft parts is serialised here from an explicit sequence.

use serde_json::Value;

/// Serialise like Python's `json.dumps(value, ensure_ascii=False)`.
pub fn dumps(value: &Value) -> String {
    let mut out = String::new();
    write_value(value, &mut out);
    out
}

/// Append `value` in Python `json.dumps` form to an existing buffer.
pub fn dumps_into(value: &Value, out: &mut String) {
    write_value(value, out);
}

/// Serialise an insertion-ordered object.
///
/// Used for the draft-part merge, where CPython's `dict` preserves the order in
/// which keys were first set. A `serde_json::Map` would sort them instead.
pub fn dumps_ordered(items: &[(String, Value)], out: &mut String) {
    out.push('{');
    for (i, (k, v)) in items.iter().enumerate() {
        if i > 0 {
            out.push_str(", ");
        }
        write_string(k, out);
        out.push_str(": ");
        write_value(v, out);
    }
    out.push('}');
}

/// Convenience wrapper returning a `String`.
pub fn dumps_ordered_string(items: &[(String, Value)]) -> String {
    let mut out = String::new();
    dumps_ordered(items, &mut out);
    out
}

fn write_value(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(n) => out.push_str(&n.to_string()),
        Value::String(s) => write_string(s, out),
        Value::Array(arr) => {
            out.push('[');
            for (i, v) in arr.iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                write_value(v, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            for (i, (k, v)) in map.iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                write_string(k, out);
                out.push_str(": ");
                write_value(v, out);
            }
            out.push('}');
        }
    }
}

/// JSON string escaping matching Python's `json.dumps(ensure_ascii=False)`.
///
/// Python escapes only the characters JSON requires plus the short forms; every
/// other character (including Vietnamese diacritics) is emitted literally.
fn write_string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            // C0 control characters have no short form.
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn matches_python_json_dumps_separators() {
        // Verified against CPython: json.dumps([{"text":"a"},{"text":"b"}])
        assert_eq!(
            dumps(&json!([{"text": "a"}, {"text": "b"}])),
            r#"[{"text": "a"}, {"text": "b"}]"#
        );
        assert_eq!(dumps(&json!({"t": "x"})), r#"{"t": "x"}"#);
        assert_eq!(dumps(&json!([1, 2, 3])), "[1, 2, 3]");
        assert_eq!(dumps(&json!({})), "{}");
        assert_eq!(dumps(&json!([])), "[]");
    }

    #[test]
    fn keeps_unicode_literal_like_ensure_ascii_false() {
        assert_eq!(dumps(&json!({"a": "tiếng Việt"})), r#"{"a": "tiếng Việt"}"#);
    }

    #[test]
    fn escapes_control_chars_and_quotes() {
        assert_eq!(dumps(&json!("a\"b")), r#""a\"b""#);
        assert_eq!(dumps(&json!("a\\b")), r#""a\\b""#);
        assert_eq!(dumps(&json!("a\nb")), r#""a\nb""#);
        assert_eq!(dumps(&json!("a\tb")), r#""a\tb""#);
        assert_eq!(dumps(&json!("\u{1}")), r#""\u0001""#);
    }

    #[test]
    fn floats_and_ints() {
        assert_eq!(dumps(&json!(1.5)), "1.5");
        assert_eq!(dumps(&json!(3.0)), "3.0");
        assert_eq!(dumps(&json!(7)), "7");
    }

    #[test]
    fn null_and_bool() {
        assert_eq!(dumps(&json!(null)), "null");
        assert_eq!(dumps(&json!(true)), "true");
    }
}
