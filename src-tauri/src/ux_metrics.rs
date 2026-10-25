//! UX metrics (issue #711): how a run feels from the requester's side, for the
//! last 7 days beside the 7 before, read from the local job store. Read-only;
//! nothing here posts anywhere.
//!
//! Every time is measured from the ask (the Slack message's own timestamp)
//! and only over the runs that reached that point, so "merged" counts the PRs
//! miniOG merged, not the ones people merged on GitHub.

use std::collections::{BTreeMap, HashMap, HashSet};

use chrono::{DateTime, Duration, SecondsFormat, Utc};
use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::Value;

const WEEK_DAYS: i64 = 7;
/// Messages posted this long after a job ended still belong to it (the last
/// reply can land just after the job record is closed).
const MESSAGE_GRACE_MS: i64 = 120_000;

/// Stages that mark the plan being posted for approval.
const PLAN_STAGES: [&str; 3] = [
    "plan.detail.posted",
    "implementation.approval.waiting",
    "pipeline.approval.waiting",
];
/// Stages that mark miniOG's first reply when the thread wasn't captured.
const ACK_FALLBACK_STAGES: [&str; 3] = [
    "job.acknowledged",
    "agentic.pr_review.ack_posted",
    "router.unsupported.replied",
];
const APPROVED_STAGE: &str = "pipeline.approval.approved";
const REQUESTER_CONFIRMED_STAGE: &str = "pipeline.approval.requester_confirmed";
/// A person had to answer miniOG during a change run: plan approvals and
/// confirmations, rejections, changes asked for, clarifying questions,
/// answers from the app. Merge and deploy confirmations happen in later jobs
/// of their own, so they are not here.
const INTERVENTION_STAGES: [&str; 7] = [
    APPROVED_STAGE,
    REQUESTER_CONFIRMED_STAGE,
    "pipeline.approval.rejected",
    "pipeline.approval.feedback",
    "router.clarify.asked",
    "workflow.repo.clarify",
    "watchtower.run.answer",
];
/// Every quick-action stage starts with this; the loader reads them all so a
/// merge, close or sync can be told apart from a change run.
const QUICK_ACTION_PREFIX: &str = "implementation.quick_action";
const QUICK_ACTION_TOOL: &str = "QUICK_ACTION";
const CONTENT_MERGE_STAGE: &str = "implementation.quick_action.content_merge";
const PR_ACTION_STAGE: &str = "implementation.quick_action.pr_action";
const MARKETING_DEPLOY_DONE: &str = "deploy.marketing.done";
const WEB_DEPLOY_DONE: &str = "deploy.done";
const RESULT_STAGE: &str = "job.attempt.result";

/// The stages the loader reads; everything else in job_logs is ignored.
pub(crate) fn wanted_stages() -> Vec<&'static str> {
    let mut stages: Vec<&'static str> = Vec::new();
    stages.extend(PLAN_STAGES);
    stages.extend(ACK_FALLBACK_STAGES);
    stages.extend(INTERVENTION_STAGES);
    stages.extend([
        CONTENT_MERGE_STAGE,
        PR_ACTION_STAGE,
        MARKETING_DEPLOY_DONE,
        WEB_DEPLOY_DONE,
        RESULT_STAGE,
    ]);
    stages
}

