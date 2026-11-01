//! My day: the owner's personal inbox, filled by the sidecar's nightly run
//! (`sidecar/src/personal/`). This side reads what the run left, keeps the
//! schedule's settings, and queues Run now for the sidecar to pick up.

use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use std::process::Command;

use chrono::{SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::State;

use crate::AppState;

const ENABLED_KEY: &str = "personal.enabled";
const ENABLED_AT_KEY: &str = "personal.enabled_at";
const RUN_TIME_KEY: &str = "personal.run_time";
const DEFAULT_RUN_TIME: &str = "22:00";
/// Done items older than this drop off the inbox; the rows stay.
const DONE_ITEM_DAYS: i64 = 7;

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MyDayItem {
    pub key: String,
    pub source: String,
    pub state: String,
    pub channel_name: Option<String>,
    pub permalink: Option<String>,
    pub asker: Option<String>,
    pub asked_at: Option<String>,
    pub ask: String,
    pub done_summary: Option<String>,
    pub reply_text: Option<String>,
    pub next_step: Option<String>,
    pub evidence: Option<String>,
    pub pr_urls: Vec<String>,
    pub job_id: Option<String>,
    pub session_id: Option<String>,
    pub first_seen_at: String,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MyDayRun {
    pub status: String,
    pub trigger: String,
    pub window_start: String,
    pub window_end: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub gaps: Vec<String>,
    pub error: Option<String>,
    pub cost_usd: f64,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MyDay {
    pub enabled: bool,
    pub run_time: String,
    /// Run now was pressed and the sidecar hasn't picked it up.
    pub run_queued: bool,
    pub last_run: Option<MyDayRun>,
    pub items: Vec<MyDayItem>,
}

fn ensure_tables(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS sidecar_state (
               key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS personal_actions (
               id TEXT PRIMARY KEY, kind TEXT NOT NULL, span TEXT, created_at TEXT NOT NULL, taken_at TEXT
             );",
        )
        .map_err(|err| format!("db schema failed: {err}"))
}

fn has_table(connection: &Connection, name: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
            params![name],
            |_| Ok(()),
        )
        .optional()
        .map(|row| row.is_some())
        .map_err(|err| format!("db read failed: {err}"))
}

fn read_state(connection: &Connection, key: &str) -> Result<Option<String>, String> {
    if !has_table(connection, "sidecar_state")? {
        return Ok(None);
    }
    connection
        .query_row(
            "SELECT value FROM sidecar_state WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| format!("db read failed: {err}"))
}

fn write_state(connection: &Connection, key: &str, value: &str, now: &str) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO sidecar_state(key, value, updated_at) VALUES(?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![key, value, now],
        )
        .map(|_| ())
        .map_err(|err| format!("db write failed: {err}"))
}

fn strings_from_json(json: &str) -> Vec<String> {
    serde_json::from_str(json).unwrap_or_default()
}

fn read_items(
    connection: &Connection,
    now: chrono::DateTime<Utc>,
) -> Result<Vec<MyDayItem>, String> {
    if !has_table(connection, "personal_items")? {
        return Ok(Vec::new());
    }
    let done_since =
        (now - chrono::Duration::days(DONE_ITEM_DAYS)).to_rfc3339_opts(SecondsFormat::Millis, true);
    let mut statement = connection
        .prepare(
            "SELECT item_key, source, state, channel_name, permalink, asker, asked_at, ask, done_summary,
                    reply_text, next_step, evidence, pr_urls_json, job_id, session_id, first_seen_at
               FROM personal_items
              WHERE state != 'done' OR last_seen_at >= ?1
              ORDER BY first_seen_at DESC",
        )
        .map_err(|err| format!("db read failed: {err}"))?;
    let rows = statement
        .query_map(params![done_since], |row| {
            Ok(MyDayItem {
                key: row.get(0)?,
                source: row.get(1)?,
                state: row.get(2)?,
                channel_name: row.get(3)?,
                permalink: row.get(4)?,
                asker: row.get(5)?,
                asked_at: row.get(6)?,
                ask: row.get(7)?,
                done_summary: row.get(8)?,
                reply_text: row.get(9)?,
                next_step: row.get(10)?,
                evidence: row.get(11)?,
                pr_urls: strings_from_json(&row.get::<_, String>(12)?),
                job_id: row.get(13)?,
                session_id: row.get(14)?,
                first_seen_at: row.get(15)?,
            })
        })
        .map_err(|err| format!("db read failed: {err}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("db read failed: {err}"))
}

fn read_last_run(connection: &Connection) -> Result<Option<MyDayRun>, String> {
    if !has_table(connection, "personal_runs")? {
        return Ok(None);
    }
    let run = connection
        .query_row(
            "SELECT id, status, trigger, window_start, window_end, started_at, finished_at, gaps_json, error_message
               FROM personal_runs ORDER BY started_at DESC LIMIT 1",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    MyDayRun {
                        status: row.get(1)?,
                        trigger: row.get(2)?,
                        window_start: row.get(3)?,
                        window_end: row.get(4)?,
                        started_at: row.get(5)?,
                        finished_at: row.get(6)?,
                        gaps: strings_from_json(&row.get::<_, String>(7)?),
                        error: row.get(8)?,
                        cost_usd: 0.0,
                    },
                ))
            },
        )
        .optional()
        .map_err(|err| format!("db read failed: {err}"))?;
    let Some((id, mut run)) = run else {
        return Ok(None);
    };
    if has_table(connection, "agent_calls")? {
        run.cost_usd = connection
            .query_row(
                "SELECT COALESCE(SUM(cost_usd), 0) FROM agent_calls WHERE job_id = ?1",
                params![format!("personal:{id}")],
                |row| row.get(0),
            )
            .map_err(|err| format!("db read failed: {err}"))?;
    }
    Ok(Some(run))
}

