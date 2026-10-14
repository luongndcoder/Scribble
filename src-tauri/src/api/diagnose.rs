//! `GET /diagnose` — connectivity self-check for the Settings panel.
//!
//! Ported from `src-python/api/diagnose.py`, minus the Nvidia/Riva branch
//! (removed with the rest of Riva). Checks the two things that can actually be
//! misconfigured now: Soniox (cloud STT, needs a key) and the LLM provider.
//! Local STT is always ready because the model ships inside the app.
//!
//! The frontend shows the raw `message` string, so these are user-facing
//! Vietnamese/English strings rather than error codes.

use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

use super::AppState;

/// Picks the user-facing message language.
fn t(key: &str, lang: &str) -> &'static str {
    let vi = lang == "vi";
    match (key, vi) {
        ("local_stt_ready", true) => "Chạy offline trên máy — sẵn sàng, không cần mã truy cập",
        ("local_stt_ready", false) => "Runs offline on-device — ready, no access key needed",
        ("local_model_missing", true) => "Model nhận diện offline chưa sẵn sàng",
        ("local_model_missing", false) => "Offline speech model is not ready",
        ("nemotron_missing", true) => "Đã chọn Nemotron nhưng model chưa tải — vào Cài đặt để tải",
        ("nemotron_missing", false) => "Nemotron is selected but not downloaded — download it in Settings",
        ("soniox_key_missing", true) => "Chưa nhập mã truy cập Soniox",
        ("soniox_key_missing", false) => "Soniox access key not set",
        ("soniox_connected", true) => "Soniox đã kết nối thành công",
        ("soniox_connected", false) => "Soniox connected successfully",
        ("soniox_connect_fail", true) => "Không thể kết nối Soniox",
        ("soniox_connect_fail", false) => "Cannot connect to Soniox",
        ("llm_key_missing", true) => "Chưa nhập mã truy cập AI",
        ("llm_key_missing", false) => "AI access key not set",
        ("llm_connected", true) => "Đã kết nối thành công",
        ("llm_connected", false) => "Connected successfully",
        ("llm_connect_fail", true) => "Không thể kết nối đến dịch vụ AI",
        ("llm_connect_fail", false) => "Cannot connect to AI service",
        ("llm_key_invalid", true) => "Mã truy cập AI không hợp lệ",
        ("llm_key_invalid", false) => "AI access key is invalid",
        ("network_offline", true) => "Không có kết nối mạng — kiểm tra Internet rồi thử lại",
        ("network_offline", false) => "No internet connection — check your network and retry",
        _ => "",
    }
}

/// `GET /diagnose?lang=vi|en`
pub async fn diagnose(
    axum::extract::State(state): axum::extract::State<AppState>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Response {
    let lang = params.get("lang").map(|s| s.as_str()).unwrap_or("vi").to_string();

    let stt_provider = state
        .db
        .get_setting("stt_provider")
        .ok()
        .flatten()
        .unwrap_or_else(|| "local".to_string())
        .to_lowercase();

    // ── Network probe: local STT works offline, cloud checks do not ──
    let online = super::network_status(true).await["online"]
        .as_bool()
        .unwrap_or(false);

    let stt = if stt_provider == "soniox" {
        let key = state
            .db
            .get_setting("soniox_api_key")
            .ok()
            .flatten()
            .unwrap_or_default();
        if key.is_empty() {
            json!({"status": "warning", "message": t("soniox_key_missing", &lang)})
        } else if !online {
            json!({"status": "error", "message": t("network_offline", &lang), "offline": true})
        } else {
            // A cheap authenticated call: the models list requires the key.
            match soniox_models_ok(&key).await {
                Ok(true) => json!({"status": "ok", "message": t("soniox_connected", &lang)}),
                Ok(false) => json!({"status": "error", "message": t("soniox_connect_fail", &lang)}),
                Err(e) => json!({
                    "status": "error",
                    "message": format!("{}: {}", t("soniox_connect_fail", &lang), e),
                }),
            }
        }
    } else {
        // Local / offline. Ready iff the SELECTED engine's model is on disk:
        // live recording with Nemotron fails until it is downloaded.
        let nemotron = state.db.get_setting("local_engine").ok().flatten().as_deref() == Some("nemotron");
        let ready = crate::stt::local::streaming_model_dir().is_some();
        if nemotron && crate::stt::model_download::nemotron_model_dir().is_none() {
            json!({"status": "warning", "message": t("nemotron_missing", &lang)})
        } else if ready {
            json!({"status": "ok", "message": t("local_stt_ready", &lang)})
        } else {
            json!({"status": "error", "message": t("local_model_missing", &lang)})
        }
    };

    let llm = check_llm(&state, &lang, online).await;

    Json(json!({
        "stt": stt,
        "llm": llm,
        "backend": stt_provider,
        "network": {"online": online},
    }))
    .into_response()
}

/// Probe Soniox's model list. `Ok(false)` means reachable but rejected (bad key).
async fn soniox_models_ok(api_key: &str) -> Result<bool, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get("https://api.soniox.com/v1/models")
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    Ok(resp.status().is_success())
}

/// Validate the configured LLM endpoint by listing its models.
async fn check_llm(state: &AppState, lang: &str, online: bool) -> serde_json::Value {
    let provider = state
        .db
        .get_setting("llm_provider")
        .ok()
        .flatten()
        .unwrap_or_else(|| "openai".to_string());
    let key = state
        .db
        .get_setting("llm_api_key")
        .ok()
        .flatten()
        .unwrap_or_default();

    let base = if provider == "compatible" {
        state
            .db
            .get_setting("llm_base_url")
            .ok()
            .flatten()
            .unwrap_or_default()
            .trim_end_matches('/')
            .to_string()
    } else {
        crate::llm::provider_base_url(&provider)
            .trim_end_matches('/')
            .to_string()
    };

    // Gemini and local-compatible endpoints are allowed to work without a key.
    if key.is_empty() && provider != "gemini" && provider != "compatible" {
        return json!({"status": "warning", "message": t("llm_key_missing", lang)});
    }
    if base.is_empty() {
        return json!({"status": "error", "message": "Base URL missing"});
    }
    if !online {
        return json!({"status": "error", "message": t("network_offline", lang), "offline": true});
    }

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
    {
        Ok(c) => c,
        Err(e) => return json!({"status": "error", "message": format!("{}: {e}", t("llm_connect_fail", lang))}),
    };

    match client
        .get(format!("{base}/models"))
        .bearer_auth(&key)
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => {
            json!({"status": "ok", "message": t("llm_connected", lang)})
        }
        Ok(_) => json!({"status": "error", "message": t("llm_key_invalid", lang)}),
        Err(_) => json!({"status": "error", "message": t("llm_connect_fail", lang)}),
    }
}