#[derive(Debug, Clone)]
pub(crate) struct JobRow {
    pub id: String,
    /// The tool that actually ran (`executed_workflow`, else `workflow`).
    pub tool: String,
    pub status: String,
    pub channel_id: String,
    pub thread_ts: String,
    pub ask_ms: i64,
    pub created_ms: i64,
    pub end_ms: i64,
    /// A change run's PR, from `result_json.prUrl`.
    pub pr_url: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct LogRow {
    pub job_id: String,
    pub stage: String,
    pub message: String,
    pub data: Option<Value>,
    pub at_ms: i64,
}

#[derive(Debug, Clone)]
pub(crate) struct BotMessage {
    pub channel_id: String,
    pub thread_ts: String,
    pub ts_ms: i64,
}

#[derive(Debug, Default)]
pub(crate) struct MetricsInput {
    pub jobs: Vec<JobRow>,
    pub logs: Vec<LogRow>,
    pub bot_messages: Vec<BotMessage>,
    pub channel_names: HashMap<String, String>,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StepTiming {
    pub key: String,
    pub label: String,
    pub count: i64,
    pub median_ms: Option<f64>,
    pub p90_ms: Option<f64>,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InterventionStats {
    pub change_runs: i64,
    pub total: i64,
    pub mean_per_run: Option<f64>,
    pub median_per_run: Option<f64>,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolMessages {
    pub tool: String,
    pub runs: i64,
    pub mean: f64,
    pub median: f64,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolOutcomes {
    pub tool: String,
    pub jobs: i64,
    pub failed: i64,
    pub cancelled: i64,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CountRow {
    pub key: String,
    pub label: String,
    pub count: i64,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UxWindow {
    pub since_iso: String,
    pub until_iso: String,
    pub jobs: i64,
    pub steps: Vec<StepTiming>,
    pub interventions: InterventionStats,
    pub messages: Vec<ToolMessages>,
    pub outcomes: Vec<ToolOutcomes>,
    pub by_tool: Vec<CountRow>,
    pub by_channel: Vec<CountRow>,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UxMetrics {
    pub until_iso: String,
    pub current: UxWindow,
    pub previous: UxWindow,
}

/// Linear-interpolated percentile (the spreadsheet PERCENTILE.INC rule) of
/// unsorted values; `None` when there are none.
pub(crate) fn percentile(values: &[f64], p: f64) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let rank = (p / 100.0) * (sorted.len() as f64 - 1.0);
    let lower = rank.floor() as usize;
    let upper = rank.ceil() as usize;
    let weight = rank - lower as f64;
    Some(sorted[lower] + (sorted[upper] - sorted[lower]) * weight)
}

fn iso(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub(crate) fn parse_iso_ms(value: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|at| at.with_timezone(&Utc).timestamp_millis())
}

/// A Slack timestamp ("1792960235.697979") in milliseconds.
pub(crate) fn slack_ts_ms(ts: &str) -> Option<i64> {
    let seconds: f64 = ts.trim().parse().ok()?;
    if seconds <= 0.0 {
        return None;
    }
    Some((seconds * 1000.0).round() as i64)
}

fn normalize_pr_url(url: &str) -> String {
    url.trim().trim_end_matches('/').to_ascii_lowercase()
}

fn step(key: &str, label: &str, durations: Vec<f64>) -> StepTiming {
    StepTiming {
        key: key.to_string(),
        label: label.to_string(),
        count: durations.len() as i64,
        median_ms: percentile(&durations, 50.0),
        p90_ms: percentile(&durations, 90.0),
    }
}

/// When a job ended, as its logs tell it: the last workflow result, else the
/// job record's last update.
fn job_end_ms(job: &JobRow, logs: &[&LogRow]) -> i64 {
    logs.iter()
        .filter(|log| log.stage == RESULT_STAGE)
        .map(|log| log.at_ms)
        .max()
        .unwrap_or(job.end_ms)
}

/// PR URL → the earliest time miniOG merged it, from every loaded job.
fn merge_times(jobs: &[JobRow], logs_by_job: &HashMap<&str, Vec<&LogRow>>) -> HashMap<String, i64> {
    let mut merged: HashMap<String, i64> = HashMap::new();
    let mut record = |url: &str, at: i64| {
        merged
            .entry(normalize_pr_url(url))
            .and_modify(|existing| *existing = (*existing).min(at))
            .or_insert(at);
    };
    for job in jobs {
        // A merge that failed or was turned down leaves the job short of SUCCESS.
        if job.status != "SUCCESS" {
            continue;
        }
        let Some(logs) = logs_by_job.get(job.id.as_str()) else {
            continue;
        };
        for log in logs {
            let data = log.data.as_ref();
            if log.stage == CONTENT_MERGE_STAGE {
                if let Some(url) = data.and_then(|d| d.get("prUrl")).and_then(Value::as_str) {
                    record(url, log.at_ms);
                }
            } else if log.stage == PR_ACTION_STAGE {
                let is_merge = data
                    .and_then(|d| d.get("action"))
                    .and_then(Value::as_str)
                    .map(|action| action == "merge")
                    .unwrap_or(false);
                if !is_merge {
                    continue;
                }
                // The agent merges after this log; the job's end is when it was done.
                let end = job_end_ms(job, logs);
                if let Some(urls) = data.and_then(|d| d.get("prUrls")).and_then(Value::as_array) {
                    for url in urls.iter().filter_map(Value::as_str) {
                        record(url, end);
                    }
                }
            }
        }
    }
    merged
}

/// Successful prod deploys: (repo key, finished at).
fn prod_deploys(logs: &[LogRow]) -> Vec<(&'static str, i64)> {
    let mut out = Vec::new();
    for log in logs {
        let data = log.data.as_ref();
        if log.stage == MARKETING_DEPLOY_DONE {
            let ok = data
                .and_then(|d| d.get("conclusion"))
                .and_then(Value::as_str)
                .map(|c| c == "success")
                .unwrap_or(false);
            if ok {
                out.push(("newton-marketing-web", log.at_ms));
            }
        } else if log.stage == WEB_DEPLOY_DONE {
            let ok = data.and_then(|d| d.get("ok")).and_then(Value::as_bool).unwrap_or(false);
            if ok {
                out.push(("newton-web", log.at_ms));
            }
        }
    }
    out
}

fn repo_of_pr(url: &str) -> Option<&'static str> {
    let lower = url.to_ascii_lowercase();
    if lower.contains("/newton-marketing-web/pull/") {
        Some("newton-marketing-web")
    } else if lower.contains("/newton-web/pull/") {
        Some("newton-web")
    } else {
        None
    }
}

/// The person and the quoted reply in an approval log line, e.g.
/// `<@U1> approved the plan: "yes"` → ("U1", "yes").
fn answer_of(message: &str) -> Option<(&str, &str)> {
    let start = message.find("<@")? + 2;
    let end = start + message[start..].find('>')?;
    let user = message[start..end].split('|').next()?;
    let quote_start = message.find(": \"")? + 3;
    let quote_end = message.rfind('"')?;
    if quote_end < quote_start {
        return None;
    }
    Some((user, &message[quote_start..quote_end]))
}

/// One key per answer a person gave. A requester who may also approve logs
/// both an approval and a confirmation for the same reply, so those two
/// stages share a key built from who answered and what they said.
fn answer_key(log: &LogRow) -> (String, String) {
    if log.stage == APPROVED_STAGE || log.stage == REQUESTER_CONFIRMED_STAGE {
        if let Some((user, quote)) = answer_of(&log.message) {
            return (format!("plan-answer:{user}"), quote.to_string());
        }
    }
    (log.stage.clone(), log.message.clone())
}

/// The tool a job ran, telling a merge, close or sync apart from a change
/// run: both run the implementation workflow, but a quick action posts no plan.
fn tool_of(job: &JobRow, logs: &[&LogRow], has_plan: bool) -> String {
    if job.tool == "IMPLEMENTATION" && !has_plan && logs.iter().any(|log| log.stage.starts_with(QUICK_ACTION_PREFIX)) {
        return QUICK_ACTION_TOOL.to_string();
    }
    job.tool.clone()
}

fn window(input: &MetricsInput, since: DateTime<Utc>, until: DateTime<Utc>) -> UxWindow {
    let since_ms = since.timestamp_millis();
    let until_ms = until.timestamp_millis();
    let mut logs_by_job: HashMap<&str, Vec<&LogRow>> = HashMap::new();
    for log in &input.logs {
        logs_by_job.entry(log.job_id.as_str()).or_default().push(log);
    }
    let mut bot_by_thread: HashMap<(&str, &str), Vec<i64>> = HashMap::new();
    for message in &input.bot_messages {
        bot_by_thread
            .entry((message.channel_id.as_str(), message.thread_ts.as_str()))
            .or_default()
            .push(message.ts_ms);
    }
    // Every loaded job's ask, per thread: a job's messages stop where the
    // next ask in its thread starts, so two jobs never claim one message.
    let mut asks_by_thread: HashMap<(&str, &str), Vec<i64>> = HashMap::new();
    for job in &input.jobs {
        asks_by_thread
            .entry((job.channel_id.as_str(), job.thread_ts.as_str()))
            .or_default()
            .push(job.ask_ms);
    }
    let merged = merge_times(&input.jobs, &logs_by_job);
    let deploys = prod_deploys(&input.logs);

    let in_window: Vec<&JobRow> = input
        .jobs
        .iter()
        .filter(|job| job.created_ms >= since_ms && job.created_ms < until_ms)
        .collect();

    let mut first_reply = Vec::new();
    let mut to_plan = Vec::new();
    let mut approval_wait = Vec::new();
    let mut to_pr = Vec::new();
    let mut to_merge = Vec::new();
    let mut to_prod = Vec::new();
    let mut interventions_per_run: Vec<f64> = Vec::new();
    let mut messages_by_tool: BTreeMap<String, Vec<f64>> = BTreeMap::new();
    let mut outcomes: BTreeMap<String, ToolOutcomes> = BTreeMap::new();
    let mut by_tool: BTreeMap<String, i64> = BTreeMap::new();
    let mut by_channel: BTreeMap<String, i64> = BTreeMap::new();
    let empty: Vec<&LogRow> = Vec::new();

    for job in &in_window {
        let logs = logs_by_job.get(job.id.as_str()).unwrap_or(&empty);
        let end = job_end_ms(job, logs).max(job.end_ms);
        let thread = (job.channel_id.as_str(), job.thread_ts.as_str());
        let plan_at = logs
            .iter()
            .filter(|log| PLAN_STAGES.contains(&log.stage.as_str()))
            .map(|log| log.at_ms)
            .min();
        let tool = tool_of(job, logs, plan_at.is_some());
        *by_tool.entry(tool.clone()).or_default() += 1;
        *by_channel.entry(job.channel_id.clone()).or_default() += 1;
        let outcome = outcomes.entry(tool.clone()).or_insert_with(|| ToolOutcomes {
            tool: tool.clone(),
            jobs: 0,
            failed: 0,
            cancelled: 0,
        });
        outcome.jobs += 1;
        if job.status == "FAILED" {
            outcome.failed += 1;
        } else if job.status == "CANCELLED" {
            outcome.cancelled += 1;
        }

        // miniOG's messages in this thread while the job ran, up to the next
        // ask in the same thread.
        let next_ask = asks_by_thread
            .get(&thread)
            .and_then(|asks| asks.iter().copied().filter(|ask| *ask > job.ask_ms).min())
            .unwrap_or(i64::MAX);
        let posted: Vec<i64> = bot_by_thread
            .get(&thread)
            .map(|times| {
                times
                    .iter()
                    .copied()
                    .filter(|ts| *ts > job.ask_ms && *ts <= end + MESSAGE_GRACE_MS && *ts < next_ask)
                    .collect()
            })
            .unwrap_or_default();
        let reply_at = posted.iter().copied().min().or_else(|| {
            logs.iter()
                .filter(|log| ACK_FALLBACK_STAGES.contains(&log.stage.as_str()))
                .map(|log| log.at_ms)
                .min()
        });
        if let Some(at) = reply_at {
            first_reply.push((at - job.ask_ms).max(0) as f64);
        }
        if !posted.is_empty() {
            messages_by_tool.entry(tool.clone()).or_default().push(posted.len() as f64);
        }

        if let Some(at) = plan_at {
            to_plan.push((at - job.ask_ms).max(0) as f64);
            let approved_at = logs
                .iter()
                .filter(|log| log.stage == APPROVED_STAGE && log.at_ms >= at)
                .map(|log| log.at_ms)
                .min();
            if let Some(approved) = approved_at {
                approval_wait.push((approved - at) as f64);
            }
        }

        if job.tool == "IMPLEMENTATION" && plan_at.is_some() {
            // Some approval stages are logged on every poll: count each answer once.
            let distinct: HashSet<(String, String)> = logs
                .iter()
                .filter(|log| INTERVENTION_STAGES.contains(&log.stage.as_str()))
                .map(|log| answer_key(log))
                .collect();
            interventions_per_run.push(distinct.len() as f64);
        }

        let Some(pr_url) = job.pr_url.as_deref() else {
            continue;
        };
        if job.tool != "IMPLEMENTATION" || job.status != "SUCCESS" {
            continue;
        }
        let pr_at = job_end_ms(job, logs);
        to_pr.push((pr_at - job.ask_ms).max(0) as f64);
        let Some(&merged_at) = merged.get(&normalize_pr_url(pr_url)) else {
            continue;
        };
        if merged_at > until_ms {
            continue;
        }
        to_merge.push((merged_at - job.ask_ms).max(0) as f64);
        if let Some(repo) = repo_of_pr(pr_url) {
            let live = deploys
                .iter()
                .filter(|(deployed_repo, at)| *deployed_repo == repo && *at >= merged_at && *at <= until_ms)
                .map(|(_, at)| *at)
                .min();
            if let Some(at) = live {
                to_prod.push((at - job.ask_ms).max(0) as f64);
            }
        }
    }

    let total_interventions: f64 = interventions_per_run.iter().sum();
    let change_runs = interventions_per_run.len() as i64;
    let mut by_tool_rows: Vec<CountRow> = by_tool
        .into_iter()
        .map(|(key, count)| CountRow {
            label: key.clone(),
            key,
            count,
        })
        .collect();
    by_tool_rows.sort_by(|a, b| b.count.cmp(&a.count).then(a.key.cmp(&b.key)));
    let mut by_channel_rows: Vec<CountRow> = by_channel
        .into_iter()
        .map(|(key, count)| CountRow {
            label: input.channel_names.get(&key).cloned().unwrap_or_else(|| key.clone()),
            key,
            count,
        })
        .collect();
    by_channel_rows.sort_by(|a, b| b.count.cmp(&a.count).then(a.key.cmp(&b.key)));
    let mut outcome_rows: Vec<ToolOutcomes> = outcomes.into_values().collect();
    outcome_rows.sort_by(|a, b| b.jobs.cmp(&a.jobs).then(a.tool.cmp(&b.tool)));
    let mut message_rows: Vec<ToolMessages> = messages_by_tool
        .into_iter()
        .map(|(tool, counts)| ToolMessages {
            runs: counts.len() as i64,
            mean: counts.iter().sum::<f64>() / counts.len() as f64,
            median: percentile(&counts, 50.0).unwrap_or(0.0),
            tool,
        })
        .collect();
    message_rows.sort_by(|a, b| b.runs.cmp(&a.runs).then(a.tool.cmp(&b.tool)));

    UxWindow {
        since_iso: iso(since),
        until_iso: iso(until),
        jobs: in_window.len() as i64,
        steps: vec![
            step("firstReply", "First reply", first_reply),
            step("plan", "Plan posted", to_plan),
            step("approval", "Waiting for approval (from the plan)", approval_wait),
            step("pr", "PR opened (includes the approval wait)", to_pr),
            step("merge", "Merged by miniOG", to_merge),
            step("prod", "Live in production", to_prod),
        ],
        interventions: InterventionStats {
            change_runs,
            total: total_interventions as i64,
            mean_per_run: if change_runs > 0 {
                Some(total_interventions / change_runs as f64)
            } else {
                None
            },
            median_per_run: percentile(&interventions_per_run, 50.0),
        },
        messages: message_rows,
        outcomes: outcome_rows,
        by_tool: by_tool_rows,
        by_channel: by_channel_rows,
    }
}

/// The two windows: the 7 days up to `until`, and the 7 days before that.
pub(crate) fn compute(input: &MetricsInput, until: DateTime<Utc>) -> UxMetrics {
    let week = Duration::days(WEEK_DAYS);
    UxMetrics {
        until_iso: iso(until),
        current: window(input, until - week, until),
        previous: window(input, until - week - week, until - week),
    }
}

fn table_exists(connection: &Connection, name: &str) -> bool {
    connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
            params![name],
            |_| Ok(()),
        )
        .is_ok()
}

type JobSqlRow = (
    String,
    String,
    Option<String>,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    String,
    String,
);

/// Reads what `compute` needs for the 14 days before `until`.
pub(crate) fn load(connection: &Connection, until: DateTime<Utc>) -> Result<MetricsInput, String> {
    let since = iso(until - Duration::days(WEEK_DAYS * 2));
    let until_iso = iso(until);
    let mut input = MetricsInput::default();

    let mut stmt = connection
        .prepare(
            "SELECT id, workflow, executed_workflow, status, channel_id, thread_ts, payload_json,
                    result_json, created_at, updated_at
             FROM jobs WHERE created_at >= ? AND created_at < ?",
        )
        .map_err(|err| format!("db prepare ux jobs failed: {err}"))?;
    let rows = stmt
        .query_map(params![since, until_iso], |row| -> rusqlite::Result<JobSqlRow> {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
                row.get(7)?,
                row.get(8)?,
                row.get(9)?,
            ))
        })
        .map_err(|err| format!("db query ux jobs failed: {err}"))?;
    for row in rows {
        let (id, workflow, executed, status, channel_id, thread_ts, payload, result, created, updated) =
            row.map_err(|err| format!("db row ux jobs failed: {err}"))?;
        let Some(created_ms) = parse_iso_ms(&created) else {
            continue;
        };
        let end_ms = parse_iso_ms(&updated).unwrap_or(created_ms);
        let payload: Option<Value> = payload.as_deref().and_then(|text| serde_json::from_str(text).ok());
        // The Slack message's own time. A catch-up or restart replay keeps the
        // original message's time, so its numbers include the wait the asker
        // really had. An ask from the app (a Launchpad request or a re-run of
        // an old message) is measured from the job's creation instead, and a
        // time after the creation can only be clock skew.
        let from_app = payload
            .as_ref()
            .and_then(|p| p.get("ingestSource"))
            .and_then(Value::as_str)
            == Some("launchpad");
        let ask_ms = payload
            .as_ref()
            .filter(|_| !from_app)
            .and_then(|p| p.get("eventTs"))
            .and_then(Value::as_str)
            .and_then(slack_ts_ms)
            .filter(|ask| *ask <= created_ms)
            .unwrap_or(created_ms);
        let result: Option<Value> = result.as_deref().and_then(|text| serde_json::from_str(text).ok());
        let pr_url = result
            .as_ref()
            .and_then(|r| r.get("prUrl"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let tool = executed.filter(|value| !value.trim().is_empty()).unwrap_or(workflow);
        input.jobs.push(JobRow {
            id,
            tool,
            status,
            channel_id,
            thread_ts,
            ask_ms,
            created_ms,
            end_ms,
            pr_url,
        });
    }

    let stages = wanted_stages();
    let placeholders = vec!["?"; stages.len()].join(", ");
    let sql = format!(
        "SELECT job_id, stage, message, data_json, created_at FROM job_logs
         WHERE job_id IN (SELECT id FROM jobs WHERE created_at >= ? AND created_at < ?)
           AND (stage IN ({placeholders}) OR stage LIKE '{QUICK_ACTION_PREFIX}%')"
    );
    let mut stmt = connection
        .prepare(&sql)
        .map_err(|err| format!("db prepare ux logs failed: {err}"))?;
    let mut values: Vec<&dyn rusqlite::ToSql> = vec![&since, &until_iso];
    for stage in &stages {
        values.push(stage);
    }
    let rows = stmt
        .query_map(values.as_slice(), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .map_err(|err| format!("db query ux logs failed: {err}"))?;
    for row in rows {
        let (job_id, stage, message, data, created) = row.map_err(|err| format!("db row ux logs failed: {err}"))?;
        let Some(at_ms) = parse_iso_ms(&created) else {
            continue;
        };
        input.logs.push(LogRow {
            job_id,
            stage,
            message,
            data: data.as_deref().and_then(|text| serde_json::from_str(text).ok()),
            at_ms,
        });
    }

    // Captured threads are written by the sidecar; a fresh install may not
    // have the tables yet, which only leaves the reply times to the logs.
    if table_exists(connection, "conversation_messages") {
        let bot_user_id: String = connection
            .query_row("SELECT bot_user_id FROM app_settings WHERE id = 1", [], |row| row.get(0))
            .unwrap_or_default();
        let bot_user_id = bot_user_id.trim().to_string();
        let author = if bot_user_id.is_empty() {
            "m.is_bot = 1 AND ?3 = ''"
        } else {
            "m.user_id = ?3"
        };
        let sql = format!(
            "SELECT m.channel_id, m.thread_ts, m.message_ts FROM conversation_messages m
             JOIN (SELECT DISTINCT channel_id, thread_ts FROM jobs WHERE created_at >= ?1 AND created_at < ?2) j
               ON m.channel_id = j.channel_id AND m.thread_ts = j.thread_ts
             WHERE m.deleted = 0 AND {author}"
        );
        let mut stmt = connection
            .prepare(&sql)
            .map_err(|err| format!("db prepare ux messages failed: {err}"))?;
        let rows = stmt
            .query_map(params![since, until_iso, bot_user_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|err| format!("db query ux messages failed: {err}"))?;
        for row in rows {
            let (channel_id, thread_ts, message_ts) =
                row.map_err(|err| format!("db row ux messages failed: {err}"))?;
            if let Some(ts_ms) = slack_ts_ms(&message_ts) {
                input.bot_messages.push(BotMessage {
                    channel_id,
                    thread_ts,
                    ts_ms,
                });
            }
        }
    }

    if table_exists(connection, "conversation_threads") {
        let mut stmt = connection
            .prepare(
                "SELECT channel_id, MAX(channel_name) FROM conversation_threads
                 WHERE channel_name IS NOT NULL AND channel_name != ''
                 GROUP BY channel_id",
            )
            .map_err(|err| format!("db prepare ux channels failed: {err}"))?;
        let rows = stmt
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
            .map_err(|err| format!("db query ux channels failed: {err}"))?;
        for (channel_id, name) in rows.flatten() {
            input.channel_names.insert(channel_id, name);
        }
    }

    Ok(input)
}

pub(crate) fn ux_metrics(connection: &Connection, until: DateTime<Utc>) -> Result<UxMetrics, String> {
    let input = load(connection, until)?;
    Ok(compute(&input, until))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const HOUR: i64 = 3_600_000;
    const MIN: i64 = 60_000;

    fn until() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-10-26T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    fn at(offset_ms: i64) -> i64 {
        until().timestamp_millis() + offset_ms
    }

    fn job(id: &str, tool: &str, status: &str, ask: i64, end: i64) -> JobRow {
        JobRow {
            id: id.to_string(),
            tool: tool.to_string(),
            status: status.to_string(),
            channel_id: "C1".to_string(),
            thread_ts: format!("{}.000100", ask / 1000),
            ask_ms: ask,
            created_ms: ask + 1_000,
            end_ms: end,
            pr_url: None,
        }
    }

    fn log(job_id: &str, stage: &str, at_ms: i64, data: Option<Value>) -> LogRow {
        LogRow {
            job_id: job_id.to_string(),
            stage: stage.to_string(),
            message: format!("{stage} message"),
            data,
            at_ms,
        }
    }

    fn answer(job_id: &str, stage: &str, at_ms: i64, user: &str, quote: &str) -> LogRow {
        let verb = if stage == APPROVED_STAGE {
            "approved the plan"
        } else {
            "confirmed the plan is what they want"
        };
        LogRow {
            job_id: job_id.to_string(),
            stage: stage.to_string(),
            message: format!("<@{user}> {verb}: \"{quote}\""),
            data: None,
            at_ms,
        }
    }

    fn bot(job: &JobRow, ts_ms: i64) -> BotMessage {
        BotMessage {
            channel_id: job.channel_id.clone(),
            thread_ts: job.thread_ts.clone(),
            ts_ms,
        }
    }

    fn step_of<'a>(window: &'a UxWindow, key: &str) -> &'a StepTiming {
        window.steps.iter().find(|s| s.key == key).unwrap()
    }

    #[test]
    fn percentile_interpolates_and_handles_empty() {
        assert_eq!(percentile(&[], 50.0), None);
        assert_eq!(percentile(&[5.0], 90.0), Some(5.0));
        assert_eq!(percentile(&[1.0, 2.0, 3.0, 4.0], 50.0), Some(2.5));
        assert_eq!(percentile(&[10.0, 1.0, 5.0], 50.0), Some(5.0));
        let p90 = percentile(&[1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0], 90.0).unwrap();
        assert!((p90 - 9.1).abs() < 1e-9);
    }

    #[test]
    fn slack_ts_and_iso_parse() {
        assert_eq!(slack_ts_ms("1792960235.697979"), Some(1_792_960_235_698));
        assert_eq!(slack_ts_ms("nope"), None);
        assert_eq!(
            parse_iso_ms("2026-10-26T00:00:00.000Z"),
            Some(until().timestamp_millis())
        );
    }

    #[test]
    fn change_run_reaches_every_step_from_the_ask() {
        let ask = at(-2 * HOUR);
        let mut run = job("run", "IMPLEMENTATION", "SUCCESS", ask, ask + 30 * MIN);
        run.pr_url = Some("https://github.com/Org/newton-marketing-web/pull/12".to_string());
        let merge = job("merge", "IMPLEMENTATION", "SUCCESS", ask + 40 * MIN, ask + 41 * MIN);
        let deploy = job("deploy", "DEPLOY", "SUCCESS", ask + 50 * MIN, ask + 55 * MIN);
        let input = MetricsInput {
            bot_messages: vec![
                bot(&run, ask + 5_000),
                bot(&run, ask + 3 * MIN),
                bot(&run, ask + 30 * MIN),
            ],
            logs: vec![
                log("run", "plan.detail.posted", ask + 2 * MIN, None),
                log("run", "implementation.approval.waiting", ask + 2 * MIN + 500, None),
                answer("run", APPROVED_STAGE, ask + 4 * MIN, "U1", "yes"),
                answer("run", APPROVED_STAGE, ask + 4 * MIN + 1, "U1", "yes"),
                answer("run", REQUESTER_CONFIRMED_STAGE, ask + 4 * MIN, "U1", "yes"),
                log("run", RESULT_STAGE, ask + 30 * MIN, None),
                log(
                    "merge",
                    CONTENT_MERGE_STAGE,
                    ask + 40 * MIN,
                    Some(json!({"prUrl": "https://github.com/Org/newton-marketing-web/pull/12/"})),
                ),
                log(
                    "deploy",
                    MARKETING_DEPLOY_DONE,
                    ask + 55 * MIN,
                    Some(json!({"conclusion": "success"})),
                ),
            ],
            jobs: vec![run, merge, deploy],
            ..Default::default()
        };
        let metrics = compute(&input, until());
        let current = &metrics.current;
        assert_eq!(step_of(current, "firstReply").median_ms, Some(5_000.0));
        assert_eq!(step_of(current, "plan").median_ms, Some((2 * MIN) as f64));
        assert_eq!(step_of(current, "approval").median_ms, Some((2 * MIN) as f64));
        assert_eq!(step_of(current, "pr").median_ms, Some((30 * MIN) as f64));
        assert_eq!(step_of(current, "merge").median_ms, Some((40 * MIN) as f64));
        assert_eq!(step_of(current, "prod").median_ms, Some((55 * MIN) as f64));
        // The repeated approval log and the requester's confirmation of the
        // same reply are one answer.
        assert_eq!(current.interventions.change_runs, 1);
        assert_eq!(current.interventions.total, 1);
        // The merge posted no plan: it is a quick action, not a change run.
        assert!(current.by_tool.iter().any(|row| row.key == QUICK_ACTION_TOOL));
        let impl_messages = current
            .messages
            .iter()
            .find(|m| m.tool == "IMPLEMENTATION")
            .unwrap();
        assert_eq!(impl_messages.runs, 1);
        assert_eq!(impl_messages.mean, 3.0);
        assert_eq!(current.jobs, 3);
        assert_eq!(metrics.previous.jobs, 0);
    }

    #[test]
    fn an_admin_approval_and_a_requester_confirmation_are_two_answers() {
        let ask = at(-4 * HOUR);
        let run = job("run", "IMPLEMENTATION", "SUCCESS", ask, ask + 20 * MIN);
        let input = MetricsInput {
            logs: vec![
                log("run", "plan.detail.posted", ask + MIN, None),
                answer("run", APPROVED_STAGE, ask + 3 * MIN, "UADMIN", "go"),
                answer("run", REQUESTER_CONFIRMED_STAGE, ask + 9 * MIN, "UASKER", "yes please"),
                log("run", "pipeline.approval.feedback", ask + 2 * MIN, None),
            ],
            jobs: vec![run],
            ..Default::default()
        };
        let metrics = compute(&input, until());
        assert_eq!(metrics.current.interventions.total, 3);
        assert_eq!(
            step_of(&metrics.current, "approval").median_ms,
            Some((2 * MIN) as f64),
            "the wait ends at the first approval"
        );
    }

    #[test]
    fn answer_of_reads_who_and_what() {
        assert_eq!(answer_of("<@U087> approved the plan: \"yes\""), Some(("U087", "yes")));
        assert_eq!(
            answer_of("<@U1|asha> confirmed the plan is what they want: \"ok \"go\"\""),
            Some(("U1", "ok \"go\""))
        );
        assert_eq!(answer_of("Approved by the owner"), None);
    }

    #[test]
    fn a_job_stops_claiming_messages_at_the_next_ask_in_its_thread() {
        let ask = at(-6 * HOUR);
        let first = job("first", "INFORMATIONAL", "SUCCESS", ask, ask + 10 * MIN);
        let mut follow_up = job("next", "INFORMATIONAL", "SUCCESS", ask + 2 * MIN, ask + 4 * MIN);
        follow_up.thread_ts = first.thread_ts.clone();
        let input = MetricsInput {
            bot_messages: vec![bot(&first, ask + 30_000), bot(&first, ask + 3 * MIN)],
            jobs: vec![first, follow_up],
            ..Default::default()
        };
        let metrics = compute(&input, until());
        let lookups = metrics
            .current
            .messages
            .iter()
            .find(|m| m.tool == "INFORMATIONAL")
            .unwrap();
        assert_eq!(lookups.runs, 2, "each job claims one message");
        assert_eq!(lookups.mean, 1.0);
        let reply = step_of(&metrics.current, "firstReply");
        assert_eq!(reply.count, 2);
        assert_eq!(reply.median_ms, Some((30_000 + 60_000) as f64 / 2.0));
    }

    #[test]
    fn quick_actions_are_counted_apart_from_change_runs() {
        let ask = at(-HOUR);
        let close = job("close", "IMPLEMENTATION", "SUCCESS", ask, ask + MIN);
        let input = MetricsInput {
            logs: vec![log(
                "close",
                "implementation.quick_action.no_planner",
                ask + 1_000,
                None,
            )],
            jobs: vec![close],
            ..Default::default()
        };
        let metrics = compute(&input, until());
        assert_eq!(metrics.current.by_tool[0].key, QUICK_ACTION_TOOL);
        assert_eq!(metrics.current.outcomes[0].tool, QUICK_ACTION_TOOL);
        assert_eq!(metrics.current.interventions.change_runs, 0);
    }

    #[test]
    fn failed_merges_and_deploys_before_the_merge_do_not_count() {
        let ask = at(-5 * HOUR);
        let mut run = job("run", "IMPLEMENTATION", "SUCCESS", ask, ask + 10 * MIN);
        run.pr_url = Some("https://github.com/Org/newton-web/pull/7".to_string());
        let failed_merge = job("m1", "IMPLEMENTATION", "FAILED", ask + 20 * MIN, ask + 21 * MIN);
        let input = MetricsInput {
            logs: vec![
                log("run", RESULT_STAGE, ask + 10 * MIN, None),
                log(
                    "m1",
                    PR_ACTION_STAGE,
                    ask + 20 * MIN,
                    Some(json!({"action": "merge", "prUrls": ["https://github.com/Org/newton-web/pull/7"]})),
                ),
                log("dep", WEB_DEPLOY_DONE, ask + 5 * MIN, Some(json!({"ok": true}))),
            ],
            jobs: vec![run, failed_merge],
            ..Default::default()
        };
        let metrics = compute(&input, until());
        let merge = step_of(&metrics.current, "merge");
        assert_eq!(merge.count, 0);
        assert_eq!(merge.median_ms, None);
        let outcome = |tool: &str| {
            metrics
                .current
                .outcomes
                .iter()
                .find(|o| o.tool == tool)
                .cloned()
                .unwrap()
        };
        assert_eq!((outcome("IMPLEMENTATION").jobs, outcome("IMPLEMENTATION").failed), (1, 0));
        assert_eq!((outcome(QUICK_ACTION_TOOL).jobs, outcome(QUICK_ACTION_TOOL).failed), (1, 1));
    }

    #[test]
    fn agent_merge_counts_at_the_end_of_its_job_and_close_does_not() {
        let ask = at(-3 * HOUR);
        let mut run = job("run", "IMPLEMENTATION", "SUCCESS", ask, ask + 10 * MIN);
        run.pr_url = Some("https://github.com/Org/newton-web/pull/9".to_string());
        let close = job("c", "IMPLEMENTATION", "SUCCESS", ask + 15 * MIN, ask + 16 * MIN);
        let merge = job("m", "IMPLEMENTATION", "SUCCESS", ask + 20 * MIN, ask + 24 * MIN);
        let pr = "https://github.com/Org/newton-web/pull/9";
        let input = MetricsInput {
            logs: vec![
                log("run", RESULT_STAGE, ask + 10 * MIN, None),
                log("c", PR_ACTION_STAGE, ask + 15 * MIN, Some(json!({"action": "close", "prUrls": [pr]}))),
                log("m", PR_ACTION_STAGE, ask + 20 * MIN, Some(json!({"action": "merge", "prUrls": [pr]}))),
                log("m", RESULT_STAGE, ask + 24 * MIN, None),
                log("dep", WEB_DEPLOY_DONE, ask + 30 * MIN, Some(json!({"ok": false}))),
            ],
            jobs: vec![run, close, merge],
            ..Default::default()
        };
        let metrics = compute(&input, until());
        assert_eq!(step_of(&metrics.current, "merge").median_ms, Some((24 * MIN) as f64));
        assert_eq!(step_of(&metrics.current, "prod").count, 0, "a failed deploy is not live");
    }

    #[test]
    fn first_reply_falls_back_to_logs_and_ignores_messages_outside_the_job() {
        let ask = at(-HOUR);
        let lookup = job("l", "INFORMATIONAL", "SUCCESS", ask, ask + 2 * MIN);
        let silent = job("s", "NONE", "SKIPPED", ask + 10 * MIN, ask + 10 * MIN);
        let input = MetricsInput {
            bot_messages: vec![bot(&lookup, ask - 10 * MIN), bot(&lookup, ask + 90 * MIN)],
            logs: vec![log("l", "job.acknowledged", ask + 2_000, None)],
            jobs: vec![lookup, silent],
            ..Default::default()
        };
        let metrics = compute(&input, until());
        let reply = step_of(&metrics.current, "firstReply");
        assert_eq!(reply.count, 1);
        assert_eq!(reply.median_ms, Some(2_000.0));
        assert!(
            metrics.current.messages.is_empty(),
            "no message fell inside the job's window"
        );
        assert_eq!(metrics.current.by_tool.len(), 2);
    }

    #[test]
    fn windows_split_at_seven_days_and_label_channels() {
        let recent = job("a", "PR_REVIEW", "SUCCESS", at(-2 * 24 * HOUR), at(-2 * 24 * HOUR + MIN));
        let mut older = job("b", "PR_REVIEW", "CANCELLED", at(-9 * 24 * HOUR), at(-9 * 24 * HOUR + MIN));
        older.channel_id = "C2".to_string();
        let mut names = HashMap::new();
        names.insert("C1".to_string(), "development".to_string());
        let input = MetricsInput {
            jobs: vec![recent, older],
            channel_names: names,
            ..Default::default()
        };
        let metrics = compute(&input, until());
        assert_eq!(metrics.current.jobs, 1);
        assert_eq!(metrics.previous.jobs, 1);
        assert_eq!(metrics.current.by_channel[0].label, "development");
        assert_eq!(metrics.previous.by_channel[0].label, "C2");
        assert_eq!(metrics.previous.outcomes[0].cancelled, 1);
        assert_eq!(metrics.current.interventions.mean_per_run, None);
    }

    #[test]
    fn load_reads_jobs_logs_messages_and_channel_names() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE jobs (id TEXT PRIMARY KEY, event_id TEXT, dedupe_key TEXT, workflow TEXT NOT NULL,
                   status TEXT NOT NULL, channel_id TEXT NOT NULL, thread_ts TEXT NOT NULL, payload_json TEXT,
                   result_json TEXT, error_message TEXT, attempts INTEGER, created_at TEXT NOT NULL,
                   updated_at TEXT NOT NULL, executed_workflow TEXT);
                 CREATE TABLE job_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, level TEXT,
                   stage TEXT NOT NULL, message TEXT NOT NULL, data_json TEXT, created_at TEXT NOT NULL);
                 CREATE TABLE app_settings (id INTEGER PRIMARY KEY, bot_user_id TEXT);
                 CREATE TABLE conversation_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id INTEGER,
                   channel_id TEXT NOT NULL, thread_ts TEXT NOT NULL, message_ts TEXT NOT NULL,
                   user_id TEXT NOT NULL DEFAULT '', is_bot INTEGER NOT NULL DEFAULT 0,
                   text TEXT NOT NULL DEFAULT '', deleted INTEGER NOT NULL DEFAULT 0);
                 CREATE TABLE conversation_threads (id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id TEXT NOT NULL,
                   thread_ts TEXT NOT NULL, channel_name TEXT);
                 INSERT INTO app_settings (id, bot_user_id) VALUES (1, 'UBOT');
                 INSERT INTO jobs VALUES ('j1', 'e', 'd', 'OWNER_AUTOPILOT', 'SUCCESS', 'C1', '1792900000.000100',
                   '{\"eventTs\":\"1792900000.000100\"}', '{\"prUrl\":\"https://github.com/Org/newton-web/pull/3\"}',
                   NULL, 1, '2026-10-25T03:46:41.000Z', '2026-10-25T04:00:00.000Z', 'IMPLEMENTATION');
                 INSERT INTO job_logs (job_id, level, stage, message, data_json, created_at) VALUES
                   ('j1', 'INFO', 'plan.detail.posted', 'plan', NULL, '2026-10-25T03:50:00.000Z'),
                   ('j1', 'INFO', 'agent.message', 'ignored', NULL, '2026-10-25T03:51:00.000Z'),
                   ('j1', 'INFO', 'job.attempt.result', 'done', NULL, '2026-10-25T04:00:00.000Z');
                 INSERT INTO conversation_messages (channel_id, thread_ts, message_ts, user_id, is_bot) VALUES
                   ('C1', '1792900000.000100', '1792900003.000000', 'UBOT', 1),
                   ('C1', '1792900000.000100', '1792900004.000000', 'UOTHERBOT', 1),
                   ('C1', '1792900000.000100', '1792900005.000000', 'UPERSON', 0);
                 INSERT INTO conversation_threads (channel_id, thread_ts, channel_name) VALUES ('C1', 'x', 'testing');",
            )
            .unwrap();
        let until = DateTime::parse_from_rfc3339("2026-10-26T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let input = load(&connection, until).unwrap();
        assert_eq!(input.jobs.len(), 1);
        assert_eq!(input.jobs[0].tool, "IMPLEMENTATION");
        assert_eq!(input.jobs[0].ask_ms, 1_792_900_000_000);
        assert_eq!(input.logs.len(), 2, "only the stages the metrics use are read");
        assert_eq!(input.bot_messages.len(), 1, "only miniOG's own messages count");
        assert_eq!(
            input.channel_names.get("C1").map(String::as_str),
            Some("testing")
        );
        let metrics = compute(&input, until);
        assert_eq!(step_of(&metrics.current, "firstReply").median_ms, Some(3_000.0));
        assert_eq!(step_of(&metrics.current, "pr").count, 1);
    }

    /// Prints the metrics for a real job store, opened read-only:
    /// `UX_METRICS_DB=/path/to/watchtower.db cargo test --lib ux_metrics::tests::live_snapshot -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_snapshot() {
        let Ok(path) = std::env::var("UX_METRICS_DB") else {
            return;
        };
        let connection =
            Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let metrics = ux_metrics(&connection, Utc::now()).unwrap();
        println!("{}", serde_json::to_string_pretty(&metrics).unwrap());
    }