fn read_my_day(connection: &Connection, now: chrono::DateTime<Utc>) -> Result<MyDay, String> {
    let run_queued = has_table(connection, "personal_actions")?
        && connection
            .query_row(
                "SELECT 1 FROM personal_actions WHERE kind = 'run_now' AND taken_at IS NULL LIMIT 1",
                [],
                |_| Ok(()),
            )
            .optional()
            .map_err(|err| format!("db read failed: {err}"))?
            .is_some();
    Ok(MyDay {
        enabled: read_state(connection, ENABLED_KEY)?.as_deref() == Some("1"),
        run_time: read_state(connection, RUN_TIME_KEY)?
            .unwrap_or_else(|| DEFAULT_RUN_TIME.to_string()),
        run_queued,
        last_run: read_last_run(connection)?,
        items: read_items(connection, now)?,
    })
}

fn is_run_time(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 5
        && bytes[2] == b':'
        && value[..2].parse::<u8>().is_ok_and(|hours| hours < 24)
        && value[3..].parse::<u8>().is_ok_and(|minutes| minutes < 60)
        && value[..2].bytes().all(|byte| byte.is_ascii_digit())
        && value[3..].bytes().all(|byte| byte.is_ascii_digit())
}

/// `enabled_at` moves when the run is turned on or its time changes: neither
/// should fire a run for a time that had already passed.
fn apply_schedule(
    connection: &Connection,
    enabled: bool,
    run_time: &str,
    now: &str,
) -> Result<(), String> {
    if !is_run_time(run_time) {
        return Err(format!("{run_time} isn't a time like 22:00"));
    }
    ensure_tables(connection)?;
    let was_enabled = read_state(connection, ENABLED_KEY)?.as_deref() == Some("1");
    let time_changed = read_state(connection, RUN_TIME_KEY)?.is_some_and(|time| time != run_time);
    if enabled && (!was_enabled || time_changed) {
        write_state(connection, ENABLED_AT_KEY, now, now)?;
    }
    write_state(
        connection,
        ENABLED_KEY,
        if enabled { "1" } else { "0" },
        now,
    )?;
    write_state(connection, RUN_TIME_KEY, run_time, now)
}

