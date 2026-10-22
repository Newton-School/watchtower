//! Run controls in a run's thread view: stop the run, run its ask again, or
//! ask miniOG something new in the thread. New runs are launchpad requests,
//! which the sidecar turns into a mention of miniOG on the owner's authority.
//! Either the ask is posted in the thread first, as miniOG, so people can see
//! what was asked (the run's emojis then go on that post), or the run starts
//! without a word. Every control is logged in the trace of the run it was
//! used from.

use std::{collections::HashSet, path::Path};

use chrono::{Duration, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::State;
use uuid::Uuid;

use crate::{
    is_settings_complete, parse_owner_ids, read_app_settings,
    slack::{self, JobSlackTarget},
    AppState,
};

/// A request the sidecar has not picked up in this long is stuck, not
/// starting, and no longer holds the thread.
const STARTING_MINUTES: i64 = 10;

/// Events that are not a message in the thread, so a re-run can't start from
/// them: slash commands, shortcuts and emoji replies.
const NON_MESSAGE_EVENTS: &[&str] = &["command:", "shortcut:", "reaction-resume:"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunControls {
    /// Stop shows while the run is going or waiting on a person.
    can_stop: bool,
    /// What a re-run would ask, without the mention of miniOG. None when the
    /// run has no thread or no words to repeat.
    rerun_ask: Option<String>,
    /// Who a re-run is for, when that is not the owner.
    rerun_for: Option<String>,
    /// The run working in this thread now, if any: miniOG takes one at a time.
    busy_job_id: Option<String>,
    /// A run started from the app that miniOG has not picked up yet.
    starting: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartedRun {
    request_id: String,
    /// The posted ask, when the ask was posted.
    ask_ts: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartedRunStatus {
    /// PENDING, CLAIMED or QUEUED until miniOG takes it, then RUNNING, and
    /// finally SUCCESS, FAILED, PAUSED or SKIPPED.
    status: String,
    job_id: Option<String>,
    error: Option<String>,
}

struct JobRow {
    status: String,
    event_id: String,
    payload: serde_json::Value,
}

fn job_row(connection: &Connection, job_id: &str) -> Result<JobRow, String> {
    let (status, event_id, payload_json): (String, String, Option<String>) = connection
        .query_row(
            "SELECT status, event_id, payload_json FROM jobs WHERE id = ?",
            params![job_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|err| format!("db query job failed: {err}"))?
        .ok_or_else(|| format!("job {job_id} not found"))?;
    let payload = serde_json::from_str(payload_json.as_deref().unwrap_or(""))
        .unwrap_or(serde_json::Value::Null);
    Ok(JobRow {
        status,
        event_id,
        payload,
    })
}

fn can_stop(status: &str) -> bool {
    matches!(status, "RUNNING" | "PAUSED")
}

/// The words of an ask: its message without the mentions of miniOG.
fn ask_text(text: &str, bot_user_id: &str) -> Option<String> {
    let bot_user_id = bot_user_id.trim();
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    if !bot_user_id.is_empty() {
        let mention = format!("<@{bot_user_id}");
        while let Some(start) = rest.find(&mention) {
            let after = &rest[start + mention.len()..];
            let end = match after.chars().next() {
                Some('>') => Some(1),
                Some('|') => after.find('>').map(|i| i + 1),
                _ => None,
            };
            let Some(end) = end else {
                // Another user whose id starts with the bot's.
                out.push_str(&rest[..start + mention.len()]);
                rest = after;
                continue;
            };
            out.push_str(&rest[..start]);
            rest = &after[end..];
            if out.is_empty() || out.ends_with(char::is_whitespace) {
                rest = rest.trim_start_matches([' ', ',', ':']);
            }
        }
    }
    out.push_str(rest);
    let ask = out.trim();
    (!ask.is_empty()).then(|| ask.to_string())
}

/// The person a run was for. A run started from the app or the Launchpad page
/// keeps its real requester on its launchpad request.
fn requester(connection: &Connection, payload: &serde_json::Value) -> Option<String> {
    let from_request = payload
        .get("launchpadRequestId")
        .and_then(|id| id.as_str())
        .and_then(|id| {
            connection
                .query_row(
                    "SELECT requested_for_user_id FROM launchpad_requests WHERE id = ?",
                    params![id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .ok()
                .flatten()
        });
    from_request.or_else(|| {
        payload
            .get("requestUserId")
            .and_then(|id| id.as_str())
            .map(str::to_string)
    })
}

/// The message a silent re-run starts from: the one the run started from,
/// when that was a message.
fn rerun_event_ts(event_id: &str, target: &JobSlackTarget) -> Option<String> {
    if NON_MESSAGE_EVENTS
        .iter()
        .any(|prefix| event_id.starts_with(prefix))
    {
        return None;
    }
    target.trigger_ts.clone()
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn busy_job(connection: &Connection, target: &JobSlackTarget) -> Result<Option<String>, String> {
    connection
        .query_row(
            "SELECT id FROM jobs WHERE channel_id = ? AND thread_ts = ? AND status = 'RUNNING'
             ORDER BY created_at DESC LIMIT 1",
            params![target.channel, target.thread_ts],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| format!("db query busy job failed: {err}"))
}

fn starting_in(connection: &Connection, target: &JobSlackTarget) -> Result<bool, String> {
    let since = (Utc::now() - Duration::minutes(STARTING_MINUTES))
        .to_rfc3339_opts(SecondsFormat::Millis, true);
    connection
        .query_row(
            "SELECT 1 FROM launchpad_requests
             WHERE origin_channel_id = ? AND origin_thread_ts = ?
               AND status IN ('PENDING', 'CLAIMED', 'QUEUED') AND job_id IS NULL
               AND created_at > ?
             LIMIT 1",
            params![target.channel, target.thread_ts, since],
            |_| Ok(()),
        )
        .optional()
        .map(|found| found.is_some())
        .map_err(|err| format!("db query starting run failed: {err}"))
}

fn run_controls(
    connection: &Connection,
    job_id: &str,
    bot_user_id: &str,
    owners: &[String],
) -> Result<RunControls, String> {
    let job = job_row(connection, job_id)?;
    let target = slack::job_slack_target(connection, job_id)?;
    let (busy_job_id, starting) = match &target {
        Some(target) => (
            busy_job(connection, target)?,
            starting_in(connection, target)?,
        ),
        None => (None, false),
    };
    let rerun_ask = target.as_ref().and_then(|_| {
        job.payload
            .get("text")
            .and_then(|text| text.as_str())
            .and_then(|text| ask_text(text, bot_user_id))
    });
    let rerun_for = rerun_ask
        .as_ref()
        .and_then(|_| requester(connection, &job.payload))
        .filter(|user| !owners.contains(user));
    Ok(RunControls {
        can_stop: can_stop(&job.status),
        rerun_ask,
        rerun_for,
        busy_job_id,
        starting,
    })
}

#[tauri::command]
pub(crate) async fn get_run_controls(
    job_id: String,
    state: State<'_, AppState>,
) -> Result<RunControls, String> {
    let connection =
        Connection::open(&*state.db_path).map_err(|err| format!("db open failed: {err}"))?;
    let settings = read_app_settings(&connection)?;
    run_controls(
        &connection,
        &job_id,
        &settings.bot_user_id,
        &parse_owner_ids(&settings.owner_slack_user_ids),
    )
}

#[tauri::command]
pub(crate) async fn stop_run(job_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let result = request_stop(&state.db_path, &job_id);
    slack::traced(
        &state.db_path,
        &job_id,
        "watchtower.run.stop",
        "Stop requested from Watchtower.",
        "Stopping from Watchtower failed.",
        serde_json::json!({}),
        result,
    )
}

/// The sidecar picks the request up within a couple of seconds.
fn request_stop(db_path: &Path, job_id: &str) -> Result<(), String> {
    let connection = Connection::open(db_path).map_err(|err| format!("db open failed: {err}"))?;
    if !can_stop(&job_row(&connection, job_id)?.status) {
        return Err("This run has already finished.".to_string());
    }
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS pending_cancel_jobs (
                job_id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL
            )",
        )
        .map_err(|err| format!("db migration failed: {err}"))?;
    connection
        .execute(
            "INSERT OR IGNORE INTO pending_cancel_jobs (job_id, created_at) VALUES (?, ?)",
            params![job_id, now_iso()],
        )
        .map_err(|err| format!("db insert cancel request failed: {err}"))?;
    Ok(())
}

#[derive(Clone, Copy)]
enum Start {
    Rerun,
    Ask,
}

impl Start {
    fn stage(self) -> &'static str {
        match self {
            Start::Rerun => "watchtower.run.rerun",
            Start::Ask => "watchtower.run.ask",
        }
    }

    /// The line miniOG posts when the ask is shown in the thread.
    fn announcement(self, owner_name: Option<&str>, ask: &str) -> String {
        match (self, owner_name) {
            (Start::Rerun, Some(name)) => format!("{name} re-ran this from Watchtower: {ask}"),
            (Start::Rerun, None) => format!("Re-ran from Watchtower: {ask}"),
            (Start::Ask, Some(name)) => format!("{name} asked from Watchtower: {ask}"),
            (Start::Ask, None) => format!("Asked from Watchtower: {ask}"),
        }
    }
}

#[tauri::command]
pub(crate) async fn rerun_in_thread(
    job_id: String,
    post_ask: bool,
    state: State<'_, AppState>,
) -> Result<StartedRun, String> {
    start_run(&state.db_path, &job_id, Start::Rerun, None, post_ask).await
}

#[tauri::command]
pub(crate) async fn ask_miniog_in_thread(
    job_id: String,
    text: String,
    post_ask: bool,
    state: State<'_, AppState>,
) -> Result<StartedRun, String> {
    start_run(&state.db_path, &job_id, Start::Ask, Some(text), post_ask).await
}

struct Prepared {
    target: JobSlackTarget,
    token: String,
    owner: String,
    ask: String,
    requested_for: Option<String>,
    /// Where a silent run starts; the thread's first message when None.
    silent_event_ts: Option<String>,
}

async fn start_run(
    db_path: &Path,
    job_id: &str,
    start: Start,
    text: Option<String>,
    post_ask: bool,
) -> Result<StartedRun, String> {
    let prepared = prepare_start(db_path, job_id, start, text.as_deref());
    let mut data = serde_json::json!({ "postAsk": post_ask });
    if let Ok(prepared) = &prepared {
        data["ask"] = serde_json::json!(prepared.ask);
        data["requestedFor"] = serde_json::json!(prepared.requested_for);
    }
    let result = match prepared {
        Ok(prepared) => queue_run(db_path, start, prepared, post_ask).await,
        Err(err) => Err(err),
    };
    if let Ok(started) = &result {
        data["requestId"] = serde_json::json!(started.request_id);
        data["askTs"] = serde_json::json!(started.ask_ts);
    }
    let (done, failed) = match start {
        Start::Rerun => (
            "Re-ran this run's ask from Watchtower.",
            "Re-running from Watchtower failed.",
        ),
        Start::Ask => (
            "Asked miniOG in this thread from Watchtower.",
            "Asking miniOG from Watchtower failed.",
        ),
    };
    slack::traced(db_path, job_id, start.stage(), done, failed, data, result)
}

fn prepare_start(
    db_path: &Path,
    job_id: &str,
    start: Start,
    text: Option<&str>,
) -> Result<Prepared, String> {
    let connection = Connection::open(db_path).map_err(|err| format!("db open failed: {err}"))?;
    let settings = read_app_settings(&connection)?;
    if !is_settings_complete(&settings) {
        return Err("Finish Settings before starting a run from here.".to_string());
    }
    let owners = parse_owner_ids(&settings.owner_slack_user_ids);
    let owner = owners
        .first()
        .cloned()
        .ok_or_else(|| "No owner Slack user IDs are configured.".to_string())?;
    let target = slack::require_target(slack::job_slack_target(&connection, job_id)?)?;
    if let Some(busy) = busy_job(&connection, &target)? {
        return Err(if busy == job_id {
            "This run is still going. Stop it first.".to_string()
        } else {
            "miniOG is already working in this thread. Wait for that run or stop it.".to_string()
        });
    }
    if starting_in(&connection, &target)? {
        return Err("A run started from here hasn't been picked up yet.".to_string());
    }
    let (ask, requested_for, silent_event_ts) = match start {
        Start::Ask => {
            let ask = text.unwrap_or("").trim();
            if ask.is_empty() {
                return Err("Write what to ask first.".to_string());
            }
            (ask.to_string(), None, None)
        }
        Start::Rerun => {
            let controls = run_controls(&connection, job_id, &settings.bot_user_id, &owners)?;
            let ask = controls
                .rerun_ask
                .ok_or_else(|| "This run has no ask to repeat.".to_string())?;
            let event_id = job_row(&connection, job_id)?.event_id;
            (ask, controls.rerun_for, rerun_event_ts(&event_id, &target))
        }
    };
    Ok(Prepared {
        target,
        token: settings.slack_bot_token,
        owner,
        ask,
        requested_for,
        silent_event_ts,
    })
}

async fn queue_run(
    db_path: &Path,
    start: Start,
    prepared: Prepared,
    post_ask: bool,
) -> Result<StartedRun, String> {
    let ask_ts = if post_ask {
        let owner_name =
            slack::resolve_users(&prepared.token, HashSet::from([prepared.owner.clone()]))
                .await
                .remove(&prepared.owner)
                .map(|user| user.name)
                .filter(|name| !name.trim().is_empty());
        let text = start.announcement(owner_name.as_deref(), &prepared.ask);
        Some(
            slack::post_in_thread(&prepared.token, &prepared.target, &text, false)
                .await?
                .ts,
        )
    } else {
        None
    };
    let event_ts = ask_ts.clone().or(prepared.silent_event_ts.clone());
    let queued = Connection::open(db_path)
        .map_err(|err| format!("db open failed: {err}"))
        .and_then(|connection| {
            insert_request(
                &connection,
                &prepared.owner,
                &prepared.ask,
                prepared.requested_for.as_deref(),
                &prepared.target,
                event_ts.as_deref(),
            )
        });
    match queued {
        Ok(request_id) => Ok(StartedRun { request_id, ask_ts }),
        Err(err) => {
            // An ask with no run behind it would wait for an answer forever.
            if let Some(ts) = &ask_ts {
                let _ = slack::slack_call(
                    &prepared.token,
                    "chat.delete",
                    &[("channel", &prepared.target.channel), ("ts", ts)],
                )
                .await;
            }
            Err(err)
        }
    }
}

fn insert_request(
    connection: &Connection,
    owner: &str,
    ask: &str,
    requested_for: Option<&str>,
    target: &JobSlackTarget,
    event_ts: Option<&str>,
) -> Result<String, String> {
    let id = Uuid::new_v4().to_string();
    let now = now_iso();
    connection
        .execute(
            "INSERT INTO launchpad_requests (
               id, target, prompt, owner_user_id, status, requested_for_user_id,
               origin_channel_id, origin_thread_ts, origin_event_ts, created_at, updated_at
             ) VALUES (?, 'miniog', ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?)",
            params![
                id,
                ask,
                owner,
                requested_for,
                target.channel,
                target.thread_ts,
                event_ts,
                now,
                now
            ],
        )
        .map_err(|err| format!("db insert launchpad request failed: {err}"))?;
    Ok(id)
}

#[tauri::command]
pub(crate) async fn get_started_run(
    request_id: String,
    state: State<'_, AppState>,
) -> Result<StartedRunStatus, String> {
    let connection =
        Connection::open(&*state.db_path).map_err(|err| format!("db open failed: {err}"))?;
    started_run_status(&connection, &request_id)
}

fn started_run_status(
    connection: &Connection,
    request_id: &str,
) -> Result<StartedRunStatus, String> {
    connection
        .query_row(
            "SELECT status, job_id, error_message FROM launchpad_requests WHERE id = ?",
            params![request_id],
            |row| {
                Ok(StartedRunStatus {
                    status: row.get(0)?,
                    job_id: row.get(1)?,
                    error: row.get(2)?,
                })
            },
        )
        .optional()
        .map_err(|err| format!("db query launchpad request failed: {err}"))?
        .ok_or_else(|| "That run request is gone.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::initialize_db;
    use std::{fs, path::PathBuf};

    const BOT: &str = "U0AG8P9B3FW";
    const OWNER: &str = "U05EUC842KD";

    fn test_db() -> (PathBuf, Connection) {
        let db_path =
            std::env::temp_dir().join(format!("watchtower-run-controls-{}.db", Uuid::new_v4()));
        initialize_db(&db_path).expect("initialize db");
        let connection = Connection::open(&db_path).expect("open db");
        (db_path, connection)
    }

    fn insert_job(
        connection: &Connection,
        id: &str,
        event_id: &str,
        status: &str,
        thread_ts: &str,
        payload: serde_json::Value,
    ) {
        connection
            .execute(
                "INSERT INTO jobs (id, event_id, dedupe_key, workflow, status, channel_id, thread_ts, payload_json, created_at, updated_at)
                 VALUES (?, ?, 'dedupe', 'INFORMATIONAL', ?, 'C0B5ZVDM7GU', ?, ?, '2026-10-22T00:00:00Z', '2026-10-22T00:00:00Z')",
                params![id, event_id, status, thread_ts, payload.to_string()],
            )
            .expect("insert job");
    }

    fn controls(connection: &Connection, job_id: &str) -> RunControls {
        run_controls(connection, job_id, BOT, &[OWNER.to_string()]).expect(job_id)
    }

    #[test]
    fn ask_text_drops_the_mentions_of_miniog() {
        assert_eq!(
            ask_text("<@U0AG8P9B3FW> what repos can you work on?", BOT).as_deref(),
            Some("what repos can you work on?")
        );
        assert_eq!(
            ask_text("<@U0AG8P9B3FW|miniOG>, check <@U123> PR", BOT).as_deref(),
            Some("check <@U123> PR")
        );
        assert_eq!(
            ask_text("hey <@U0AG8P9B3FW> please look", BOT).as_deref(),
            Some("hey please look")
        );
        assert_eq!(
            ask_text("ping <@U0AG8P9B3FWX> about it", BOT).as_deref(),
            Some("ping <@U0AG8P9B3FWX> about it")
        );
        assert_eq!(ask_text("<@U0AG8P9B3FW>  ", BOT), None);
        assert_eq!(ask_text("plain ask", "").as_deref(), Some("plain ask"));
    }

    #[test]
    fn a_silent_rerun_starts_from_the_message_the_run_did() {
        let target = JobSlackTarget {
            channel: "C0B5ZVDM7GU".into(),
            thread_ts: "1.0".into(),
            trigger_ts: Some("1.5".into()),
        };
        assert_eq!(rerun_event_ts("Ev123", &target).as_deref(), Some("1.5"));
        assert_eq!(
            rerun_event_ts("replay:C:1.5", &target).as_deref(),
            Some("1.5")
        );
        assert_eq!(rerun_event_ts("command:abc", &target), None);
        assert_eq!(rerun_event_ts("reaction-resume:x", &target), None);
    }

    #[test]
    fn run_controls_reads_stop_rerun_and_busy_state() {
        let (db_path, connection) = test_db();
        insert_job(
            &connection,
            "done",
            "Ev1",
            "SUCCESS",
            "1.0",
            serde_json::json!({ "eventTs": "1.0", "text": "<@U0AG8P9B3FW> summarise this", "requestUserId": "UASKER" }),
        );
        insert_job(
            &connection,
            "mine",
            "Ev2",
            "PAUSED",
            "2.0",
            serde_json::json!({ "eventTs": "2.0", "text": "<@U0AG8P9B3FW> deploy it", "requestUserId": OWNER }),
        );
        insert_job(
            &connection,
            "empty",
            "Ev3",
            "FAILED",
            "3.0",
            serde_json::json!({ "eventTs": "3.0", "text": "<@U0AG8P9B3FW>" }),
        );

        let done = controls(&connection, "done");
        assert!(!done.can_stop);
        assert_eq!(done.rerun_ask.as_deref(), Some("summarise this"));
        assert_eq!(done.rerun_for.as_deref(), Some("UASKER"));
        assert_eq!(done.busy_job_id, None);
        assert!(!done.starting);

        let mine = controls(&connection, "mine");
        assert!(mine.can_stop);
        assert_eq!(
            mine.rerun_for, None,
            "the owner's own run is not on anyone's behalf"
        );
        assert_eq!(controls(&connection, "empty").rerun_ask, None);

        // A second run going in the same thread holds it.
        insert_job(
            &connection,
            "going",
            "Ev4",
            "RUNNING",
            "1.0",
            serde_json::json!({ "eventTs": "1.7" }),
        );
        assert_eq!(
            controls(&connection, "done").busy_job_id.as_deref(),
            Some("going")
        );

        // So does a request from the app the sidecar has not taken yet, but
        // not one stuck for longer than the window.
        let target = slack::job_slack_target(&connection, "mine")
            .unwrap()
            .unwrap();
        let request_id =
            insert_request(&connection, OWNER, "deploy it", None, &target, None).unwrap();
        assert!(controls(&connection, "mine").starting);
        connection
            .execute(
                "UPDATE launchpad_requests SET created_at = '2026-01-01T00:00:00.000Z' WHERE id = ?",
                params![request_id],
            )
            .unwrap();
        assert!(!controls(&connection, "mine").starting);

        drop(connection);
        let _ = fs::remove_file(db_path);
    }

    #[test]
    fn a_launchpad_run_reruns_for_its_real_requester() {
        let (db_path, connection) = test_db();
        let target = JobSlackTarget {
            channel: "C0B5ZVDM7GU".into(),
            thread_ts: "1.0".into(),
            trigger_ts: None,
        };
        let request_id = insert_request(
            &connection,
            OWNER,
            "fix it",
            Some("UASKER"),
            &target,
            Some("1.2"),
        )
        .unwrap();
        insert_job(
            &connection,
            "retrigger",
            &format!("launchpad:{request_id}:1.2"),
            "FAILED",
            "1.0",
            serde_json::json!({
                "eventTs": "1.2",
                "text": "<@U0AG8P9B3FW> fix it",
                "requestUserId": OWNER,
                "launchpadRequestId": request_id,
            }),
        );
        assert_eq!(
            controls(&connection, "retrigger").rerun_for.as_deref(),
            Some("UASKER")
        );

        let row: (String, String, Option<String>, String, String, Option<String>) = connection
            .query_row(
                "SELECT prompt, owner_user_id, requested_for_user_id, origin_channel_id, origin_thread_ts, origin_event_ts
                 FROM launchpad_requests WHERE id = ?",
                params![request_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
            )
            .unwrap();
        assert_eq!(
            row,
            (
                "fix it".into(),
                OWNER.into(),
                Some("UASKER".into()),
                "C0B5ZVDM7GU".into(),
                "1.0".into(),
                Some("1.2".into())
            )
        );
        let status = started_run_status(&connection, &request_id).unwrap();
        assert_eq!(status.status, "PENDING");
        assert_eq!(status.job_id, None);
        assert!(started_run_status(&connection, "missing").is_err());

        drop(connection);
        let _ = fs::remove_file(db_path);
    }

    #[test]
    fn stop_is_only_for_a_run_still_going() {
        let (db_path, connection) = test_db();
        insert_job(
            &connection,
            "going",
            "Ev1",
            "RUNNING",
            "1.0",
            serde_json::json!({}),
        );
        insert_job(
            &connection,
            "done",
            "Ev2",
            "SUCCESS",
            "2.0",
            serde_json::json!({}),
        );

        request_stop(&db_path, "going").unwrap();
        request_stop(&db_path, "going").unwrap();
        assert!(request_stop(&db_path, "done").is_err());
        let queued: i64 = connection
            .query_row("SELECT COUNT(*) FROM pending_cancel_jobs", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(queued, 1);

        drop(connection);
        let _ = fs::remove_file(db_path);
    }

    #[test]
    fn the_posted_ask_names_who_asked() {
        assert_eq!(
            Start::Ask.announcement(Some("theOG"), "check the logs"),
            "theOG asked from Watchtower: check the logs"
        );
        assert_eq!(
            Start::Rerun.announcement(None, "check the logs"),
            "Re-ran from Watchtower: check the logs"
        );
    }
}
