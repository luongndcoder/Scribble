//! Settings API — `GET/POST /settings`, `GET /models`.
//!
//! Port of `src-python/api/settings.py`.

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Map, Value};

use super::AppState;

/// Keys masked in the `GET /settings` response.
const SENSITIVE_KEYS: &[&str] = &["nvidia_api_key", "llm_api_key", "soniox_api_key"];

/// Provider → base URL, identical to `_PROVIDER_URLS`.
fn provider_url(provider: &str) -> Option<&'static str> {
    match provider {
        "openai" => Some("https://api.openai.com/v1"),
        "mistral" => Some("https://api.mistral.ai/v1"),
        "groq" => Some("https://api.groq.com/openai/v1"),
        "deepseek" => Some("https://api.deepseek.com/v1"),
        "openrouter" => Some("https://openrouter.ai/api/v1"),
        "gemini" => Some("https://generativelanguage.googleapis.com/v1beta/openai"),
        _ => None,
    }
}

/// Mask sensitive API keys, keeping first 4 and last 4 characters.
///
/// Must match `_mask_value` exactly:
///   - only for sensitive keys
///   - a falsy (empty) value is returned as-is
///   - values shorter than 8 characters are returned unmasked
///
/// Length is measured in Unicode scalar values (Rust `chars`), matching
/// Python's `len()` on `str`.
pub fn mask_value(key: &str, value: &str) -> String {
    if !SENSITIVE_KEYS.contains(&key) || value.is_empty() {
        return value.to_string();
    }
    let chars: Vec<char> = value.chars().collect();
    if chars.len() < 8 {
        return value.to_string();
    }
    let head: String = chars[..4].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{head}***{tail}")
}

/// `GET /settings` — every setting, sensitive values masked.
pub async fn get_settings(State(state): State<AppState>) -> Response {
    let raw = match state.db().get_all_settings() {
        Ok(m) => m,
        Err(e) => return internal_error(&e),
    };
    let mut out = Map::new();
    for (k, v) in raw {
        let s = v.as_str().unwrap_or_default();
        out.insert(k.clone(), Value::String(mask_value(&k, s)));
    }
    Json(Value::Object(out)).into_response()
}

/// `POST /settings` — upsert every provided key.
///
/// Python stringifies each value with `str(value)`; JSON scalars map to their
/// natural text form, and `null` maps to `"None"` (Python's `str(None)`).
/// Bodies that are not JSON objects are accepted (Python's `body.items()` on a
/// list would raise, so we mirror the useful subset: objects are applied,
/// anything else is a no-op success).
pub async fn save_settings(
    State(state): State<AppState>,
    body: Option<Json<Value>>,
) -> Response {
    let Some(Json(body)) = body else {
        return Json(json!({ "ok": true })).into_response();
    };

    let Some(obj) = body.as_object() else {
        return Json(json!({ "ok": true })).into_response();
    };

    for (key, value) in obj {
        if let Err(e) = state.db().set_setting(key, &python_str(value)) {
            return internal_error(&e);
        }
    }

    // Python reset the Nvidia/Riva ASR cache here when the STT language changed
    // or a key was replaced. Nvidia/Riva is being dropped from the app, and the
    // Soniox client holds no long-lived ASR cache, so there is nothing to reset.
    Json(json!({ "ok": true })).into_response()
}

/// `str(value)` semantics for JSON values.
fn python_str(v: &Value) -> String {
    match v {
        Value::Null => "None".to_string(),
        Value::String(s) => s.clone(),
        Value::Bool(b) => {
            if *b {
                "True".to_string()
            } else {
                "False".to_string()
            }
        }
        Value::Number(n) => n.to_string(),
        // Python's str() on a container emits Python repr; JSON text is the
        // closest stable equivalent and no current caller sends containers.
        other => other.to_string(),
    }
}

#[derive(Deserialize)]
pub struct ModelsQuery {
    pub provider: Option<String>,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub base_url: String,
}

