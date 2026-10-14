//! Drafts API — draft creation and incremental transcript append.
//!
//! Port of `src-python/api/drafts.py` (JSON routes only; the multipart
//! `/drafts/{id}/audio` upload belongs with the upload pipeline work).

use axum::{
    extract::{Path, State},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Map, Value};

use super::meetings::{internal_error, not_found};
use super::pyjson;
use super::AppState;

/// Insertion-ordered JSON object. Python preserved the incoming key order of
/// `dict(last)` + `update(part)`; a plain `serde_json::Map` is BTree-backed
/// unless the `preserve_order` feature is on, so ordering is carried explicitly
/// and emitted via `pyjson` so the stored text matches `json.dumps` byte for
/// byte.
type Ordered = Vec<(String, Value)>;

/// `POST /drafts` — create an empty draft row.
pub async fn create_draft(State(state): State<AppState>, body: Option<Json<Value>>) -> Response {
    let body = body.map(|Json(v)| v).unwrap_or_else(|| json!({}));
    let title = body
        .get("title")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        // Python: body.get("title", "Draft") — a present JSON null becomes None
        // and would be written as NULL, so treat null/missing alike here.
        .unwrap_or_else(|| "Draft".to_string());

    match state
        .db()
        .create_meeting(&title, "", "", 0.0, "vi", "draft")
    {
        Ok(id) => Json(json!({ "id": id })).into_response(),
        Err(e) => internal_error(&e),
    }
}

/// `PATCH /drafts/{id}` — append text or merge a structured transcript part.
pub async fn append_draft(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    body: Option<Json<Value>>,
) -> Response {
    let existing = match state.db().get_meeting(id) {
        Ok(Some(m)) => m,
        Ok(None) => return not_found("Draft not found"),
        Err(e) => return internal_error(&e),
    };

    let body = body.map(|Json(v)| v).unwrap_or_else(|| json!({}));
    let duration = body
        .get("audioDuration")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let part = body.get("part").filter(|v| !v.is_null()).cloned();
    let append_text = body
        .get("appendText")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    let current = existing
        .get("transcript")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    if let Some(part) = part {
        // Parse the existing transcript only when it looks like a JSON array.
        // Elements are kept as raw Values so their key order survives verbatim.
        let mut parts: Vec<Value> = if current.starts_with('[') {
            serde_json::from_str::<Value>(&current)
                .ok()
                .and_then(|v| v.as_array().cloned())
                .unwrap_or_default()
        } else {
            Vec::new()
        };

        let mut replaced = false;
        let mut merged_ordered: Option<Ordered> = None;

        if let (Some(last), Some(part_obj)) = (parts.last(), part.as_object()) {
            if let Some(last_obj) = last.as_object() {
                let same_speaker =
                    str_of(last_obj.get("speakerId")) == str_of(part_obj.get("speakerId"))
                        || str_of(last_obj.get("speaker")) == str_of(part_obj.get("speaker"));
                let same_start =
                    str_of(last_obj.get("startTime")) == str_of(part_obj.get("startTime"));

                if same_speaker && same_start {
                    // merged = dict(last); merged.update(part) — keys keep the
                    // position they had in `last`, new keys append in `part`
                    // order (CPython dict semantics).
                    let mut merged: Ordered = last_obj
                        .iter()
                        .map(|(k, v)| (k.clone(), v.clone()))
                        .collect();
                    for (k, v) in part_obj {
                        match merged.iter_mut().find(|(mk, _)| mk == k) {
                            Some(slot) => slot.1 = v.clone(),
                            None => merged.push((k.clone(), v.clone())),
                        }
                    }

                    // Union of chunkIds, preserving first-seen order, only when
                    // BOTH sides carried a list.
                    let last_ids = last_obj.get("chunkIds").and_then(Value::as_array);
                    let part_ids = part_obj.get("chunkIds").and_then(Value::as_array);
                    if let (Some(a), Some(b)) = (last_ids, part_ids) {
                        let mut ids: Vec<String> = Vec::new();
                        for cid in a.iter().chain(b.iter()) {
                            if let Some(s) = cid.as_str() {
                                if !s.is_empty() && !ids.iter().any(|x| x == s) {
                                    ids.push(s.to_string());
                                }
                            }
                        }
                        if !ids.is_empty() {
                            let new_val =
                                Value::Array(ids.into_iter().map(Value::String).collect());
                            match merged.iter_mut().find(|(k, _)| k == "chunkIds") {
                                Some(slot) => slot.1 = new_val,
                                None => merged.push(("chunkIds".into(), new_val)),
                            }
                        }
                    }

                    merged_ordered = Some(merged);
                    replaced = true;
                }
            }
        }

        if replaced {
            parts.pop();
            // Placeholder; the ordered form is spliced in during serialisation.
            parts.push(Value::Null);
        } else {
            parts.push(part);
        }

        // Serialise with Python's separators. A merged last part is written from
        // its ordered key list so key order matches CPython.
        let mut transcript = String::from("[");
        for i in 0..parts.len() {
            if i > 0 {
                transcript.push_str(", ");
            }
            let is_merged_last = replaced && i == parts.len() - 1;
            if is_merged_last {
                pyjson::dumps_ordered(merged_ordered.as_ref().unwrap(), &mut transcript);
            } else {
                pyjson::dumps_into(&parts[i], &mut transcript);
            }
        }
        transcript.push(']');

        let mut upd = Map::new();
        upd.insert("transcript".into(), Value::String(transcript));
        upd.insert("audio_duration".into(), json!(duration));
        if let Err(e) = state.db().update_meeting(id, &upd) {
            return internal_error(&e);
        }
    } else if !append_text.is_empty() {
        let mut upd = Map::new();
        upd.insert(
            "transcript".into(),
            Value::String(format!("{current}\n{append_text}")),
        );
        upd.insert("audio_duration".into(), json!(duration));
        if let Err(e) = state.db().update_meeting(id, &upd) {
            return internal_error(&e);
        }
    }
    // Neither `part` nor `appendText` -> no write, but still {ok:true}
    // (Python returns before touching the row).

    Json(json!({ "ok": true })).into_response()
}

