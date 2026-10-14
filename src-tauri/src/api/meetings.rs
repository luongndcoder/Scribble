//! Meetings API — CRUD for meetings.
//!
//! Port of the CRUD half of `src-python/api/meetings.py`. The audio/minutes
//! export routes in that file are out of scope for this task.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Map, Value};

use super::AppState;

/// `GET /meetings`
pub async fn list_meetings(State(state): State<AppState>) -> Response {
    match state.db().get_all_meetings() {
        Ok(rows) => Json(Value::Array(rows)).into_response(),
        Err(e) => internal_error(&e),
    }
}

/// `POST /meetings`
///
/// `transcript` may arrive as a JSON array (frontend sends structured
/// segments), in which case it is stored as its JSON text — same as
/// `json.dumps(...)` in Python.
pub async fn create_meeting(State(state): State<AppState>, body: Option<Json<Value>>) -> Response {
    let body = body.map(|Json(v)| v).unwrap_or_else(|| json!({}));
    let obj = body.as_object().cloned().unwrap_or_default();

    let title = get_str(&obj, "title").unwrap_or_else(|| "Untitled".to_string());
    let transcript = match obj.get("transcript") {
        // Python json.dumps(list) — Python separators, order preserved.
        Some(v @ Value::Array(_)) => super::pyjson::dumps(v),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    };
    let summary = get_str(&obj, "summary").unwrap_or_default();
    let audio_duration = obj
        .get("audioDuration")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let language = get_str(&obj, "language").unwrap_or_else(|| "vi".to_string());

    match state
        .db()
        .create_meeting(&title, &transcript, &summary, audio_duration, &language, "saved")
    {
        Ok(id) => Json(json!({ "id": id })).into_response(),
        Err(e) => internal_error(&e),
    }
}

/// `GET /meetings/{id}`
pub async fn get_meeting(State(state): State<AppState>, Path(id): Path<i64>) -> Response {
    match state.db().get_meeting(id) {
        Ok(Some(m)) => Json(m).into_response(),
        Ok(None) => not_found("Not found"),
        Err(e) => internal_error(&e),
    }
}

/// `PUT /meetings/{id}` — whitelisted camelCase → snake_case column mapping.
pub async fn update_meeting(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    body: Option<Json<Value>>,
) -> Response {
    match state.db().get_meeting(id) {
        Ok(None) => return not_found("Not found"),
        Err(e) => return internal_error(&e),
        Ok(Some(_)) => {}
    }

    let body = body.map(|Json(v)| v).unwrap_or_else(|| json!({}));
    let obj = body.as_object().cloned().unwrap_or_default();

    const KEY_MAP: &[(&str, &str)] = &[
        ("title", "title"),
        ("transcript", "transcript"),
        ("summary", "summary"),
        ("translations", "translations"),
        ("audioDuration", "audio_duration"),
        ("language", "language"),
        ("status", "status"),
        ("audioPath", "audio_path"),
    ];

    let mut updates = Map::new();
    for (js_key, db_key) in KEY_MAP {
        if let Some(val) = obj.get(*js_key) {
            // A list value is serialised to JSON text (Python json.dumps).
            let val = match val {
                Value::Array(_) => Value::String(super::pyjson::dumps(val)),
                other => other.clone(),
            };
            updates.insert((*db_key).to_string(), val);
        }
    }

    if !updates.is_empty() {
        if let Err(e) = state.db().update_meeting(id, &updates) {
            return internal_error(&e);
        }
    }
    Json(json!({ "ok": true })).into_response()
}

/// `DELETE /meetings/{id}` — always `{ok:true}`, even for an unknown id.
pub async fn delete_meeting(State(state): State<AppState>, Path(id): Path<i64>) -> Response {
    match state.db().delete_meeting(id) {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(e) => internal_error(&e),
    }
}

fn get_str(obj: &Map<String, Value>, key: &str) -> Option<String> {
    obj.get(key).and_then(|v| match v {
        Value::String(s) => Some(s.clone()),
        Value::Null => None,
        other => Some(other.to_string()),
    })
}

pub(crate) fn not_found(msg: &str) -> Response {
    (StatusCode::NOT_FOUND, Json(json!({ "error": msg }))).into_response()
}

pub(crate) fn internal_error(e: &str) -> Response {
    log::error!("[api] {e}");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": e })),
    )
        .into_response()
}
