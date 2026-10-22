//! Slack calls the app makes as miniOG: reading a run's thread, and posting,
//! editing, deleting and reacting in it. Every command takes a job id and acts
//! only in that job's channel, so the page can't reach any other conversation.

use std::{
    collections::{HashMap, HashSet},
    path::Path,
    process::Stdio,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use base64::Engine as _;
use chrono::{SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::{process::Command, task::JoinSet};

use crate::{read_app_settings, AppSettings, AppState};

/// The emojis miniOG leaves on the message that started a run: :eyes: while
/// working, then an outcome emoji. Slack lets only the bot remove its own
/// reactions, so the app does it.
const MINIOG_REACTION_NAMES: &[&str] = &["eyes", "white_check_mark", "x", "zzz"];

/// Slack errors that mean the bot token itself is bad.
const SLACK_AUTH_ERRORS: &[&str] = &[
    "not_authed",
    "invalid_auth",
    "token_revoked",
    "token_expired",
    "account_inactive",
];

/// Pages of 200 replies to read before giving up on a very long thread.
const MAX_REPLY_PAGES: usize = 5;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SlackReadError {
    /// "deleted", "auth", "noAccess" (a private channel the bot has no history
    /// scope for; removing reactions still works) or "other".
    kind: &'static str,
    code: String,
}

fn classify_read_error(code: String) -> SlackReadError {
    let kind = match code.as_str() {
        "thread_not_found" | "message_not_found" => "deleted",
        "missing_scope" | "not_in_channel" => "noAccess",
        code if SLACK_AUTH_ERRORS.contains(&code) => "auth",
        _ => "other",
    };
    SlackReadError { kind, code }
}

/// Where a job lives in Slack.
#[derive(Debug, PartialEq)]
struct JobSlackTarget {
    channel: String,
    thread_ts: String,
    /// The message that started the run, when the run came from one.
    trigger_ts: Option<String>,
}

fn job_slack_target(
    connection: &Connection,
    job_id: &str,
) -> Result<Option<JobSlackTarget>, String> {
    let row: Option<(String, String, Option<String>)> = connection
        .query_row(
            "SELECT channel_id, thread_ts, payload_json FROM jobs WHERE id = ?",
            params![job_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|err| format!("db query job failed: {err}"))?;
    let Some((channel, thread_ts, payload_json)) = row else {
        return Err(format!("job {job_id} not found"));
    };
    if !channel.starts_with(['C', 'G', 'D']) || thread_ts.trim().is_empty() {
        return Ok(None);
    }
    let trigger_ts =
        serde_json::from_str::<serde_json::Value>(payload_json.as_deref().unwrap_or(""))
            .ok()
            .and_then(|payload| {
                payload
                    .get("eventTs")
                    .and_then(|ts| ts.as_str())
                    .map(str::to_string)
            })
            .filter(|ts| !ts.trim().is_empty());
    Ok(Some(JobSlackTarget {
        channel,
        thread_ts,
        trigger_ts,
    }))
}

fn load_job(db_path: &Path, job_id: &str) -> Result<(Option<JobSlackTarget>, AppSettings), String> {
    let connection = Connection::open(db_path).map_err(|err| format!("db open failed: {err}"))?;
    Ok((
        job_slack_target(&connection, job_id)?,
        read_app_settings(&connection)?,
    ))
}

/// Records something done from the app in the run's trace. Best effort: the
/// Slack action already happened, so a failed write must not undo it.
fn log_app_action(
    db_path: &Path,
    job_id: &str,
    level: &str,
    stage: &str,
    message: &str,
    data: serde_json::Value,
) {
    let Ok(connection) = Connection::open(db_path) else {
        return;
    };
    let _ = connection.execute(
        "INSERT INTO job_logs (job_id, level, stage, message, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        params![
            job_id,
            level,
            stage,
            message,
            data.to_string(),
            Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
        ],
    );
}

/// Quote a value for a curl config file.
fn curl_config_quote(value: &str) -> String {
    let escaped = value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r");
    format!("\"{escaped}\"")
}

/// Run curl with `config` on stdin, so the token never shows up in the
/// process list, and return what it wrote to stdout.
async fn run_curl(config: &str, args: &[&str]) -> Result<Vec<u8>, String> {
    use tokio::io::AsyncWriteExt;

    let mut child = Command::new("/usr/bin/curl")
        .args(["-sS", "-K", "-"])
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("could not start curl: {err}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(config.as_bytes())
            .await
            .map_err(|err| format!("could not write curl config: {err}"))?;
    }
    let output = child
        .wait_with_output()
        .await
        .map_err(|err| format!("curl failed: {err}"))?;
    if !output.status.success() {
        return Err(format!(
            "Slack request failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(output.stdout)
}

fn auth_header(token: &str) -> String {
    format!(
        "header = {}\n",
        curl_config_quote(&format!("Authorization: Bearer {token}"))
    )
}

/// Call a Slack Web API method.
async fn slack_api(
    token: &str,
    method: &str,
    fields: &[(&str, &str)],
) -> Result<serde_json::Value, String> {
    let mut config = auth_header(token);
    config.push_str(&format!(
        "url = {}\n",
        curl_config_quote(&format!("https://slack.com/api/{method}"))
    ));
    for (key, value) in fields {
        config.push_str(&format!(
            "data-urlencode = {}\n",
            curl_config_quote(&format!("{key}={value}"))
        ));
    }
    let stdout = run_curl(&config, &["--max-time", "15"]).await?;
    serde_json::from_slice(&stdout)
        .map_err(|err| format!("Slack sent an unreadable response: {err}"))
}

fn slack_error_code(response: &serde_json::Value) -> Option<String> {
    if response.get("ok").and_then(|ok| ok.as_bool()) == Some(true) {
        return None;
    }
    Some(
        response
            .get("error")
            .and_then(|e| e.as_str())
            .unwrap_or("unknown_error")
            .to_string(),
    )
}

/// Call Slack and turn `ok: false` into an error naming Slack's code.
async fn slack_call(
    token: &str,
    method: &str,
    fields: &[(&str, &str)],
) -> Result<serde_json::Value, String> {
    let response = slack_api(token, method, fields).await?;
    match slack_error_code(&response) {
        None => Ok(response),
        Some(code) => Err(format!("Slack said {code}")),
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SlackUser {
    name: String,
    avatar_url: Option<String>,
    is_bot: bool,
}

#[derive(Clone)]
struct ChannelInfo {
    name: Option<String>,
    kind: &'static str,
}

/// Users looked up so far; `None` marks an id Slack had no user for, so it
/// isn't asked about again on every refresh.
fn user_cache() -> &'static Mutex<HashMap<String, Option<SlackUser>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<SlackUser>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// users.info lookups to run at once.
const USER_LOOKUP_BATCH: usize = 8;

fn channel_cache() -> &'static Mutex<HashMap<String, ChannelInfo>> {
    static CACHE: OnceLock<Mutex<HashMap<String, ChannelInfo>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn permalink_cache() -> &'static Mutex<HashMap<String, String>> {
    static CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn slack_user_from(response: &serde_json::Value) -> Option<SlackUser> {
    let user = response.get("user")?;
    let profile = user.get("profile");
    let pick = |value: Option<&serde_json::Value>| {
        value
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    let name = pick(profile.and_then(|p| p.get("display_name")))
        .or_else(|| pick(profile.and_then(|p| p.get("real_name"))))
        .or_else(|| pick(user.get("real_name")))
        .or_else(|| pick(user.get("name")))?;
    Some(SlackUser {
        name,
        avatar_url: pick(profile.and_then(|p| p.get("image_72")))
            .or_else(|| pick(profile.and_then(|p| p.get("image_48")))),
        is_bot: user
            .get("is_bot")
            .and_then(|b| b.as_bool())
            .unwrap_or(false),
    })
}

/// Every user a set of messages names: authors, reactors and `<@U…>` mentions.
fn user_ids_in(messages: &[serde_json::Value]) -> HashSet<String> {
    let mut ids = HashSet::new();
    for message in messages {
        if let Some(user) = message.get("user").and_then(|u| u.as_str()) {
            ids.insert(user.to_string());
        }
        for reaction in message
            .get("reactions")
            .and_then(|r| r.as_array())
            .into_iter()
            .flatten()
        {
            for user in reaction
                .get("users")
                .and_then(|u| u.as_array())
                .into_iter()
                .flatten()
            {
                if let Some(user) = user.as_str() {
                    ids.insert(user.to_string());
                }
            }
        }
        let text = message.get("text").and_then(|t| t.as_str()).unwrap_or("");
        let mut rest = text;
        while let Some(start) = rest.find("<@") {
            let after = &rest[start + 2..];
            let end = after
                .find(|c: char| c == '>' || c == '|')
                .unwrap_or(after.len());
            let id = &after[..end];
            if !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric()) {
                ids.insert(id.to_string());
            }
            rest = &after[end..];
        }
    }
    ids
}

/// Names and avatars for `ids`, from the cache or users.info (a few at a time).
async fn resolve_users(token: &str, ids: HashSet<String>) -> HashMap<String, SlackUser> {
    let mut found = HashMap::new();
    let mut missing = Vec::new();
    {
        let cache = user_cache().lock().unwrap_or_else(|e| e.into_inner());
        for id in ids {
            match cache.get(&id) {
                Some(Some(user)) => {
                    found.insert(id, user.clone());
                }
                Some(None) => {}
                None => missing.push(id),
            }
        }
    }
    for batch in missing.chunks(USER_LOOKUP_BATCH) {
        let mut lookups = JoinSet::new();
        for id in batch {
            let token = token.to_string();
            let id = id.clone();
            lookups.spawn(async move {
                let response = slack_call(&token, "users.info", &[("user", &id)]).await;
                (id, response)
            });
        }
        while let Some(joined) = lookups.join_next().await {
            let Ok((id, response)) = joined else {
                continue;
            };
            let user = match &response {
                Ok(response) => slack_user_from(response),
                // Only a definite "no such user" is remembered; a network
                // blip is retried on the next refresh.
                Err(err) if err.ends_with("user_not_found") => None,
                Err(_) => continue,
            };
            if let Some(user) = &user {
                found.insert(id.clone(), user.clone());
            }
            user_cache()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(id, user);
        }
    }
    found
}

async fn channel_info(token: &str, channel: &str) -> ChannelInfo {
    if let Some(info) = channel_cache()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(channel)
    {
        return info.clone();
    }
    let fallback_kind = if channel.starts_with('D') {
        "im"
    } else {
        "channel"
    };
    let info = match slack_call(token, "conversations.info", &[("channel", channel)]).await {
        Ok(response) => {
            let c = response.get("channel");
            let flag = |key: &str| {
                c.and_then(|c| c.get(key))
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
            };
            let kind = if flag("is_im") {
                "im"
            } else if flag("is_mpim") {
                "mpim"
            } else if flag("is_private") {
                "private"
            } else {
                fallback_kind
            };
            let name = c
                .and_then(|c| c.get("name"))
                .and_then(|n| n.as_str())
                .map(str::to_string);
            ChannelInfo { name, kind }
        }
        // Leave it out of the cache so the next read tries again.
        Err(_) => {
            return ChannelInfo {
                name: None,
                kind: fallback_kind,
            }
        }
    };
    channel_cache()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(channel.to_string(), info.clone());
    info
}

async fn thread_permalink(token: &str, channel: &str, thread_ts: &str) -> Option<String> {
    let key = format!("{channel}:{thread_ts}");
    if let Some(link) = permalink_cache()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&key)
    {
        return Some(link.clone());
    }
    let response = slack_call(
        token,
        "chat.getPermalink",
        &[("channel", channel), ("message_ts", thread_ts)],
    )
    .await
    .ok()?;
    let link = response.get("permalink")?.as_str()?.to_string();
    permalink_cache()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(key, link.clone());
    Some(link)
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunThread {
    /// False when the run has no Slack thread (nothing to show).
    has_thread: bool,
    channel_id: String,
    channel_name: Option<String>,
    /// "channel", "private", "im" or "mpim".
    channel_kind: &'static str,
    thread_ts: String,
    trigger_ts: Option<String>,
    bot_user_id: String,
    permalink: Option<String>,
    /// Slack message objects as conversations.replies returns them, oldest first.
    messages: Vec<serde_json::Value>,
    /// Replies in the thread per Slack, which can exceed what `messages` holds.
    reply_count: usize,
    /// True when the thread is longer than the app reads.
    truncated: bool,
    users: HashMap<String, SlackUser>,
    /// Set when the app could not read the thread; `messages` is then empty.
    read_error: Option<SlackReadError>,
}

#[tauri::command]
pub(crate) async fn get_run_thread(
    job_id: String,
    state: State<'_, AppState>,
) -> Result<RunThread, String> {
    get_run_thread_inner(&state.db_path, &job_id).await
}

async fn get_run_thread_inner(db_path: &Path, job_id: &str) -> Result<RunThread, String> {
    let (target, settings) = load_job(db_path, job_id)?;
    let Some(target) = target else {
        return Ok(RunThread::default());
    };
    let token = settings.slack_bot_token.as_str();
    if settings.bot_user_id.trim().is_empty() {
        return Err("Set the bot user ID in Settings first.".to_string());
    }
    let mut thread = RunThread {
        has_thread: true,
        channel_id: target.channel.clone(),
        thread_ts: target.thread_ts.clone(),
        trigger_ts: target.trigger_ts.clone(),
        bot_user_id: settings.bot_user_id.trim().to_string(),
        ..RunThread::default()
    };

    let mut cursor = String::new();
    for _ in 0..MAX_REPLY_PAGES {
        let mut fields = vec![
            ("channel", target.channel.as_str()),
            ("ts", target.thread_ts.as_str()),
            ("limit", "200"),
        ];
        if !cursor.is_empty() {
            fields.push(("cursor", cursor.as_str()));
        }
        let response = slack_api(token, "conversations.replies", &fields).await?;
        if let Some(code) = slack_error_code(&response) {
            thread.messages.clear();
            thread.read_error = Some(classify_read_error(code));
            break;
        }
        if let Some(messages) = response.get("messages").and_then(|m| m.as_array()) {
            thread.messages.extend(messages.iter().cloned());
        }
        cursor = response
            .pointer("/response_metadata/next_cursor")
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .to_string();
        if cursor.is_empty() {
            break;
        }
    }
    thread.truncated = thread.read_error.is_none() && !cursor.is_empty();
    thread.messages = in_thread_order(std::mem::take(&mut thread.messages));
    thread.reply_count = thread
        .messages
        .iter()
        .find(|m| m.get("ts").and_then(|t| t.as_str()) == Some(target.thread_ts.as_str()))
        .and_then(|parent| parent.get("reply_count"))
        .and_then(|count| count.as_u64())
        .map(|count| count as usize)
        .unwrap_or_else(|| thread.messages.len().saturating_sub(1));

    let info = channel_info(token, &target.channel).await;
    thread.channel_name = info.name;
    thread.channel_kind = info.kind;
    if thread.read_error.is_none() {
        let mut ids = user_ids_in(&thread.messages);
        ids.insert(thread.bot_user_id.clone());
        ids.remove("");
        thread.users = resolve_users(token, ids).await;
        thread.permalink = thread_permalink(token, &target.channel, &target.thread_ts).await;
    }
    Ok(thread)
}

/// Slack pages a long thread newest first (checked 2026-10-22) and repeats the
/// parent on every page, so put the pages back together: one copy of each
/// message, oldest first. A thread past the page limit keeps its newest part.
fn in_thread_order(messages: Vec<serde_json::Value>) -> Vec<serde_json::Value> {
    fn ts_key(message: &serde_json::Value) -> (u64, u64) {
        let ts = message.get("ts").and_then(|t| t.as_str()).unwrap_or("");
        let (secs, micros) = ts.split_once('.').unwrap_or((ts, "0"));
        (secs.parse().unwrap_or(0), micros.parse().unwrap_or(0))
    }
    let mut seen = HashSet::new();
    let mut unique: Vec<serde_json::Value> = messages
        .into_iter()
        .filter(|m| {
            seen.insert(
                m.get("ts")
                    .and_then(|t| t.as_str())
                    .unwrap_or("")
                    .to_string(),
            )
        })
        .collect();
    unique.sort_by_key(ts_key);
    unique
}

fn require_target(target: Option<JobSlackTarget>) -> Result<JobSlackTarget, String> {
    target.ok_or_else(|| "This run has no Slack thread.".to_string())
}

fn is_slack_ts(ts: &str) -> bool {
    let mut parts = ts.split('.');
    matches!(
        (parts.next(), parts.next(), parts.next()),
        (Some(a), Some(b), None) if !a.is_empty() && !b.is_empty() && a.chars().chain(b.chars()).all(|c| c.is_ascii_digit())
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PostedMessage {
    ts: String,
}

#[tauri::command]
pub(crate) async fn post_as_miniog(
    job_id: String,
    text: String,
    broadcast: Option<bool>,
    state: State<'_, AppState>,
) -> Result<PostedMessage, String> {
    post_as_miniog_inner(&state.db_path, &job_id, &text, broadcast.unwrap_or(false)).await
}

async fn post_as_miniog_inner(
    db_path: &Path,
    job_id: &str,
    text: &str,
    broadcast: bool,
) -> Result<PostedMessage, String> {
    if text.trim().is_empty() {
        return Err("Write something first.".to_string());
    }
    let (target, settings) = load_job(db_path, job_id)?;
    let target = require_target(target)?;
    let result = post_in_thread(&settings.slack_bot_token, &target, text, broadcast).await;
    let ts = result
        .as_ref()
        .map(|posted| posted.ts.clone())
        .unwrap_or_default();
    traced(
        db_path,
        job_id,
        "watchtower.slack.post",
        "Posted in the thread as miniOG from Watchtower.",
        "Posting as miniOG from Watchtower failed.",
        serde_json::json!({ "ts": ts, "text": text, "broadcast": broadcast }),
        result,
    )
}

async fn post_in_thread(
    token: &str,
    target: &JobSlackTarget,
    text: &str,
    broadcast: bool,
) -> Result<PostedMessage, String> {
    let mut fields = vec![
        ("channel", target.channel.as_str()),
        ("thread_ts", target.thread_ts.as_str()),
        ("text", text),
    ];
    // "Also send to channel": the reply shows in the channel too.
    if broadcast {
        fields.push(("reply_broadcast", "true"));
    }
    let response = slack_call(token, "chat.postMessage", &fields).await?;
    let ts = response
        .get("ts")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_string();
    // Slack posts to the channel itself when the thread's first message is gone.
    let landed_in = response
        .pointer("/message/thread_ts")
        .and_then(|t| t.as_str());
    if landed_in != Some(target.thread_ts.as_str()) {
        let removed = slack_call(
            token,
            "chat.delete",
            &[("channel", &target.channel), ("ts", &ts)],
        )
        .await;
        return Err(match removed {
            Ok(_) => "The thread is gone, so the reply would have landed in the channel. It was taken back.".to_string(),
            Err(err) => format!(
                "The thread is gone, so the reply landed in the channel (message {ts}), and taking it back failed ({err}). Delete it in Slack."
            ),
        });
    }
    Ok(PostedMessage { ts })
}

/// Logs an action's outcome in the run's trace and hands the result back.
fn traced<T>(
    db_path: &Path,
    job_id: &str,
    stage: &str,
    done: &str,
    failed: &str,
    mut data: serde_json::Value,
    result: Result<T, String>,
) -> Result<T, String> {
    match &result {
        Ok(_) => log_app_action(db_path, job_id, "INFO", stage, done, data),
        Err(err) => {
            data["error"] = serde_json::json!(err);
            log_app_action(db_path, job_id, "WARN", stage, failed, data);
        }
    }
    result
}

#[tauri::command]
pub(crate) async fn edit_miniog_message(
    job_id: String,
    ts: String,
    text: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    edit_miniog_message_inner(&state.db_path, &job_id, &ts, &text).await
}

async fn edit_miniog_message_inner(
    db_path: &Path,
    job_id: &str,
    ts: &str,
    text: &str,
) -> Result<(), String> {
    if !is_slack_ts(ts) {
        return Err(format!("{ts} is not a Slack message timestamp."));
    }
    if text.trim().is_empty() {
        return Err("A message can't be empty; delete it instead.".to_string());
    }
    let (target, settings) = load_job(db_path, job_id)?;
    let target = require_target(target)?;
    // Without `blocks`, Slack keeps showing a message's old blocks over the new text.
    let result = slack_call(
        &settings.slack_bot_token,
        "chat.update",
        &[
            ("channel", &target.channel),
            ("ts", ts),
            ("text", text),
            ("blocks", "[]"),
        ],
    )
    .await
    .map(|_| ());
    traced(
        db_path,
        job_id,
        "watchtower.slack.edit",
        "Edited a miniOG message from Watchtower.",
        "Editing a miniOG message from Watchtower failed.",
        serde_json::json!({ "ts": ts, "text": text }),
        result,
    )
}

#[tauri::command]
pub(crate) async fn delete_miniog_message(
    job_id: String,
    ts: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    delete_miniog_message_inner(&state.db_path, &job_id, &ts).await
}

async fn delete_miniog_message_inner(db_path: &Path, job_id: &str, ts: &str) -> Result<(), String> {
    if !is_slack_ts(ts) {
        return Err(format!("{ts} is not a Slack message timestamp."));
    }
    let (target, settings) = load_job(db_path, job_id)?;
    let target = require_target(target)?;
    let result = slack_call(
        &settings.slack_bot_token,
        "chat.delete",
        &[("channel", &target.channel), ("ts", ts)],
    )
    .await
    .map(|_| ());
    traced(
        db_path,
        job_id,
        "watchtower.slack.delete",
        "Deleted a miniOG message from Watchtower.",
        "Deleting a miniOG message from Watchtower failed.",
        serde_json::json!({ "ts": ts }),
        result,
    )
}

fn is_reaction_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "_+-':".contains(c))
}

#[tauri::command]
pub(crate) async fn set_miniog_reaction(
    job_id: String,
    ts: String,
    name: String,
    add: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    set_miniog_reaction_inner(&state.db_path, &job_id, &ts, &name, add).await
}

async fn set_miniog_reaction_inner(
    db_path: &Path,
    job_id: &str,
    ts: &str,
    name: &str,
    add: bool,
) -> Result<(), String> {
    if !is_slack_ts(ts) {
        return Err(format!("{ts} is not a Slack message timestamp."));
    }
    if !is_reaction_name(name) {
        return Err(format!(":{name}: is not an emoji name."));
    }
    let (target, settings) = load_job(db_path, job_id)?;
    let target = require_target(target)?;
    let method = if add {
        "reactions.add"
    } else {
        "reactions.remove"
    };
    let result = slack_api(
        &settings.slack_bot_token,
        method,
        &[
            ("channel", &target.channel),
            ("timestamp", ts),
            ("name", name),
        ],
    )
    .await
    .and_then(|response| match slack_error_code(&response).as_deref() {
        // Already in the state asked for.
        None | Some("already_reacted") | Some("no_reaction") => Ok(()),
        Some(code) => Err(format!("Slack said {code}")),
    });
    let (stage, done, failed) = if add {
        (
            "watchtower.slack.react",
            "Added a miniOG reaction from Watchtower.",
            "Adding a miniOG reaction from Watchtower failed.",
        )
    } else {
        (
            "watchtower.slack.unreact",
            "Removed a miniOG reaction from Watchtower.",
            "Removing a miniOG reaction from Watchtower failed.",
        )
    };
    traced(
        db_path,
        job_id,
        stage,
        done,
        failed,
        serde_json::json!({ "ts": ts, "name": name }),
        result,
    )
}

/// Images in a thread are private Slack files; the token goes only to Slack's file host.
const SLACK_FILE_HOST: &str = "https://files.slack.com/";
const MAX_IMAGE_BYTES: usize = 15 * 1024 * 1024;
const MAX_UPLOAD_BYTES: usize = 20 * 1024 * 1024;

fn is_image_mimetype(mimetype: &str) -> bool {
    mimetype.strip_prefix("image/").is_some_and(|sub| {
        !sub.is_empty()
            && sub
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
    })
}

/// A Slack-hosted image as a data URL the page can show.
#[tauri::command]
pub(crate) async fn get_slack_image(
    url: String,
    mimetype: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    get_slack_image_inner(&state.db_path, &url, &mimetype).await
}

async fn get_slack_image_inner(
    db_path: &Path,
    url: &str,
    mimetype: &str,
) -> Result<String, String> {
    if !url.starts_with(SLACK_FILE_HOST) {
        return Err("Only Slack-hosted images can be shown.".to_string());
    }
    if !is_image_mimetype(mimetype) {
        return Err(format!("{mimetype} is not an image."));
    }
    let settings = {
        let connection =
            Connection::open(db_path).map_err(|err| format!("db open failed: {err}"))?;
        read_app_settings(&connection)?
    };
    let mut config = auth_header(&settings.slack_bot_token);
    config.push_str(&format!("url = {}\n", curl_config_quote(url)));
    let max = MAX_IMAGE_BYTES.to_string();
    let bytes = run_curl(
        &config,
        &["--fail", "--max-time", "30", "--max-filesize", &max],
    )
    .await?;
    // Without access Slack answers with its sign-in page instead of the file.
    if looks_like_html(&bytes) {
        return Err("Slack sent a web page instead of the image.".to_string());
    }
    Ok(format!(
        "data:{mimetype};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    ))
}

fn looks_like_html(bytes: &[u8]) -> bool {
    let start: String = String::from_utf8_lossy(&bytes[..bytes.len().min(64)])
        .trim_start()
        .to_ascii_lowercase();
    start.starts_with("<!doctype html") || start.starts_with("<html")
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DirectoryPerson {
    id: String,
    name: String,
    real_name: Option<String>,
    avatar_url: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DirectoryGroup {
    id: String,
    handle: String,
    name: String,
}

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SlackDirectory {
    people: Vec<DirectoryPerson>,
    groups: Vec<DirectoryGroup>,
}

/// How long the workspace directory is reused before it is read again.
const DIRECTORY_TTL: Duration = Duration::from_secs(60 * 60);
/// users.list pages of 200 to read at most.
const MAX_DIRECTORY_PAGES: usize = 50;

fn directory_cache() -> &'static Mutex<Option<(Instant, SlackDirectory)>> {
    static CACHE: OnceLock<Mutex<Option<(Instant, SlackDirectory)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn directory_person(member: &serde_json::Value) -> Option<DirectoryPerson> {
    let flag = |key: &str| member.get(key).and_then(|v| v.as_bool()).unwrap_or(false);
    if flag("deleted")
        || flag("is_bot")
        || flag("is_app_user")
        || member.get("id")?.as_str()? == "USLACKBOT"
    {
        return None;
    }
    let profile = member.get("profile");
    let text = |value: Option<&serde_json::Value>| {
        value
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    let real_name =
        text(profile.and_then(|p| p.get("real_name"))).or_else(|| text(member.get("real_name")));
    let name = text(profile.and_then(|p| p.get("display_name")))
        .or_else(|| real_name.clone())
        .or_else(|| text(member.get("name")))?;
    Some(DirectoryPerson {
        id: member.get("id")?.as_str()?.to_string(),
        name,
        real_name,
        avatar_url: text(profile.and_then(|p| p.get("image_48"))),
    })
}

fn directory_group(group: &serde_json::Value) -> Option<DirectoryGroup> {
    if group
        .get("date_delete")
        .and_then(|d| d.as_i64())
        .unwrap_or(0)
        != 0
    {
        return None;
    }
    Some(DirectoryGroup {
        id: group.get("id")?.as_str()?.to_string(),
        handle: group.get("handle")?.as_str()?.to_string(),
        name: group
            .get("name")
            .and_then(|n| n.as_str())
            .unwrap_or("")
            .to_string(),
    })
}

/// The workspace's people and user groups, for @mention suggestions.
#[tauri::command]
pub(crate) async fn get_slack_directory(
    state: State<'_, AppState>,
) -> Result<SlackDirectory, String> {
    get_slack_directory_inner(&state.db_path).await
}

async fn get_slack_directory_inner(db_path: &Path) -> Result<SlackDirectory, String> {
    if let Some((read_at, directory)) = directory_cache()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
    {
        if read_at.elapsed() < DIRECTORY_TTL {
            return Ok(directory.clone());
        }
    }
    let settings = {
        let connection =
            Connection::open(db_path).map_err(|err| format!("db open failed: {err}"))?;
        read_app_settings(&connection)?
    };
    let token = settings.slack_bot_token.as_str();
    let mut directory = SlackDirectory::default();
    let mut cursor = String::new();
    for _ in 0..MAX_DIRECTORY_PAGES {
        let mut fields = vec![("limit", "200")];
        if !cursor.is_empty() {
            fields.push(("cursor", cursor.as_str()));
        }
        let response = slack_call(token, "users.list", &fields).await?;
        for member in response
            .get("members")
            .and_then(|m| m.as_array())
            .into_iter()
            .flatten()
        {
            directory.people.extend(directory_person(member));
        }
        cursor = response
            .pointer("/response_metadata/next_cursor")
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .to_string();
        if cursor.is_empty() {
            break;
        }
    }
    // Groups are a nice-to-have; people still work without them.
    if let Ok(response) = slack_call(token, "usergroups.list", &[]).await {
        for group in response
            .get("usergroups")
            .and_then(|g| g.as_array())
            .into_iter()
            .flatten()
        {
            directory.groups.extend(directory_group(group));
        }
    }
    *directory_cache().lock().unwrap_or_else(|e| e.into_inner()) =
        Some((Instant::now(), directory.clone()));
    Ok(directory)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UploadFile {
    name: String,
    data_base64: String,
}

/// Post files in the thread as miniOG, with `text` as the message beside them.
#[tauri::command]
pub(crate) async fn upload_as_miniog(
    job_id: String,
    text: String,
    files: Vec<UploadFile>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    upload_as_miniog_inner(&state.db_path, &job_id, &text, files).await
}

async fn upload_as_miniog_inner(
    db_path: &Path,
    job_id: &str,
    text: &str,
    files: Vec<UploadFile>,
) -> Result<(), String> {
    if files.is_empty() {
        return Err("Pick a file first.".to_string());
    }
    let mut decoded = Vec::new();
    for file in files {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(file.data_base64.as_bytes())
            .map_err(|err| format!("{} could not be read: {err}", file.name))?;
        if bytes.is_empty() || bytes.len() > MAX_UPLOAD_BYTES {
            return Err(format!("{} must be between 1 byte and 20 MB.", file.name));
        }
        let name = file.name.trim();
        decoded.push((
            if name.is_empty() {
                "file".to_string()
            } else {
                name.to_string()
            },
            bytes,
        ));
    }
    let (target, settings) = load_job(db_path, job_id)?;
    let target = require_target(target)?;
    let names: Vec<_> = decoded
        .iter()
        .map(|(name, bytes)| serde_json::json!({ "name": name, "bytes": bytes.len() }))
        .collect();
    let result = upload_in_thread(&settings.slack_bot_token, &target, text, &decoded).await;
    traced(
        db_path,
        job_id,
        "watchtower.slack.upload",
        "Posted files in the thread as miniOG from Watchtower.",
        "Posting files as miniOG from Watchtower failed.",
        serde_json::json!({ "files": names, "text": text }),
        result,
    )
}

/// Slack's upload flow: ask for an upload URL per file, send the bytes there,
/// then share them all in the thread in one message.
async fn upload_in_thread(
    token: &str,
    target: &JobSlackTarget,
    text: &str,
    files: &[(String, Vec<u8>)],
) -> Result<(), String> {
    let mut uploaded = Vec::new();
    for (name, bytes) in files {
        let length = bytes.len().to_string();
        let response = slack_call(
            token,
            "files.getUploadURLExternal",
            &[("filename", name), ("length", &length)],
        )
        .await?;
        let upload_url = response
            .get("upload_url")
            .and_then(|u| u.as_str())
            .unwrap_or("");
        let file_id = response
            .get("file_id")
            .and_then(|f| f.as_str())
            .unwrap_or("");
        if !upload_url.starts_with(SLACK_FILE_HOST) || file_id.is_empty() {
            return Err("Slack did not give a usable upload address.".to_string());
        }
        let path = std::env::temp_dir().join(format!("watchtower-upload-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, bytes).map_err(|err| format!("could not stage {name}: {err}"))?;
        let config = format!(
            "url = {}\ndata-binary = {}\n",
            curl_config_quote(upload_url),
            curl_config_quote(&format!("@{}", path.display()))
        );
        let sent = run_curl(&config, &["--fail", "--max-time", "120"]).await;
        let _ = std::fs::remove_file(&path);
        sent.map_err(|err| format!("{name} did not upload: {err}"))?;
        uploaded.push(serde_json::json!({ "id": file_id, "title": name }));
    }
    let files_json = serde_json::Value::Array(uploaded).to_string();
    let mut fields = vec![
        ("files", files_json.as_str()),
        ("channel_id", target.channel.as_str()),
        ("thread_ts", target.thread_ts.as_str()),
    ];
    if !text.trim().is_empty() {
        fields.push(("initial_comment", text));
    }
    slack_call(token, "files.completeUploadExternal", &fields).await?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoveReactionsResult {
    removed: Vec<String>,
    failed: Vec<String>,
}

/// Remove miniOG's emojis from the message that started a job, for threads
/// the app cannot read. `names: None` tries every emoji miniOG uses.
#[tauri::command]
pub(crate) async fn remove_job_reactions(
    job_id: String,
    names: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<RemoveReactionsResult, String> {
    remove_job_reactions_inner(&state.db_path, &job_id, names).await
}

async fn remove_job_reactions_inner(
    db_path: &Path,
    job_id: &str,
    names: Option<Vec<String>>,
) -> Result<RemoveReactionsResult, String> {
    let (target, settings) = load_job(db_path, job_id)?;
    let Some(JobSlackTarget {
        channel,
        trigger_ts: Some(ts),
        ..
    }) = target
    else {
        return Err("This run did not start from a Slack message.".to_string());
    };
    let names = names.unwrap_or_else(|| {
        MINIOG_REACTION_NAMES
            .iter()
            .map(|name| name.to_string())
            .collect()
    });

    let mut result = RemoveReactionsResult {
        removed: Vec::new(),
        failed: Vec::new(),
    };
    for name in names {
        let response = slack_api(
            &settings.slack_bot_token,
            "reactions.remove",
            &[("channel", &channel), ("timestamp", &ts), ("name", &name)],
        )
        .await;
        match response.map(|r| slack_error_code(&r)) {
            Ok(None) => result.removed.push(name),
            // miniOG never left this one, or it or the message is already gone.
            Ok(Some(code)) if code == "no_reaction" || code == "message_not_found" => {}
            Ok(Some(code)) => {
                let bad_token = SLACK_AUTH_ERRORS.contains(&code.as_str());
                result.failed.push(format!("{name}: {code}"));
                if bad_token {
                    break;
                }
            }
            // curl itself failed; the next call would too.
            Err(err) => {
                result.failed.push(format!("{name}: {err}"));
                break;
            }
        }
    }
    if !result.removed.is_empty() {
        log_app_action(
            db_path,
            job_id,
            "INFO",
            "watchtower.slack.unreact",
            "Removed miniOG reactions from Watchtower.",
            serde_json::json!({ "ts": ts, "names": result.removed }),
        );
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::initialize_db;
    use std::{fs, path::PathBuf};
    use uuid::Uuid;

    fn test_db() -> (PathBuf, Connection) {
        let db_path = std::env::temp_dir().join(format!("watchtower-slack-{}.db", Uuid::new_v4()));
        initialize_db(&db_path).expect("initialize db");
        let connection = Connection::open(&db_path).expect("open db");
        (db_path, connection)
    }

    fn insert_job(
        connection: &Connection,
        id: &str,
        channel_id: &str,
        thread_ts: &str,
        payload_json: Option<&str>,
    ) {
        connection
            .execute(
                "INSERT INTO jobs (id, event_id, dedupe_key, workflow, status, channel_id, thread_ts, payload_json, created_at, updated_at)
                 VALUES (?, 'evt', 'dedupe', 'INFORMATIONAL', 'SUCCESS', ?, ?, ?, '2026-10-22T00:00:00Z', '2026-10-22T00:00:00Z')",
                params![id, channel_id, thread_ts, payload_json],
            )
            .expect("insert job");
    }

    #[test]
    fn job_slack_target_reads_channel_thread_and_trigger() {
        let (db_path, connection) = test_db();
        insert_job(
            &connection,
            "reply",
            "C0B5ZVDM7GU",
            "1.0",
            Some(r#"{"eventTs":"1.5"}"#),
        );
        insert_job(
            &connection,
            "dm",
            "D0AG35GQP4N",
            "2.0",
            Some(r#"{"eventTs":"2.0"}"#),
        );
        insert_job(
            &connection,
            "no-ts",
            "C0B5ZVDM7GU",
            "3.0",
            Some(r#"{"text":"hi"}"#),
        );
        insert_job(&connection, "no-payload", "C0B5ZVDM7GU", "4.0", None);
        insert_job(
            &connection,
            "launchpad",
            "launchpad",
            "5.0",
            Some(r#"{"eventTs":"5.0"}"#),
        );
        insert_job(&connection, "no-thread", "C0B5ZVDM7GU", " ", None);

        let target = |id: &str| job_slack_target(&connection, id).expect(id);
        assert_eq!(
            target("reply"),
            Some(JobSlackTarget {
                channel: "C0B5ZVDM7GU".into(),
                thread_ts: "1.0".into(),
                trigger_ts: Some("1.5".into())
            })
        );
        assert_eq!(target("dm").map(|t| t.trigger_ts), Some(Some("2.0".into())));
        assert_eq!(target("no-ts").map(|t| t.trigger_ts), Some(None));
        assert_eq!(
            target("no-payload").map(|t| t.thread_ts),
            Some("4.0".into())
        );
        assert_eq!(target("launchpad"), None);
        assert_eq!(target("no-thread"), None);
        assert!(job_slack_target(&connection, "missing").is_err());

        drop(connection);
        let _ = fs::remove_file(db_path);
    }

    #[test]
    fn user_ids_in_collects_authors_reactors_and_mentions() {
        let messages = vec![
            serde_json::json!({ "user": "UAUTHOR", "text": "hey <@UMENTION> and <@UNAMED|sam>, see <#C123|general> <!here>" }),
            serde_json::json!({ "bot_id": "B1", "text": "no user", "reactions": [{ "name": "eyes", "users": ["UREACT"] }] }),
        ];
        let ids = user_ids_in(&messages);
        let mut ids: Vec<_> = ids.into_iter().collect();
        ids.sort();
        assert_eq!(ids, vec!["UAUTHOR", "UMENTION", "UNAMED", "UREACT"]);
    }

    #[test]
    fn slack_user_from_prefers_display_name_and_falls_back() {
        let response = serde_json::json!({ "ok": true, "user": {
            "name": "dipesh", "real_name": "Dipesh R", "is_bot": false,
            "profile": { "display_name": "theOG", "real_name": "Dipesh R", "image_72": "https://a/72.png" }
        }});
        let user = slack_user_from(&response).expect("user");
        assert_eq!(user.name, "theOG");
        assert_eq!(user.avatar_url.as_deref(), Some("https://a/72.png"));

        let response = serde_json::json!({ "ok": true, "user": {
            "name": "miniog", "is_bot": true, "profile": { "display_name": "", "real_name": "miniOG", "image_48": "https://a/48.png" }
        }});
        let user = slack_user_from(&response).expect("bot user");
        assert_eq!(user.name, "miniOG");
        assert!(user.is_bot);
        assert_eq!(user.avatar_url.as_deref(), Some("https://a/48.png"));
    }

    #[test]
    fn in_thread_order_dedupes_pages_and_sorts_oldest_first() {
        // Slack pages newest first and repeats the parent on every page.
        let pages = vec![
            serde_json::json!({ "ts": "100.000001", "reply_count": 4 }),
            serde_json::json!({ "ts": "100.000400" }),
            serde_json::json!({ "ts": "100.000500" }),
            serde_json::json!({ "ts": "100.000001", "reply_count": 4 }),
            serde_json::json!({ "ts": "100.000020" }),
            serde_json::json!({ "ts": "99.900000" }),
        ];
        let order: Vec<_> = in_thread_order(pages)
            .iter()
            .map(|m| m["ts"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(
            order,
            vec![
                "99.900000",
                "100.000001",
                "100.000020",
                "100.000400",
                "100.000500"
            ]
        );
    }

    #[test]
    fn traced_logs_failures_as_warnings_with_the_error() {
        let (db_path, connection) = test_db();
        let result: Result<(), String> = traced(
            &db_path,
            "job-2",
            "watchtower.slack.edit",
            "done",
            "failed",
            serde_json::json!({ "ts": "1.0" }),
            Err("Slack said cant_update_message".to_string()),
        );
        assert!(result.is_err());
        let (level, message, data): (String, String, String) = connection
            .query_row(
                "SELECT level, message, data_json FROM job_logs WHERE job_id = 'job-2'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("log row");
        assert_eq!((level.as_str(), message.as_str()), ("WARN", "failed"));
        assert_eq!(
            data,
            r#"{"error":"Slack said cant_update_message","ts":"1.0"}"#
        );

        drop(connection);
        let _ = fs::remove_file(db_path);
    }

    #[test]
    fn image_checks_accept_only_images_and_spot_sign_in_pages() {
        assert!(is_image_mimetype("image/png"));
        assert!(is_image_mimetype("image/svg+xml"));
        assert!(!is_image_mimetype("image/"));
        assert!(!is_image_mimetype("text/html"));
        assert!(!is_image_mimetype("image/png\"\nurl = x"));
        assert!(looks_like_html(b"  <!DOCTYPE html><html>"));
        assert!(looks_like_html(b"<HTML><head>"));
        assert!(!looks_like_html(b"\x89PNG\r\n\x1a\n"));
    }

    #[test]
    fn directory_keeps_active_people_and_groups() {
        let person = serde_json::json!({
            "id": "U1", "name": "aditya", "real_name": "Aditya S",
            "profile": { "display_name": "", "real_name": "Aditya Sisodia", "image_48": "https://a/48.png" }
        });
        let found = directory_person(&person).expect("person");
        assert_eq!(
            (found.name.as_str(), found.real_name.as_deref()),
            ("Aditya Sisodia", Some("Aditya Sisodia"))
        );
        for skipped in [
            serde_json::json!({ "id": "U2", "name": "gone", "deleted": true }),
            serde_json::json!({ "id": "U3", "name": "bot", "is_bot": true }),
            serde_json::json!({ "id": "USLACKBOT", "name": "slackbot" }),
        ] {
            assert!(directory_person(&skipped).is_none());
        }
        let group = serde_json::json!({ "id": "S1", "handle": "core-dev", "name": "Core dev", "date_delete": 0 });
        assert_eq!(
            directory_group(&group).map(|g| g.handle),
            Some("core-dev".to_string())
        );
        let deleted = serde_json::json!({ "id": "S2", "handle": "old", "name": "Old", "date_delete": 1700000000 });
        assert!(directory_group(&deleted).is_none());
    }

    #[test]
    fn classify_read_error_sorts_slack_errors() {
        assert_eq!(
            classify_read_error("thread_not_found".into()).kind,
            "deleted"
        );
        assert_eq!(classify_read_error("missing_scope".into()).kind, "noAccess");
        assert_eq!(classify_read_error("invalid_auth".into()).kind, "auth");
        assert_eq!(classify_read_error("ratelimited".into()).kind, "other");
    }

    #[test]
    fn input_checks_accept_slack_shapes_only() {
        assert!(is_slack_ts("1792655209.535679"));
        assert!(!is_slack_ts("1792655209"));
        assert!(!is_slack_ts("1792655209.53x"));
        assert!(!is_slack_ts("1.2.3"));
        assert!(is_reaction_name("white_check_mark"));
        assert!(is_reaction_name("+1::skin-tone-2"));
        assert!(!is_reaction_name("Eyes"));
        assert!(!is_reaction_name("eyes\"&x=1"));
        assert!(!is_reaction_name(""));
    }

    #[test]
    fn log_app_action_writes_a_trace_row() {
        let (db_path, connection) = test_db();
        log_app_action(
            &db_path,
            "job-1",
            "INFO",
            "watchtower.slack.post",
            "Posted in the thread as miniOG from Watchtower.",
            serde_json::json!({ "ts": "1.0" }),
        );
        let (stage, data): (String, String) = connection
            .query_row(
                "SELECT stage, data_json FROM job_logs WHERE job_id = 'job-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("log row");
        assert_eq!(stage, "watchtower.slack.post");
        assert_eq!(data, r#"{"ts":"1.0"}"#);

        drop(connection);
        let _ = fs::remove_file(db_path);
    }

    #[test]
    fn curl_config_quote_escapes_quotes_backslashes_and_newlines() {
        assert_eq!(curl_config_quote("name=eyes"), r#""name=eyes""#);
        assert_eq!(curl_config_quote("a\"b\\c\nd"), r#""a\"b\\c\nd""#);
    }
}
