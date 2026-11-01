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
const TEAM_ID_KEY: &str = "personal.team_id";
const DEFAULT_RUN_TIME: &str = "22:00";
/// Done items older than this drop off the inbox; the rows stay.
const DONE_ITEM_DAYS: i64 = 7;

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MyDayItem {
    pub key: String,
    pub owner_closed: Option<String>,
    pub draft_status: Option<String>,
    pub draft_error: Option<String>,
    pub pr_states: std::collections::HashMap<String, String>,
    pub action: Option<String>,
    pub job_status: Option<String>,
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
    /// What runs on its own: `auto`, `ask` or `off` for each kind of work.
    pub policies: std::collections::BTreeMap<String, String>,
}

fn ensure_tables(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS sidecar_state (
               key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS personal_actions (
               id TEXT PRIMARY KEY, kind TEXT NOT NULL, span TEXT, prepare_only INTEGER NOT NULL DEFAULT 0,
               item_key TEXT, text TEXT,
               created_at TEXT NOT NULL, taken_at TEXT
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
                    reply_text, next_step, evidence, pr_urls_json, job_id, session_id, first_seen_at,
                    owner_closed, draft_status, draft_error, pr_states_json, action,
                    (SELECT status FROM jobs WHERE jobs.id = personal_items.job_id)
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
                owner_closed: row.get(16)?,
                draft_status: row.get(17)?,
                draft_error: row.get(18)?,
                pr_states: serde_json::from_str(&row.get::<_, String>(19)?).unwrap_or_default(),
                action: row.get(20)?,
                job_status: row.get(21)?,
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
                "SELECT COALESCE(SUM(cost_usd), 0) FROM agent_calls
                  WHERE job_id = ?1
                     OR job_id IN (SELECT job_id FROM personal_items WHERE last_run_id = ?2 AND job_id IS NOT NULL)",
                params![format!("personal:{id}"), id],
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
        policies: read_policies(connection)?,
    })
}

const POLICY_NAMES: [&str; 4] = ["review", "fix_own_pr", "open_pr", "tag"];

fn read_policies(
    connection: &Connection,
) -> Result<std::collections::BTreeMap<String, String>, String> {
    POLICY_NAMES
        .iter()
        .map(|name| {
            let value = read_state(connection, &format!("personal.policy.{name}"))?
                .filter(|value| value == "ask" || value == "off")
                .unwrap_or_else(|| "auto".to_string());
            Ok(((*name).to_string(), value))
        })
        .collect()
}

fn set_policy(connection: &Connection, name: &str, value: &str, now: &str) -> Result<(), String> {
    if !POLICY_NAMES.contains(&name) {
        return Err(format!("{name} isn't something that can be set"));
    }
    if !["auto", "ask", "off"].contains(&value) {
        return Err(format!("{value} isn't a setting"));
    }
    ensure_tables(connection)?;
    write_state(connection, &format!("personal.policy.{name}"), value, now)
}

/// What his button or answer should do for an item: answer the job waiting on him,
/// start the work, or nothing while a job is still going by itself.
#[derive(Debug, PartialEq)]
enum StartPlan {
    AnswerJob {
        job_id: String,
        prompt_ts: Option<String>,
    },
    StartNew,
}