/// `GET /models` — proxy the provider's model list.
pub async fn list_models(
    State(state): State<AppState>,
    Query(q): Query<ModelsQuery>,
) -> Response {
    let provider = q.provider.unwrap_or_default();

    let url = if provider == "compatible" {
        let u = q.base_url.trim_end_matches('/').to_string();
        if u.is_empty() {
            return Json(json!({
                "error": "base_url required for compatible provider",
                "models": []
            }))
            .into_response();
        }
        u
    } else {
        match provider_url(&provider) {
            Some(u) => u.trim_end_matches('/').to_string(),
            None => {
                return Json(json!({
                    "error": format!("Unknown provider: {provider}"),
                    "models": []
                }))
                .into_response();
            }
        }
    };

    // A masked key (contains a bullet, U+2022) is not a real key — fall back to
    // the saved one. Mirrors the Python check.
    let resolved_key = if !q.api_key.is_empty() && !q.api_key.contains('\u{2022}') {
        q.api_key.clone()
    } else {
        state
            .db()
            .get_setting("llm_api_key")
            .unwrap_or(None)
            .unwrap_or_default()
    };
    if resolved_key.is_empty() {
        return Json(json!({ "error": "API key required", "models": [] })).into_response();
    }

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return Json(json!({ "error": e.to_string(), "models": [] })).into_response();
        }
    };

    let resp = client
        .get(format!("{url}/models"))
        .header("Authorization", format!("Bearer {resolved_key}"))
        .send()
        .await;

    let resp = match resp {
        Ok(r) => r,
        Err(e) => {
            return Json(json!({ "error": e.to_string(), "models": [] })).into_response();
        }
    };

    let status = resp.status();
    if status != StatusCode::OK {
        return Json(json!({
            "error": format!("Provider returned {}", status.as_u16()),
            "models": []
        }))
        .into_response();
    }

    let data: Value = match resp.json().await {
        Ok(d) => d,
        Err(e) => {
            return Json(json!({ "error": e.to_string(), "models": [] })).into_response();
        }
    };

    // OpenAI-compatible: {"data":[{"id":...}]} / Gemini: {"models":[{"name":...}]}
    let mut ids: Vec<String> = if let Some(arr) = data.get("data").and_then(|d| d.as_array()) {
        arr.iter()
            .filter_map(|m| m.get("id").and_then(|i| i.as_str()))
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect()
    } else if let Some(arr) = data.get("models").and_then(|d| d.as_array()) {
        arr.iter()
            .filter_map(|m| m.get("name").and_then(|n| n.as_str()))
            .filter(|s| !s.is_empty())
            .map(|s| s.replace("models/", ""))
            .collect()
    } else {
        Vec::new()
    };

    ids.sort();
    log::info!("[models] {provider}: {} models fetched", ids.len());
    Json(json!({ "models": ids })).into_response()
}

fn internal_error(e: &str) -> Response {
    log::error!("[settings] {e}");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": e })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mask_matches_python_semantics() {
        // Real values observed from the Python sidecar.
        assert_eq!(
            mask_value("llm_api_key", "sk-6eee1868ea774d56a9b4de502ea0aafa"),
            "sk-6***aafa"
        );
        assert_eq!(
            mask_value(
                "soniox_api_key",
                "c41e57051d09abd9739ef018d0bf1bd45559ceb5dcc30f53281f218b427d88c0"
            ),
            "c41e***88c0"
        );
        // Empty sensitive value: returned as-is (no "***").
        assert_eq!(mask_value("nvidia_api_key", ""), "");
        // Exactly 8 chars -> masked (Python uses `len < 8` as the guard).
        assert_eq!(mask_value("llm_api_key", "12345678"), "1234***5678");
        // 7 chars -> returned unmasked.
        assert_eq!(mask_value("llm_api_key", "1234567"), "1234567");
        // Non-sensitive keys are never masked.
        assert_eq!(
            mask_value("llm_base_url", "https://proxy.ndl.info.vn/v1"),
            "https://proxy.ndl.info.vn/v1"
        );
        assert_eq!(mask_value("app_language", "vi"), "vi");
        // A real key that happens to be exactly 4 chars is short -> unmasked.
        assert_eq!(mask_value("llm_api_key", "abcd"), "abcd");
    }

    #[test]
    fn python_str_mapping() {
        assert_eq!(python_str(&json!("x")), "x");
        assert_eq!(python_str(&json!(7)), "7");
        assert_eq!(python_str(&json!(1.5)), "1.5");
        assert_eq!(python_str(&json!(true)), "True");
        assert_eq!(python_str(&json!(false)), "False");
        assert_eq!(python_str(&json!(null)), "None");
    }
}