/// Python `str(value)` for the merge comparison. Missing key -> `"None"`.
fn str_of(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => "None".to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => if *b { "True" } else { "False" }.to_string(),
        Some(Value::Number(n)) => n.to_string(),
        Some(other) => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn str_of_matches_python_str() {
        assert_eq!(str_of(None), "None");
        assert_eq!(str_of(Some(&json!(null))), "None");
        assert_eq!(str_of(Some(&json!(100))), "100");
        // "100" (string) vs 100 (number) must compare equal, as in Python where
        // str(100) == "100".
        assert_eq!(str_of(Some(&json!("100"))), str_of(Some(&json!(100))));
        assert_eq!(str_of(Some(&json!("Speaker 1"))), "Speaker 1");
        assert_eq!(str_of(Some(&json!(1.5))), "1.5");
    }

    /// The merge path must emit keys in CPython dict order, not alphabetically.
    #[test]
    fn merged_part_keeps_cpython_key_order() {
        let last = json!({
            "text": "câu một", "speaker": "Speaker 1", "speakerId": 100,
            "startTime": "1", "endTime": "3", "chunkId": "c1", "chunkIds": ["c1"]
        });
        let part = json!({
            "text": "câu một mở rộng", "speaker": "Speaker 1", "speakerId": 100,
            "startTime": "1", "endTime": "5", "chunkId": "c2", "chunkIds": ["c2", "c1"]
        });
        let mut merged: Ordered = last
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        for (k, v) in part.as_object().unwrap() {
            match merged.iter_mut().find(|(mk, _)| mk == k) {
                Some(slot) => slot.1 = v.clone(),
                None => merged.push((k.clone(), v.clone())),
            }
        }
        let mut out = String::new();
        pyjson::dumps_ordered(&merged, &mut out);
        assert_eq!(
            out,
            r#"{"text": "câu một mở rộng", "speaker": "Speaker 1", "speakerId": 100, "startTime": "1", "endTime": "5", "chunkId": "c2", "chunkIds": ["c2", "c1"]}"#
        );
    }

    /// `preserve_order` must be ON for serde_json. Without it, parsing a request
    /// body reorders keys alphabetically and the stored transcript text diverges
    /// from Python's `json.dumps` output. This test fails loudly if the feature
    /// is ever dropped from Cargo.toml.
    #[test]
    fn serde_json_preserves_source_key_order() {
        let src = r#"{"text": "a", "speaker": "S1", "speakerId": 100, "startTime": "1"}"#;
        let parsed: Value = serde_json::from_str(src).unwrap();
        let keys: Vec<&String> = parsed.as_object().unwrap().keys().collect();
        assert_eq!(
            keys,
            vec!["text", "speaker", "speakerId", "startTime"],
            "serde_json sorted the keys — enable the `preserve_order` feature"
        );
    }
}