fn start_plan(connection: &Connection, key: &str) -> Result<StartPlan, String> {
    let item: Option<(Option<String>, String)> = connection
        .query_row(
            "SELECT job_id, state FROM personal_items WHERE item_key = ?1 AND owner_closed IS NULL",
            params![key],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|err| format!("db read failed: {err}"))?;
    let (job_id, state) = item.ok_or_else(|| "that item is no longer open".to_string())?;
    if state == "done" {
        return Err("that item is already done".to_string());
    }
    let Some(job_id) = job_id else {
        // Started, with no job yet: a second start would run it twice.
        return if state == "working" {
            Err("its run is starting.".to_string())
        } else {
            Ok(StartPlan::StartNew)
        };
    };
    let status: Option<String> = connection
        .query_row(
            "SELECT status FROM jobs WHERE id = ?1",
            params![job_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| format!("db read failed: {err}"))?;
    let prompt_ts: Option<String> = if has_table(connection, "human_waits")? {
        connection
            .query_row(
                "SELECT prompt_ts FROM human_waits WHERE job_id = ?1",
                params![job_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|err| format!("db read failed: {err}"))?
    } else {
        None
    };
    match status.as_deref() {
        Some("PAUSED") => Ok(StartPlan::AnswerJob {
            job_id,
            prompt_ts: None,
        }),
        Some("RUNNING") if prompt_ts.is_some() => Ok(StartPlan::AnswerJob { job_id, prompt_ts }),
        Some("RUNNING") => Err("its run is still going. See the run.".to_string()),
        _ => Ok(StartPlan::StartNew),
    }
}

fn queue_start(
    connection: &Connection,
    key: &str,
    text: Option<&str>,
    now: &str,
) -> Result<(), String> {
    ensure_tables(connection)?;
    connection
        .execute(
            "INSERT INTO personal_actions(id, kind, item_key, text, created_at)
             SELECT ?1, 'start_item', ?2, ?3, ?4
              WHERE NOT EXISTS (SELECT 1 FROM personal_actions
                                 WHERE kind = 'start_item' AND item_key = ?2 AND taken_at IS NULL)",
            params![uuid::Uuid::new_v4().to_string(), key, text, now],
        )
        .map(|_| ())
        .map_err(|err| format!("db write failed: {err}"))
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

fn queue_run(
    connection: &Connection,
    span: Option<&str>,
    prepare_only: bool,
    now: &str,
) -> Result<(), String> {
    if let Some(span) = span {
        if !is_span(span) {
            return Err(format!("{span} isn't a window like 3d or 2026-10-28"));
        }
    }
    ensure_tables(connection)?;
    connection
        .execute(
            "INSERT INTO personal_actions(id, kind, span, prepare_only, created_at)
             SELECT ?1, 'run_now', ?2, ?4, ?3
              WHERE NOT EXISTS (SELECT 1 FROM personal_actions WHERE kind = 'run_now' AND taken_at IS NULL)",
            params![uuid::Uuid::new_v4().to_string(), span, now, prepare_only as i64],
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

/// Closes an item as he says, or reopens one he closed. A later run leaves what
/// he closed alone. Only his own closing can be undone: a run's `done` has a reason.
fn set_closed(connection: &Connection, key: &str, how: &str, now: &str) -> Result<(), String> {
    let changed = match how {
        "skipped" | "done" => connection.execute(
            "UPDATE personal_items SET state = 'done', owner_closed = ?2, last_seen_at = ?3 WHERE item_key = ?1",
            params![key, how, now],
        ),
        "reopen" => connection.execute(
            "UPDATE personal_items SET state = 'needs_you', owner_closed = NULL, last_seen_at = ?2
              WHERE item_key = ?1 AND owner_closed IS NOT NULL",
            params![key, now],
        ),
        other => return Err(format!("{other} isn't something an item can be set to")),
    }
    .map_err(|err| format!("db write failed: {err}"))?;
    if changed == 0 {
        return Err("that item is no longer in the list".to_string());
    }
    if how != "reopen" {
        stop_its_run(connection, key, now)?;
    }
    Ok(())
}

/// Closing an item stops its run: otherwise it would go on to push and open a PR.
fn stop_its_run(connection: &Connection, key: &str, now: &str) -> Result<(), String> {
    if !has_table(connection, "jobs")? {
        return Ok(());
    }
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS pending_cancel_jobs (
               job_id TEXT PRIMARY KEY, created_at TEXT NOT NULL
             )",
        )
        .map_err(|err| format!("db schema failed: {err}"))?;
    connection
        .execute(
            "INSERT OR IGNORE INTO pending_cancel_jobs (job_id, created_at)
             SELECT item.job_id, ?2
               FROM personal_items item
               JOIN jobs ON jobs.id = item.job_id
              WHERE item.item_key = ?1 AND jobs.status IN ('RUNNING', 'PAUSED')",
            params![key, now],
        )
        .map(|_| ())
        .map_err(|err| format!("db write failed: {err}"))
}

fn is_slack_id(value: &str, first: &[u8]) -> bool {
    value.len() >= 6
        && first.contains(&value.as_bytes()[0])
        && value
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
}

fn is_slack_ts(value: &str) -> bool {
    value.split_once('.').is_some_and(|(seconds, micros)| {
        seconds.len() == 10
            && (1..=6).contains(&micros.len())
            && seconds
                .bytes()
                .chain(micros.bytes())
                .all(|byte| byte.is_ascii_digit())
    })
}

/// The Slack app's own link to a message. Built only from checked ids, so nothing
/// that came out of a Slack message can choose what gets opened.
fn slack_app_link(
    team: &str,
    channel: &str,
    message: &str,
    thread: Option<&str>,
) -> Option<String> {
    if !is_slack_id(team, b"TE") || !is_slack_id(channel, b"CDG") || !is_slack_ts(message) {
        return None;
    }
    let mut link = format!("slack://channel?team={team}&id={channel}&message={message}");
    if let Some(thread) = thread.filter(|thread| is_slack_ts(thread) && *thread != message) {
        link.push_str(&format!("&thread_ts={thread}"));
    }
    Some(link)
}

fn item_links(
    connection: &Connection,
    key: &str,
) -> Result<(Option<String>, Option<String>), String> {
    let (channel, thread, message, permalink): (Option<String>, Option<String>, Option<String>, Option<String>) =
        connection
            .query_row(
                "SELECT channel_id, thread_ts, message_ts, permalink FROM personal_items WHERE item_key = ?1",
                params![key],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
            .map_err(|err| format!("db read failed: {err}"))?
            .ok_or_else(|| "that item is no longer in the list".to_string())?;
    let team = read_state(connection, TEAM_ID_KEY)?;
    let target = message.as_deref().or(thread.as_deref());
    let app = match (team.as_deref(), channel.as_deref(), target) {
        (Some(team), Some(channel), Some(target)) => {
            slack_app_link(team, channel, target, thread.as_deref())
        }
        _ => None,
    };
    Ok((app, permalink.filter(|link| link.starts_with("https://"))))
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
    prepare_only: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let connection =
        Connection::open(&*state.db_path).map_err(|err| format!("db open failed: {err}"))?;
    queue_run(
        &connection,
        span.as_deref().filter(|value| !value.is_empty()),
        prepare_only,
        &now_iso(),
    )
}

#[tauri::command]
pub(crate) async fn save_my_day_policy(
    name: String,
    value: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let connection =
        Connection::open(&*state.db_path).map_err(|err| format!("db open failed: {err}"))?;
    set_policy(&connection, &name, &value, &now_iso())
}

/// Run it, or his answer: goes to the job waiting on him if there is one, and starts
/// the work if not. It runs in the item's own thread, without posting his words again.
#[tauri::command]
pub(crate) async fn start_my_day_item(
    key: String,
    text: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let text = text
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let plan = {
        let connection =
            Connection::open(&*state.db_path).map_err(|err| format!("db open failed: {err}"))?;
        start_plan(&connection, &key)?
    };
    match plan {
        StartPlan::StartNew => {
            let connection = Connection::open(&*state.db_path)
                .map_err(|err| format!("db open failed: {err}"))?;
            queue_start(&connection, &key, text.as_deref(), &now_iso())
        }
        StartPlan::AnswerJob { job_id, prompt_ts } => {
            let answer = text.ok_or_else(|| "its run is waiting for your answer.".to_string())?;
            let written_for = (job_id.clone(), prompt_ts);
            crate::run_controls::start_run(
                &state.db_path,
                &job_id,
                crate::run_controls::Start::Answer,
                Some(answer),
                false,
                Some(&written_for),
            )
            .await
            .map(|_| ())
        }
    }
}

#[tauri::command]
pub(crate) async fn close_my_day_item(
    key: String,
    how: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let connection =
        Connection::open(&*state.db_path).map_err(|err| format!("db open failed: {err}"))?;
    set_closed(&connection, &key, &how, &now_iso())
}

/// Opens the Slack app on the item's message, or the web page if that fails.
#[tauri::command]
pub(crate) async fn open_my_day_in_slack(
    key: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let connection = Connection::open_with_flags(
        &*state.db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|err| format!("db open failed: {err}"))?;
    let (app, web) = item_links(&connection, &key)?;
    for link in [app, web].into_iter().flatten() {
        let opened = Command::new("open")
            .arg(&link)
            .status()
            .map(|status| status.success());
        if matches!(opened, Ok(true)) {
            return Ok(());
        }
    }
    Err("Couldn't open that thread in Slack.".to_string())
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
                   channel_id TEXT, thread_ts TEXT, message_ts TEXT, owner_closed TEXT, draft_status TEXT, draft_error TEXT,
                   pr_states_json TEXT NOT NULL DEFAULT '{}', action TEXT, last_run_id TEXT,
                   first_seen_at TEXT, last_seen_at TEXT);
                 CREATE TABLE agent_calls (job_id TEXT, cost_usd REAL);
                 CREATE TABLE jobs (id TEXT PRIMARY KEY, status TEXT);
                 CREATE TABLE human_waits (job_id TEXT, prompt_ts TEXT);",
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
        queue_run(&connection, Some("3d"), true, "now").expect("first");
        queue_run(&connection, None, false, "now").expect("second is ignored");
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
        let prepare_only: i64 = connection
            .query_row("SELECT prepare_only FROM personal_actions", [], |row| {
                row.get(0)
            })
            .expect("flag");
        assert_eq!(prepare_only, 1);
        assert!(queue_run(&connection, Some("; rm -rf"), false, "now").is_err());
        assert!(queue_run(&connection, Some("2026-10-28"), false, "now").is_ok());
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
    fn last_run_cost_includes_its_jobs() {
        let connection = database();
        connection
            .execute_batch(
                "INSERT INTO personal_runs VALUES ('r1', 'schedule', 'OK', 'a', 'b', '2026-11-01', NULL, '[]', NULL);
                 INSERT INTO personal_items (item_key, source, state, ask, pr_urls_json, first_seen_at, last_seen_at, job_id, last_run_id)
                   VALUES ('a', 'slack', 'done', 'x', '[]', 'a', 'a', 'job-1', 'r1');
                 INSERT INTO agent_calls VALUES ('personal:r1', 1.0), ('job-1', 2.5), ('job-other', 9.0);",
            )
            .expect("seed");
        let run = read_last_run(&connection).expect("read").expect("run");
        assert!((run.cost_usd - 3.5).abs() < f64::EPSILON);
    }

    #[test]
    fn policies_default_to_on_and_only_take_real_values() {
        let connection = Connection::open_in_memory().expect("db");
        assert_eq!(read_policies(&connection).unwrap()["review"], "auto");
        set_policy(&connection, "review", "ask", "now").expect("set");
        assert_eq!(read_policies(&connection).unwrap()["review"], "ask");
        assert!(set_policy(&connection, "merge", "auto", "now").is_err());
        assert!(set_policy(&connection, "review", "yes", "now").is_err());
    }

    fn add_item_with_job(connection: &Connection, job: Option<(&str, &str)>) {
        add_item(connection, "a", "needs_you", "2026-11-01");
        if let Some((id, status)) = job {
            connection
                .execute(
                    "UPDATE personal_items SET job_id = ?1 WHERE item_key = 'a'",
                    params![id],
                )
                .expect("link");
            connection
                .execute("INSERT INTO jobs VALUES (?1, ?2)", params![id, status])
                .expect("job");
        }
    }

    #[test]
    fn starting_an_item_goes_to_what_is_waiting() {
        let connection = database();
        add_item_with_job(&connection, None);
        assert_eq!(start_plan(&connection, "a").unwrap(), StartPlan::StartNew);
    }

    #[test]
    fn an_answer_goes_to_a_paused_job_or_a_waiting_gate() {
        let connection = database();
        add_item_with_job(&connection, Some(("j", "PAUSED")));
        assert_eq!(
            start_plan(&connection, "a").unwrap(),
            StartPlan::AnswerJob {
                job_id: "j".to_string(),
                prompt_ts: None
            }
        );
        connection
            .execute_batch(
                "UPDATE jobs SET status = 'RUNNING'; INSERT INTO human_waits VALUES ('j', '1.2');",
            )
            .unwrap();
        assert_eq!(
            start_plan(&connection, "a").unwrap(),
            StartPlan::AnswerJob {
                job_id: "j".to_string(),
                prompt_ts: Some("1.2".to_string())
            }
        );
    }

    #[test]
    fn a_job_going_by_itself_is_left_alone_and_a_finished_one_can_run_again() {
        let connection = database();
        add_item_with_job(&connection, Some(("j", "RUNNING")));
        assert!(start_plan(&connection, "a").is_err());
        connection
            .execute("UPDATE jobs SET status = 'FAILED'", [])
            .unwrap();
        assert_eq!(start_plan(&connection, "a").unwrap(), StartPlan::StartNew);
    }

    #[test]
    fn a_closed_or_finished_item_cannot_start() {
        let connection = database();
        add_item(&connection, "done", "done", "2026-11-01");
        assert!(start_plan(&connection, "done").is_err());
        assert!(start_plan(&connection, "missing").is_err());
    }

    #[test]
    fn queues_one_start_per_item() {
        let connection = database();
        add_item(&connection, "a", "needs_you", "2026-11-01");
        queue_start(&connection, "a", Some("yes"), "now").expect("first");
        queue_start(&connection, "a", None, "now").expect("second is ignored");
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM personal_actions WHERE kind = 'start_item'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn closing_and_reopening_an_item() {
        let connection = database();
        add_item(&connection, "a", "needs_you", "2026-11-01");
        set_closed(&connection, "a", "skipped", "now").expect("skip");
        let closed: (String, String) = connection
            .query_row(
                "SELECT state, owner_closed FROM personal_items WHERE item_key = 'a'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("row");
        assert_eq!(closed, ("done".to_string(), "skipped".to_string()));
        set_closed(&connection, "a", "reopen", "now").expect("reopen");
        let state: String = connection
            .query_row(
                "SELECT state FROM personal_items WHERE item_key = 'a'",
                [],
                |row| row.get(0),
            )
            .expect("row");
        assert_eq!(state, "needs_you");
        assert!(set_closed(&connection, "a", "nonsense", "now").is_err());
        assert!(set_closed(&connection, "missing", "done", "now").is_err());
    }

    #[test]
    fn closing_an_item_stops_its_run() {
        let connection = database();
        add_item_with_job(&connection, Some(("j", "RUNNING")));
        set_closed(&connection, "a", "skipped", "now").expect("close");
        let job: String = connection
            .query_row("SELECT job_id FROM pending_cancel_jobs", [], |row| {
                row.get(0)
            })
            .expect("queued");
        assert_eq!(job, "j");
    }

    #[test]
    fn a_started_item_with_no_job_yet_cannot_start_again() {
        let connection = database();
        add_item(&connection, "a", "working", "2026-11-01");
        assert!(start_plan(&connection, "a").is_err());
    }

    #[test]
    fn reopen_leaves_what_a_run_closed() {
        let connection = database();
        add_item(&connection, "a", "done", "2026-11-01");
        assert!(set_closed(&connection, "a", "reopen", "now").is_err());
    }

    #[test]
    fn slack_links_are_built_only_from_checked_ids() {
        assert_eq!(
            slack_app_link("T01ABCDEF", "C01ABCDEF", "1793000500.000200", Some("1793000000.000100")).as_deref(),
            Some("slack://channel?team=T01ABCDEF&id=C01ABCDEF&message=1793000500.000200&thread_ts=1793000000.000100")
        );
        assert_eq!(
            slack_app_link(
                "T01ABCDEF",
                "D01ABCDEF",
                "1793000500.000200",
                Some("1793000500.000200")
            )
            .as_deref(),
            Some("slack://channel?team=T01ABCDEF&id=D01ABCDEF&message=1793000500.000200")
        );
        assert!(slack_app_link("T01ABCDEF", "C01&evil=1", "1793000500.000200", None).is_none());
        assert!(slack_app_link("x", "C01ABCDEF", "1793000500.000200", None).is_none());
        assert!(slack_app_link("T01ABCDEF", "C01ABCDEF", "not-a-ts", None).is_none());
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
