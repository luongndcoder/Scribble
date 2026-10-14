//! Boot-time recovery of uploads cut short by a crash/quit
//! (`api::upload::recover_stuck_uploads`): an "uploading" meeting with a
//! transcript becomes "saved"; one without is deleted together with its audio.

#[test]
fn stuck_uploads_are_settled_on_boot() {
    let dir = std::env::temp_dir().join(format!("scribble-recovery-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let db = voicescribe_lib::db::Database::init(Some(dir.join("voicescribe.db"))).unwrap();

    let parts = r#"[{"text":"xin chào","speaker":"Speaker 1"}]"#;
    let with_text = db.create_meeting("a", parts, "", 10.0, "vi", "uploading").unwrap();
    let empty = db.create_meeting("b", "", "", 0.0, "vi", "uploading").unwrap();
    let saved = db.create_meeting("c", "", "", 0.0, "vi", "saved").unwrap();
    let audio = dir.join("meeting_b.wav");
    std::fs::write(&audio, b"RIFF").unwrap();
    let mut upd = serde_json::Map::new();
    upd.insert("audio_path".into(), serde_json::json!(audio.to_string_lossy()));
    db.update_meeting(empty, &upd).unwrap();

    voicescribe_lib::api::upload::recover_stuck_uploads(db);

    let status = |id| db.get_meeting(id).unwrap().map(|m| m["status"].as_str().unwrap().to_string());
    assert_eq!(status(with_text).as_deref(), Some("saved"));
    assert_eq!(status(empty), None, "empty stuck upload must be deleted");
    assert!(!audio.exists(), "its audio must be deleted too");
    assert_eq!(status(saved).as_deref(), Some("saved"), "other meetings untouched");

    let _ = std::fs::remove_dir_all(&dir);
}