/// `3d`, a date that exists, or nothing for "since the last run". Anything else
/// is refused here rather than quietly covering the wrong window.
fn is_span(value: &str) -> bool {
    let days = value.strip_suffix('d').is_some_and(|number| {
        !number.is_empty() && number.len() <= 2 && number.bytes().all(|byte| byte.is_ascii_digit())
    });
    days || (value.len() == 10 && chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok())
}

fn queue_run(connection: &Connection, span: Option<&str>, now: &str) -> Result<(), String> {
    if let Some(span) = span {
        if !is_span(span) {
            return Err(format!("{span} isn't a window like 3d or 2026-10-28"));
        }
    }
    ensure_tables(connection)?;
    connection
        .execute(
            "INSERT INTO personal_actions(id, kind, span, created_at)
             SELECT ?1, 'run_now', ?2, ?3
              WHERE NOT EXISTS (SELECT 1 FROM personal_actions WHERE kind = 'run_now' AND taken_at IS NULL)",
            params![uuid::Uuid::new_v4().to_string(), span, now],
        )
        .map(|_| ())
        .map_err(|err| format!("db write failed: {err}"))
}

fn is_session_id(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok() && value.len() == 36
}

/// The script Terminal runs for a session. It's opened as a file, not sent with
/// AppleScript: a signed app needs an Automation permission for that, and macOS
/// can refuse it without ever asking. The id and folder come from the database,
/// so both are checked or quoted: neither can add to the command. It's run
/// interactively so `claude` resolves as in his own shell, and removes itself.
fn resume_script(session_id: &str, cwd: &str) -> Result<String, String> {
    if !is_session_id(session_id) {
        return Err("that isn't a session id".to_string());
    }
    let quoted_cwd = format!("'{}'", cwd.replace('\'', r"'\''"));
    Ok(format!(
        "#!/bin/zsh -il\nrm -f -- \"$0\"\ncd {quoted_cwd} && exec claude --resume {session_id}\n"
    ))
}