    #[test]
    fn load_measures_app_asks_from_the_job_and_reads_quick_action_stages() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE jobs (id TEXT PRIMARY KEY, workflow TEXT NOT NULL, status TEXT NOT NULL,
                   channel_id TEXT NOT NULL, thread_ts TEXT NOT NULL, payload_json TEXT, result_json TEXT,
                   created_at TEXT NOT NULL, updated_at TEXT NOT NULL, executed_workflow TEXT);
                 CREATE TABLE job_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL,
                   stage TEXT NOT NULL, message TEXT NOT NULL, data_json TEXT, created_at TEXT NOT NULL);
                 INSERT INTO jobs VALUES ('app', 'IMPLEMENTATION', 'SUCCESS', 'C1', '1792000000.000100',
                   '{\"eventTs\":\"1792000000.000100\",\"ingestSource\":\"launchpad\"}', NULL,
                   '2026-10-25T03:46:41.000Z', '2026-10-25T04:00:00.000Z', NULL);
                 INSERT INTO jobs VALUES ('replay', 'INFORMATIONAL', 'SUCCESS', 'C1', '1792895000.000100',
                   '{\"eventTs\":\"1792895000.000100\",\"ingestSource\":\"socket\"}', NULL,
                   '2026-10-25T03:46:41.000Z', '2026-10-25T04:00:00.000Z', NULL);
                 INSERT INTO job_logs (job_id, stage, message, data_json, created_at) VALUES
                   ('app', 'implementation.quick_action.no_planner', 'close', NULL, '2026-10-25T03:47:00.000Z');",
            )
            .unwrap();
        let input = load(&connection, until()).unwrap();
        let app = input.jobs.iter().find(|job| job.id == "app").unwrap();
        assert_eq!(app.ask_ms, app.created_ms, "an app ask is measured from the job");
        let replay = input.jobs.iter().find(|job| job.id == "replay").unwrap();
        assert_eq!(replay.ask_ms, 1_792_895_000_000, "a replay keeps the message's own time");
        assert_eq!(input.logs.len(), 1);
        let metrics = compute(&input, until());
        assert!(metrics.current.by_tool.iter().any(|row| row.key == QUICK_ACTION_TOOL));
    }

    #[test]
    fn load_without_captured_threads_or_settings_still_works() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE jobs (id TEXT PRIMARY KEY, workflow TEXT NOT NULL, status TEXT NOT NULL,
                   channel_id TEXT NOT NULL, thread_ts TEXT NOT NULL, payload_json TEXT, result_json TEXT,
                   created_at TEXT NOT NULL, updated_at TEXT NOT NULL, executed_workflow TEXT);
                 CREATE TABLE job_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL,
                   stage TEXT NOT NULL, message TEXT NOT NULL, data_json TEXT, created_at TEXT NOT NULL);",
            )
            .unwrap();
        let metrics = ux_metrics(&connection, until()).unwrap();
        assert_eq!(metrics.current.jobs, 0);
        assert!(metrics
            .current
            .steps
            .iter()
            .all(|s| s.count == 0 && s.median_ms.is_none()));
    }
}
