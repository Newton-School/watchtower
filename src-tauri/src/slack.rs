//! Slack calls the app makes as miniOG: reading a run's thread, and posting,
//! editing, deleting and reacting in it. Every command takes a job id and acts
//! only in that job's channel, so the page can't reach any other conversation.

use std::{
    collections::{HashMap, HashSet},
    path::Path,
    process::Stdio,
    sync::{Mutex, OnceLock},
};

use chrono::{SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
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

/// Call a Slack Web API method with curl. The config goes in on stdin so the
/// token never shows up in the process list.
async fn slack_api(
    token: &str,
    method: &str,
    fields: &[(&str, &str)],
) -> Result<serde_json::Value, String> {
    use tokio::io::AsyncWriteExt;

    let mut config = format!(
        "header = {}\nurl = {}\n",
        curl_config_quote(&format!("Authorization: Bearer {token}")),
        curl_config_quote(&format!("https://slack.com/api/{method}")),
    );
    for (key, value) in fields {
        config.push_str(&format!(
            "data-urlencode = {}\n",
            curl_config_quote(&format!("{key}={value}"))
        ));
    }

    let mut child = Command::new("/usr/bin/curl")
        .args(["-sS", "--max-time", "15", "-K", "-"])
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
    serde_json::from_slice(&output.stdout)
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

fn user_cache() -> &'static Mutex<HashMap<String, SlackUser>> {
    static CACHE: OnceLock<Mutex<HashMap<String, SlackUser>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

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

/// Names and avatars for `ids`, from the cache or users.info (looked up in parallel).
async fn resolve_users(token: &str, ids: HashSet<String>) -> HashMap<String, SlackUser> {
    let mut found = HashMap::new();
    let mut missing = Vec::new();
    {
        let cache = user_cache().lock().unwrap_or_else(|e| e.into_inner());
        for id in ids {
            match cache.get(&id) {
                Some(user) => {
                    found.insert(id, user.clone());
                }
                None => missing.push(id),
            }
        }
    }
    let mut lookups = JoinSet::new();
    for id in missing {
        let token = token.to_string();
        lookups.spawn(async move {
            let user = slack_call(&token, "users.info", &[("user", &id)])
                .await
                .ok()
                .and_then(|response| slack_user_from(&response));
            (id, user)
        });
    }
    while let Some(Ok((id, user))) = lookups.join_next().await {
        if let Some(user) = user {
            user_cache()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(id.clone(), user.clone());
            found.insert(id, user);
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
    /// Slack message objects as conversations.replies returns them.
    messages: Vec<serde_json::Value>,
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
    state: State<'_, AppState>,
) -> Result<PostedMessage, String> {
    post_as_miniog_inner(&state.db_path, &job_id, &text).await
}

async fn post_as_miniog_inner(
    db_path: &Path,
    job_id: &str,
    text: &str,
) -> Result<PostedMessage, String> {
    if text.trim().is_empty() {
        return Err("Write something first.".to_string());
    }
    let (target, settings) = load_job(db_path, job_id)?;
    let target = require_target(target)?;
    let result = slack_call(
        &settings.slack_bot_token,
        "chat.postMessage",
        &[
            ("channel", &target.channel),
            ("thread_ts", &target.thread_ts),
            ("text", text),
        ],
    )
    .await;
    match result {
        Ok(response) => {
            let ts = response
                .get("ts")
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .to_string();
            log_app_action(
                db_path,
                job_id,
                "INFO",
                "watchtower.slack.post",
                "Posted in the thread as miniOG from Watchtower.",
                serde_json::json!({ "ts": ts, "text": text }),
            );
            Ok(PostedMessage { ts })
        }
        Err(err) => {
            log_app_action(
                db_path,
                job_id,
                "WARN",
                "watchtower.slack.post",
                "Posting as miniOG from Watchtower failed.",
                serde_json::json!({ "error": err }),
            );
            Err(err)
        }
    }
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
    slack_call(
        &settings.slack_bot_token,
        "chat.update",
        &[("channel", &target.channel), ("ts", ts), ("text", text)],
    )
    .await?;
    log_app_action(
        db_path,
        job_id,
        "INFO",
        "watchtower.slack.edit",
        "Edited a miniOG message from Watchtower.",
        serde_json::json!({ "ts": ts, "text": text }),
    );
    Ok(())
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
    slack_call(
        &settings.slack_bot_token,
        "chat.delete",
        &[("channel", &target.channel), ("ts", ts)],
    )
    .await?;
    log_app_action(
        db_path,
        job_id,
        "INFO",
        "watchtower.slack.delete",
        "Deleted a miniOG message from Watchtower.",
        serde_json::json!({ "ts": ts }),
    );
    Ok(())
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
    let response = slack_api(
        &settings.slack_bot_token,
        method,
        &[
            ("channel", &target.channel),
            ("timestamp", ts),
            ("name", name),
        ],
    )
    .await?;
    match slack_error_code(&response).as_deref() {
        // Already in the state asked for.
        None | Some("already_reacted") | Some("no_reaction") => {}
        Some(code) => return Err(format!("Slack said {code}")),
    }
    let (stage, message) = if add {
        (
            "watchtower.slack.react",
            "Added a miniOG reaction from Watchtower.",
        )
    } else {
        (
            "watchtower.slack.unreact",
            "Removed a miniOG reaction from Watchtower.",
        )
    };
    log_app_action(
        db_path,
        job_id,
        "INFO",
        stage,
        message,
        serde_json::json!({ "ts": ts, "name": name }),
    );
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