fn session_of(connection: &Connection, key: &str) -> Result<(String, String), String> {
    connection
        .query_row(
            "SELECT session_id, session_cwd FROM personal_items WHERE item_key = ?1 AND source = 'session'",
            params![key],
            |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()
        .map_err(|err| format!("db read failed: {err}"))?
        .and_then(|(id, cwd)| Some((id?, cwd?)))
        .ok_or_else(|| "that session is no longer in the list".to_string())
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[tauri::command]
pub(crate) async fn get_my_day(state: State<'_, AppState>) -> Result<MyDay, String> {
    let connection = Connection::open_with_flags(
        &*state.db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| format!("db open failed: {err}"))?;
    read_my_day(&connection, Utc::now())
}

#[tauri::command]
pub(crate) async fn save_my_day_schedule(
    enabled: bool,
    run_time: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let connection =
        Connection::open(&*state.db_path).map_err(|err| format!("db open failed: {err}"))?;
    apply_schedule(&connection, enabled, &run_time, &now_iso())
}

#[tauri::command]
pub(crate) async fn run_my_day_now(
    span: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let connection =
        Connection::open(&*state.db_path).map_err(|err| format!("db open failed: {err}"))?;
    queue_run(
        &connection,
        span.as_deref().filter(|value| !value.is_empty()),
        &now_iso(),
    )
}

#[tauri::command]
pub(crate) async fn resume_my_day_session(
    key: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let connection = Connection::open_with_flags(
        &*state.db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| format!("db open failed: {err}"))?;
    let (session_id, cwd) = session_of(&connection, &key)?;
    if !Path::new(&cwd).is_dir() {
        return Err(format!("{cwd} no longer exists"));
    }
    let script = resume_script(&session_id, &cwd)?;
    let file = std::env::temp_dir().join(format!(
        "watchtower-resume-{}.command",
        uuid::Uuid::new_v4()
    ));
    let mut output = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o700)
        .open(&file)
        .map_err(|err| format!("couldn't prepare the session: {err}"))?;
    output
        .write_all(script.as_bytes())
        .map_err(|err| format!("couldn't prepare the session: {err}"))?;
    drop(output);
    let status = Command::new("open")
        .args(["-a", "Terminal"])
        .arg(&file)
        .status()
        .map_err(|err| format!("couldn't open Terminal: {err}"))?;
    if status.success() {
        Ok(())
    } else {
        let _ = std::fs::remove_file(&file);
        Err("Terminal wouldn't open the session.".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SESSION: &str = "11111111-2222-3333-4444-555555555555";

    fn database() -> Connection {
        let connection = Connection::open_in_memory().expect("db");
        connection
            .execute_batch(
                "CREATE TABLE personal_runs (id TEXT PRIMARY KEY, trigger TEXT, status TEXT, window_start TEXT,
                   window_end TEXT, started_at TEXT, finished_at TEXT, gaps_json TEXT, error_message TEXT);
                 CREATE TABLE personal_items (item_key TEXT PRIMARY KEY, source TEXT, state TEXT, channel_name TEXT,
                   permalink TEXT, asker TEXT, asked_at TEXT, ask TEXT, done_summary TEXT, reply_text TEXT,
                   next_step TEXT, evidence TEXT, pr_urls_json TEXT, job_id TEXT, session_id TEXT, session_cwd TEXT,
                   first_seen_at TEXT, last_seen_at TEXT);
                 CREATE TABLE agent_calls (job_id TEXT, cost_usd REAL);",
            )
            .expect("schema");
        connection
    }

    fn add_item(connection: &Connection, key: &str, state: &str, last_seen_at: &str) {
        connection
            .execute(
                "INSERT INTO personal_items (item_key, source, state, ask, pr_urls_json, first_seen_at, last_seen_at)
                 VALUES (?1, 'slack', ?2, 'an ask', '[\"https://github.com/o/r/pull/1\"]', ?3, ?3)",
                params![key, state, last_seen_at],
            )
            .expect("insert");
    }

    #[test]
    fn reads_nothing_before_the_sidecar_made_its_tables() {
        let connection = Connection::open_in_memory().expect("db");
        let day = read_my_day(&connection, Utc::now()).expect("read");
        assert!(!day.enabled);
        assert_eq!(day.run_time, DEFAULT_RUN_TIME);
        assert!(day.items.is_empty());
        assert!(day.last_run.is_none());
    }

    #[test]
    fn keeps_open_items_and_only_recent_done_ones() {
        let connection = database();
        add_item(
            &connection,
            "open-old",
            "needs_you",
            "2020-01-01T00:00:00.000Z",
        );
        add_item(&connection, "done-old", "done", "2020-01-01T00:00:00.000Z");
        add_item(&connection, "done-new", "done", &now_iso());
        let day = read_my_day(&connection, Utc::now()).expect("read");
        let mut keys: Vec<_> = day.items.iter().map(|item| item.key.as_str()).collect();
        keys.sort_unstable();
        assert_eq!(keys, vec!["done-new", "open-old"]);
        assert_eq!(day.items[0].pr_urls, vec!["https://github.com/o/r/pull/1"]);
    }

    #[test]
    fn adds_up_what_the_last_run_cost() {
        let connection = database();
        connection
            .execute_batch(
                "INSERT INTO personal_runs VALUES ('r1', 'schedule', 'OK', 'a', 'b', '2026-11-01', NULL, '[\"gap\"]', NULL);
                 INSERT INTO agent_calls VALUES ('personal:r1', 1.5), ('personal:r1', 2.0), ('another', 9.0);",
            )
            .expect("seed");
        let run = read_last_run(&connection).expect("read").expect("run");
        assert!((run.cost_usd - 3.5).abs() < f64::EPSILON);
        assert_eq!(run.gaps, vec!["gap"]);
    }

    #[test]
    fn turning_on_sets_the_baseline_and_saving_again_keeps_it() {
        let connection = Connection::open_in_memory().expect("db");
        apply_schedule(&connection, true, "22:00", "first").expect("on");
        assert_eq!(
            read_state(&connection, ENABLED_AT_KEY).unwrap().as_deref(),
            Some("first")
        );
        apply_schedule(&connection, true, "22:00", "second").expect("still on");
        assert_eq!(
            read_state(&connection, ENABLED_AT_KEY).unwrap().as_deref(),
            Some("first")
        );
        apply_schedule(&connection, false, "22:00", "third").expect("off");
        apply_schedule(&connection, true, "22:00", "fourth").expect("on again");
        assert_eq!(
            read_state(&connection, ENABLED_AT_KEY).unwrap().as_deref(),
            Some("fourth")
        );
    }

    #[test]
    fn refuses_a_bad_time() {
        let connection = Connection::open_in_memory().expect("db");
        for bad in ["25:00", "22:60", "9:00", "soon", "+1:00"] {
            assert!(
                apply_schedule(&connection, true, bad, "now").is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn queues_one_run_at_a_time_and_refuses_a_bad_window() {
        let connection = Connection::open_in_memory().expect("db");
        queue_run(&connection, Some("3d"), "now").expect("first");
        queue_run(&connection, None, "now").expect("second is ignored");
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM personal_actions", [], |row| {
                row.get(0)
            })
            .expect("count");
        assert_eq!(count, 1);
        assert!(
            read_my_day(&connection, Utc::now())
                .expect("read")
                .run_queued
        );
        assert!(queue_run(&connection, Some("; rm -rf"), "now").is_err());
        assert!(queue_run(&connection, Some("2026-10-28"), "now").is_ok());
    }

    #[test]
    fn resume_script_cannot_be_extended_by_its_values() {
        assert!(resume_script("1; rm -rf ~", "/tmp").is_err());
        let script = resume_script(SESSION, "/tmp/it's $(here)").expect("script");
        assert!(script.starts_with("#!/bin/zsh -il\n"));
        assert!(script.contains(&format!("&& exec claude --resume {SESSION}\n")));
        assert!(script.contains(r"cd '/tmp/it'\''s $(here)' &&"), "{script}");
    }

    #[test]
    fn changing_the_time_moves_the_baseline() {
        let connection = Connection::open_in_memory().expect("db");
        apply_schedule(&connection, true, "22:00", "first").expect("on");
        apply_schedule(&connection, true, "09:30", "second").expect("moved");
        assert_eq!(
            read_state(&connection, ENABLED_AT_KEY).unwrap().as_deref(),
            Some("second")
        );
    }

    #[test]
    fn refuses_a_date_that_does_not_exist() {
        assert!(is_span("2026-10-28"));
        assert!(is_span("3d"));
        for bad in ["2026-13-45", "2026-02-31", "3", "d", "123d", "2026-1-1"] {
            assert!(!is_span(bad), "{bad}");
        }
    }

    #[test]
    fn only_a_session_item_can_be_resumed() {
        let connection = database();
        add_item(&connection, "slack:1", "needs_you", "2026-11-01");
        assert!(session_of(&connection, "slack:1").is_err());
        connection
            .execute(
                "INSERT INTO personal_items (item_key, source, state, ask, pr_urls_json, session_id, session_cwd, first_seen_at, last_seen_at)
                 VALUES ('session:x', 'session', 'needs_you', 'a', '[]', ?1, '/tmp', 'a', 'a')",
                params![SESSION],
            )
            .expect("insert");
        assert_eq!(
            session_of(&connection, "session:x").expect("found").0,
            SESSION
        );
    }
}
