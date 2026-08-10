use std::{
    collections::{BTreeMap, VecDeque},
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use base64::Engine as _;
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{
    async_runtime::spawn,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State,
};
use tauri_plugin_autostart::MacosLauncher;
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
    sync::RwLock,
};
use uuid::Uuid;

const TRAY_ID: &str = "watchtower-tray";
const TRAY_REFRESH_INTERVAL: Duration = Duration::from_secs(5);
const NOTIFICATION_AUDIO_DIR: &str = "notification-audio";
const NOTIFICATION_AUDIO_MAX_BYTES: usize = 10 * 1024 * 1024;
const DEFAULT_NOTIFICATION_AUDIO_SOUND: &str = "glass";
const NOTIFICATION_AUDIO_EXTENSIONS: &[&str] = &["aiff", "aif", "wav", "mp3", "m4a", "caf"];
const BUILTIN_NOTIFICATION_SOUNDS: &[(&str, &str)] = &[
    ("basso", "Basso.aiff"),
    ("glass", "Glass.aiff"),
    ("hero", "Hero.aiff"),
    ("ping", "Ping.aiff"),
    ("pop", "Pop.aiff"),
    ("purr", "Purr.aiff"),
    ("sosumi", "Sosumi.aiff"),
    ("submarine", "Submarine.aiff"),
    ("tink", "Tink.aiff"),
];

#[derive(Clone, Default)]
struct SupervisorStatus {
    state: Arc<RwLock<String>>,
}

impl SupervisorStatus {
    async fn set(&self, value: impl Into<String>) {
        let mut state = self.state.write().await;
        *state = value.into();
    }

    async fn get(&self) -> String {
        self.state.read().await.clone()
    }
}

#[derive(Clone, Default)]
struct SupervisorControl {
    shutdown_requested: Arc<AtomicBool>,
    sidecar_pid: Arc<Mutex<Option<u32>>>,
    restart_requested: Arc<AtomicBool>,
}

impl SupervisorControl {
    fn request_shutdown(&self) {
        self.shutdown_requested.store(true, Ordering::SeqCst);
    }

    fn is_shutdown_requested(&self) -> bool {
        self.shutdown_requested.load(Ordering::SeqCst)
    }

    /// Signal an intentional restart (e.g. after a settings save). The
    /// supervisor loop consumes this flag after the sidecar exits and skips
    /// crash-window accounting + backoff, so a settings save is not confused
    /// with a crash.
    fn request_restart(&self) {
        self.restart_requested.store(true, Ordering::SeqCst);
    }

    fn consume_restart_request(&self) -> bool {
        self.restart_requested.swap(false, Ordering::SeqCst)
    }

    fn set_sidecar_pid(&self, pid: Option<u32>) {
        if let Ok(mut guard) = self.sidecar_pid.lock() {
            *guard = pid;
        }
    }

    fn clear_sidecar_pid(&self) {
        if let Ok(mut guard) = self.sidecar_pid.lock() {
            let _ = guard.take();
        }
    }

    fn terminate_sidecar(&self) -> Result<bool, String> {
        let pid = self
            .sidecar_pid
            .lock()
            .map_err(|_| "failed to lock sidecar pid state".to_string())?
            .take();
        let Some(pid) = pid else {
            return Ok(false);
        };

        let pid_string = pid.to_string();
        let term_status = std::process::Command::new("kill")
            .arg("-TERM")
            .arg(&pid_string)
            .status()
            .map_err(|err| format!("failed to send SIGTERM to sidecar pid {pid}: {err}"))?;
        if term_status.success() {
            return Ok(true);
        }

        let kill_status = std::process::Command::new("kill")
            .arg("-KILL")
            .arg(&pid_string)
            .status()
            .map_err(|err| format!("failed to send SIGKILL to sidecar pid {pid}: {err}"))?;
        if kill_status.success() {
            return Ok(true);
        }

        Err(format!(
            "unable to terminate sidecar pid {pid} (SIGTERM status={term_status}, SIGKILL status={kill_status})"
        ))
    }
}

#[derive(Clone)]
struct AppState {
    db_path: Arc<PathBuf>,
    supervisor: SupervisorStatus,
    supervisor_control: SupervisorControl,
}

#[derive(Clone)]
struct TrayStatsSnapshot {
    active_jobs: i64,
    max_concurrent_jobs: i64,
    runs_24h: i64,
    failed_runs_24h: i64,
    success_rate_24h: f64,
    success_streak: i64,
    sidecar_status: String,
    settings_configured: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RunSummary {
    id: String,
    workflow: String,
    status: String,
    task_summary: String,
    channel_id: String,
    thread_ts: String,
    created_at: String,
    updated_at: String,
    error_message: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppNotificationPayload {
    title: String,
    body: String,
    tone: NotificationAudioTone,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum NotificationAudioTone {
    Success,
    Failure,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JobLogEntry {
    id: i64,
    job_id: String,
    level: String,
    stage: String,
    message: String,
    data_json: Option<String>,
    created_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PipelineRunData {
    id: String,
    job_id: String,
    status: String,
    steps: serde_json::Value,
    retry_loops: i64,
    total_duration_ms: Option<i64>,
    created_at: String,
    updated_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DashboardData {
    sidecar_status: String,
    settings_configured: bool,
    active_jobs: Vec<RunSummary>,
    recent_runs: Vec<RunSummary>,
    failures: Vec<RunSummary>,
    metrics: DashboardMetrics,
    learning: LearningInsights,
    recommendations: Vec<DashboardRecommendation>,
    channel_heat: Vec<ChannelHeat>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DashboardMetrics {
    runs_24h: i64,
    success_rate_24h: f64,
    failed_runs_24h: i64,
    avg_resolution_seconds_24h: i64,
    unknown_tasks_24h: i64,
    catchup_recovered_24h: i64,
    access_audit_would_deny_24h: i64,
    success_streak: i64,
    chaos_index: i64,
    cost_24h_usd: f64,
    tokens_input_24h: i64,
    tokens_output_24h: i64,
    cache_read_tokens_24h: i64,
    cache_hit_rate_24h: f64,
    avg_cost_per_run_usd: f64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AgentCallRow {
    id: i64,
    job_id: String,
    pipeline_run_id: Option<String>,
    role: Option<String>,
    backend: String,
    model: Option<String>,
    duration_ms: i64,
    input_tokens: Option<i64>,
    output_tokens: Option<i64>,
    cache_read_tokens: Option<i64>,
    cache_creation_tokens: Option<i64>,
    cost_usd: Option<f64>,
    cost_source: Option<String>,
    ok: bool,
    created_at: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct JobCostSummary {
    job_id: String,
    total_cost_usd: f64,
    total_duration_ms: i64,
    total_input_tokens: i64,
    total_output_tokens: i64,
    total_cache_read_tokens: i64,
    total_cache_creation_tokens: i64,
    call_count: i64,
    calls: Vec<AgentCallRow>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct GroupedAggregate {
    key: String,
    calls: i64,
    total_cost_usd: f64,
    total_duration_ms: i64,
    avg_cost_usd: f64,
    avg_duration_ms: f64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TopRun {
    job_id: String,
    workflow: String,
    status: String,
    started_at: String,
    duration_ms: i64,
    cost_usd: f64,
    input_tokens: i64,
    output_tokens: i64,
    call_count: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PerformanceOverview {
    since_iso: String,
    until_iso: String,
    total_cost_usd: f64,
    total_calls: i64,
    total_input_tokens: i64,
    total_output_tokens: i64,
    total_cache_read_tokens: i64,
    cache_hit_rate: f64,
    avg_cost_per_run_usd: f64,
    by_workflow: Vec<GroupedAggregate>,
    by_backend_model: Vec<GroupedAggregate>,
    top_runs: Vec<TopRun>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DashboardRecommendation {
    id: String,
    priority: String,
    title: String,
    detail: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ChannelHeat {
    channel_id: String,
    runs: i64,
    failures: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LearningInsights {
    signals_24h: i64,
    corrections_learned: i64,
    corrections_applied_24h: i64,
    personality_profiles: i64,
    dominant_personality_mode: String,
    top_failure_kind: String,
    top_failure_count: i64,
    profiles_by_mode: Vec<PersonalityModeStats>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PersonalityModeStats {
    mode: String,
    count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppSettings {
    slack_bot_token: String,
    slack_app_token: String,
    owner_slack_user_ids: String,
    bot_user_id: String,
    bugs_and_updates_channel_id: String,
    newton_web_path: String,
    newton_api_path: String,
    // Optional third repo (newton-marketing-web); blank disables it. #[serde(default)]
    // keeps payloads from older frontends deserializable.
    #[serde(default)]
    newton_marketing_web_path: String,
    max_concurrent_jobs: i64,
    pr_review_timeout_ms: i64,
    bug_fix_timeout_ms: i64,
    repo_classifier_threshold: f64,
    theme_preset: String,
    theme_background_color: String,
    theme_foreground_color: String,
    theme_accent_color: String,
    theme_font_family: String,
    success_notification_audio_mode: String,
    success_notification_audio_default_sound: String,
    success_notification_audio_custom_path: String,
    failure_notification_audio_mode: String,
    failure_notification_audio_default_sound: String,
    failure_notification_audio_custom_path: String,
    agent_backend: String,
    pm_slack_user_ids: String,
    pm_task_timeout_ms: i64,
    core_dev_slack_user_ids: String,
    core_dev_slack_user_group: String,
    vault_path: String,
    vault_enabled: bool,
    mini_og_repo_root: String,
    access_control: AccessControlSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccessGroupSettings {
    slack_user_group_handle: String,
    manual_user_ids: String,
    allowed_channel_ids: String,
    allow_im: bool,
    allow_mpim: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccessControlSettings {
    mode: String,
    groups: BTreeMap<String, AccessGroupSettings>,
}

fn access_group_keys() -> [&'static str; 5] {
    ["viewer", "reviewer", "builder", "admin", "owner"]
}

fn default_access_group_settings() -> AccessGroupSettings {
    AccessGroupSettings {
        slack_user_group_handle: String::new(),
        manual_user_ids: String::new(),
        allowed_channel_ids: String::new(),
        allow_im: false,
        allow_mpim: false,
    }
}

impl Default for AccessControlSettings {
    fn default() -> Self {
        let mut groups = BTreeMap::new();
        for key in access_group_keys() {
            groups.insert(key.to_string(), default_access_group_settings());
        }

        Self {
            mode: "audit".to_string(),
            groups,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveSettingsResponse {
    configured: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NotificationAudioUploadResponse {
    file_name: String,
    path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SubmitLaunchpadTaskResponse {
    request_id: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            slack_bot_token: String::new(),
            slack_app_token: String::new(),
            owner_slack_user_ids: String::new(),
            bot_user_id: String::new(),
            bugs_and_updates_channel_id: "C01H25RNLJH".to_string(),
            newton_web_path: String::new(),
            newton_api_path: String::new(),
            newton_marketing_web_path: String::new(),
            max_concurrent_jobs: 2,
            pr_review_timeout_ms: 1_200_000,
            bug_fix_timeout_ms: 2_700_000,
            repo_classifier_threshold: 0.75,
            theme_preset: "watchtower-midnight".to_string(),
            theme_background_color: "#06090C".to_string(),
            theme_foreground_color: "#F2F7FB".to_string(),
            theme_accent_color: "#53D2FF".to_string(),
            theme_font_family: "ibm-plex".to_string(),
            success_notification_audio_mode: "off".to_string(),
            success_notification_audio_default_sound: DEFAULT_NOTIFICATION_AUDIO_SOUND.to_string(),
            success_notification_audio_custom_path: String::new(),
            failure_notification_audio_mode: "off".to_string(),
            failure_notification_audio_default_sound: DEFAULT_NOTIFICATION_AUDIO_SOUND.to_string(),
            failure_notification_audio_custom_path: String::new(),
            agent_backend: "codex".to_string(),
            pm_slack_user_ids: String::new(),
            pm_task_timeout_ms: 600_000,
            core_dev_slack_user_ids: String::new(),
            core_dev_slack_user_group: String::new(),
            vault_path: String::new(),
            vault_enabled: false,
            mini_og_repo_root: "/Users/dipesh/code/mini-og".to_string(),
            access_control: AccessControlSettings::default(),
        }
    }
}

#[cfg(not(target_os = "macos"))]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    eprintln!("watchtower supports macOS only");
    std::process::exit(1);
}

#[cfg(target_os = "macos")]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .setup(|app| {
            let app_handle = app.handle().clone();
            let app_data_dir = app_handle
                .path()
                .app_data_dir()
                .map_err(|err| format!("failed to resolve app data dir: {err}"))?;
            std::fs::create_dir_all(&app_data_dir)
                .map_err(|err| format!("failed to create app data dir: {err}"))?;

            let db_path = app_data_dir.join("watchtower.db");
            initialize_db(&db_path).map_err(|err| format!("db init failed: {err}"))?;

            let supervisor = SupervisorStatus::default();
            let supervisor_control = SupervisorControl::default();
            let state = AppState {
                db_path: Arc::new(db_path.clone()),
                supervisor: supervisor.clone(),
                supervisor_control: supervisor_control.clone(),
            };
            app.manage(state.clone());

            setup_tray(app_handle.clone())?;

            let app_handle_for_tray = app_handle.clone();
            let tray_state = state.clone();
            spawn(async move {
                start_tray_refresh_loop(app_handle_for_tray, tray_state).await;
            });

            let app_handle_for_autostart = app_handle.clone();
            spawn(async move {
                if let Err(err) = set_autostart_enabled(&app_handle_for_autostart).await {
                    eprintln!("failed to enable launch-on-login: {err}");
                }
            });

            spawn(start_sidecar_supervisor(
                app_handle,
                db_path,
                supervisor,
                supervisor_control,
            ));

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_dashboard_data,
            get_job_logs,
            get_pipeline_run,
            get_app_settings,
            save_app_settings,
            submit_launchpad_task,
            import_notification_audio,
            emit_preview_notification,
            get_job_diff,
            create_pr_from_job,
            cancel_job,
            get_job_cost_summary,
            get_performance_overview,
            list_dossiers,
            get_dossier,
            save_dossier_field,
            forget_dossier_field,
            list_pinned_facts,
            add_pinned_fact,
            remove_pinned_fact,
            get_user_memories,
            get_bundles,
            save_bundle,
            delete_bundle
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| match event {
        tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
            shutdown_sidecar_for_exit(app_handle);
        }
        _ => {}
    });
}

#[tauri::command]
async fn get_dashboard_data(state: State<'_, AppState>) -> Result<DashboardData, String> {
    let connection =
        Connection::open(&*state.db_path).map_err(|err| format!("db open failed: {err}"))?;

    let active_jobs = query_runs(
        &connection,
        "SELECT id, COALESCE(executed_workflow, workflow) AS workflow, status, channel_id, thread_ts, created_at, updated_at, error_message, payload_json FROM jobs WHERE status = 'RUNNING' ORDER BY updated_at DESC LIMIT 50",
    )?;
    let recent_runs = query_runs(
        &connection,
        "SELECT id, COALESCE(executed_workflow, workflow) AS workflow, status, channel_id, thread_ts, created_at, updated_at, error_message, payload_json FROM jobs ORDER BY updated_at DESC LIMIT 50",
    )?;
    let failures = query_runs(
        &connection,
        "SELECT id, COALESCE(executed_workflow, workflow) AS workflow, status, channel_id, thread_ts, created_at, updated_at, error_message, payload_json FROM jobs WHERE status = 'FAILED' ORDER BY updated_at DESC LIMIT 50",
    )?;
    let metrics = query_dashboard_metrics(&connection)?;
    let learning = query_learning_insights(&connection)?;
    let channel_heat = query_channel_heat(&connection)?;
    let recommendations = build_recommendations(&metrics, &channel_heat);

    let settings = read_app_settings(&connection)?;

    Ok(DashboardData {
        sidecar_status: state.supervisor.get().await,
        settings_configured: is_settings_complete(&settings),
        active_jobs,
        recent_runs,
        failures,
        metrics,
        learning,
        recommendations,
        channel_heat,
    })
}

#[tauri::command]
async fn get_app_settings(state: State<'_, AppState>) -> Result<AppSettings, String> {
    let connection =
        Connection::open(&*state.db_path).map_err(|err| format!("db open failed: {err}"))?;
    read_app_settings(&connection)
}

#[tauri::command]
async fn get_job_logs(
    job_id: String,
    limit: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Vec<JobLogEntry>, String> {
    let max_limit = i64::from(limit.unwrap_or(500)).clamp(1, 1000);
    let connection =
        Connection::open(&*state.db_path).map_err(|err| format!("db open failed: {err}"))?;

    let mut stmt = connection
        .prepare(
            "SELECT id, job_id, level, stage, message, data_json, created_at
             FROM job_logs
             WHERE job_id = ?
             ORDER BY id ASC
             LIMIT ?",
        )
        .map_err(|err| format!("db prepare job_logs failed: {err}"))?;

    let rows = stmt
        .query_map(params![job_id, max_limit], |row| {
            Ok(JobLogEntry {
                id: row.get(0)?,
                job_id: row.get(1)?,
                level: row.get(2)?,
                stage: row.get(3)?,
                message: row.get(4)?,
                data_json: row.get(5)?,
                created_at: row.get(6)?,
            })
        })
        .map_err(|err| format!("db query job_logs failed: {err}"))?;

    let mut output = Vec::new();
    for row in rows {
        output.push(row.map_err(|err| format!("db row job_logs failed: {err}"))?);
    }
    Ok(output)
}

#[tauri::command]
async fn get_pipeline_run(
    job_id: String,
    state: State<'_, AppState>,
) -> Result<Option<PipelineRunData>, String> {
    let connection =
        Connection::open(&*state.db_path).map_err(|err| format!("db open failed: {err}"))?;

    let mut stmt = connection
        .prepare(
            "SELECT id, job_id, pipeline_config_json, status, steps_json,
                    retry_loops, total_duration_ms, created_at, updated_at
             FROM agent_pipeline_runs
             WHERE job_id = ?
             ORDER BY created_at DESC
             LIMIT 1",
        )
        .map_err(|err| format!("db prepare pipeline_run failed: {err}"))?;

    let result = stmt
        .query_row(params![job_id], |row| {
            let steps_raw: String = row.get(4)?;
            let steps: serde_json::Value =
                serde_json::from_str(&steps_raw).unwrap_or(serde_json::Value::Array(vec![]));
            Ok(PipelineRunData {
                id: row.get(0)?,
                job_id: row.get(1)?,
                status: row.get(3)?,
                steps,
                retry_loops: row.get(5)?,
                total_duration_ms: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        })
        .optional()
        .map_err(|err| format!("db query pipeline_run failed: {err}"))?;

    Ok(result)
}

fn map_agent_call_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentCallRow> {
    Ok(AgentCallRow {
        id: row.get(0)?,
        job_id: row.get(1)?,
        pipeline_run_id: row.get(2)?,
        role: row.get(3)?,
        backend: row.get(4)?,
        model: row.get(5)?,
        duration_ms: row.get(6)?,
        input_tokens: row.get(7)?,
        output_tokens: row.get(8)?,
        cache_read_tokens: row.get(9)?,
        cache_creation_tokens: row.get(10)?,
        cost_usd: row.get(11)?,
        cost_source: row.get(12)?,
        ok: row.get::<_, i64>(13)? == 1,
        created_at: row.get(14)?,
    })
}

#[tauri::command]
async fn get_job_cost_summary(
    job_id: String,
    state: State<'_, AppState>,
) -> Result<JobCostSummary, String> {
    let connection =
        Connection::open(&*state.db_path).map_err(|err| format!("db open failed: {err}"))?;

    let mut stmt = connection
        .prepare(
            "SELECT id, job_id, pipeline_run_id, role, backend, model, duration_ms,
                    input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
                    cost_usd, cost_source, ok, created_at
             FROM agent_calls
             WHERE job_id = ?
             ORDER BY id ASC",
        )
        .map_err(|err| format!("db prepare agent_calls failed: {err}"))?;

    let rows = stmt
        .query_map(params![job_id], map_agent_call_row)
        .map_err(|err| format!("db query agent_calls failed: {err}"))?;

    let mut calls: Vec<AgentCallRow> = Vec::new();
    for row in rows {
        calls.push(row.map_err(|err| format!("db row agent_calls failed: {err}"))?);
    }

    let mut summary = JobCostSummary {
        job_id: job_id.clone(),
        total_cost_usd: 0.0,
        total_duration_ms: 0,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cache_read_tokens: 0,
        total_cache_creation_tokens: 0,
        call_count: calls.len() as i64,
        calls: Vec::new(),
    };
    for c in &calls {
        summary.total_cost_usd += c.cost_usd.unwrap_or(0.0);
        summary.total_duration_ms += c.duration_ms;
        summary.total_input_tokens += c.input_tokens.unwrap_or(0);
        summary.total_output_tokens += c.output_tokens.unwrap_or(0);
        summary.total_cache_read_tokens += c.cache_read_tokens.unwrap_or(0);
        summary.total_cache_creation_tokens += c.cache_creation_tokens.unwrap_or(0);
    }
    summary.calls = calls;
    Ok(summary)
}

#[tauri::command]
async fn get_performance_overview(
    since_iso: String,
    until_iso: String,
    state: State<'_, AppState>,
) -> Result<PerformanceOverview, String> {
    let connection =
        Connection::open(&*state.db_path).map_err(|err| format!("db open failed: {err}"))?;

    // Headline rollups
    let (total_cost_usd, total_calls, total_input_tokens, total_output_tokens, total_cache_read_tokens): (
        f64,
        i64,
        i64,
        i64,
        i64,
    ) = connection
        .query_row(
            "SELECT
                COALESCE(SUM(cost_usd), 0.0),
                COUNT(*),
                COALESCE(SUM(input_tokens), 0),
                COALESCE(SUM(output_tokens), 0),
                COALESCE(SUM(cache_read_tokens), 0)
             FROM agent_calls
             WHERE created_at >= ? AND created_at < ?",
            params![since_iso, until_iso],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .unwrap_or((0.0, 0, 0, 0, 0));

    let cache_denom = total_input_tokens + total_cache_read_tokens;
    let cache_hit_rate = if cache_denom > 0 {
        total_cache_read_tokens as f64 / cache_denom as f64
    } else {
        0.0
    };
    let runs_in_window: i64 = connection
        .query_row(
            "SELECT COUNT(DISTINCT job_id) FROM agent_calls WHERE created_at >= ? AND created_at < ?",
            params![since_iso, until_iso],
            |row| row.get(0),
        )
        .unwrap_or(0);
    let avg_cost_per_run_usd = if runs_in_window > 0 {
        total_cost_usd / runs_in_window as f64
    } else {
        0.0
    };

    // By workflow (joined to jobs)
    let by_workflow = {
        let mut stmt = connection
            .prepare(
                "SELECT j.workflow AS key,
                        COUNT(c.id) AS calls,
                        COALESCE(SUM(c.cost_usd), 0.0) AS total_cost,
                        COALESCE(SUM(c.duration_ms), 0) AS total_duration
                 FROM agent_calls c
                 JOIN jobs j ON j.id = c.job_id
                 WHERE c.created_at >= ? AND c.created_at < ?
                 GROUP BY j.workflow
                 ORDER BY total_cost DESC",
            )
            .map_err(|err| format!("db prepare by_workflow failed: {err}"))?;
        let rows = stmt
            .query_map(params![since_iso, until_iso], |row| {
                let key: String = row.get(0)?;
                let calls: i64 = row.get(1)?;
                let total_cost: f64 = row.get(2)?;
                let total_duration: i64 = row.get(3)?;
                Ok(GroupedAggregate {
                    key,
                    calls,
                    total_cost_usd: total_cost,
                    total_duration_ms: total_duration,
                    avg_cost_usd: if calls > 0 { total_cost / calls as f64 } else { 0.0 },
                    avg_duration_ms: if calls > 0 {
                        total_duration as f64 / calls as f64
                    } else {
                        0.0
                    },
                })
            })
            .map_err(|err| format!("db query by_workflow failed: {err}"))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|err| format!("db row by_workflow failed: {err}"))?);
        }
        out
    };

    // By backend:model
    let by_backend_model = {
        let mut stmt = connection
            .prepare(
                "SELECT (backend || ':' || COALESCE(model, 'default')) AS key,
                        COUNT(*) AS calls,
                        COALESCE(SUM(cost_usd), 0.0) AS total_cost,
                        COALESCE(SUM(duration_ms), 0) AS total_duration
                 FROM agent_calls
                 WHERE created_at >= ? AND created_at < ?
                 GROUP BY backend, model
                 ORDER BY total_cost DESC",
            )
            .map_err(|err| format!("db prepare by_backend_model failed: {err}"))?;
        let rows = stmt
            .query_map(params![since_iso, until_iso], |row| {
                let key: String = row.get(0)?;
                let calls: i64 = row.get(1)?;
                let total_cost: f64 = row.get(2)?;
                let total_duration: i64 = row.get(3)?;
                Ok(GroupedAggregate {
                    key,
                    calls,
                    total_cost_usd: total_cost,
                    total_duration_ms: total_duration,
                    avg_cost_usd: if calls > 0 { total_cost / calls as f64 } else { 0.0 },
                    avg_duration_ms: if calls > 0 {
                        total_duration as f64 / calls as f64
                    } else {
                        0.0
                    },
                })
            })
            .map_err(|err| format!("db query by_backend_model failed: {err}"))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|err| format!("db row by_backend_model failed: {err}"))?);
        }
        out
    };

    // Top runs by cost
    let top_runs = {
        let mut stmt = connection
            .prepare(
                "SELECT j.id, j.workflow, j.status, j.created_at,
                        COALESCE(SUM(c.duration_ms), 0) AS duration_ms,
                        COALESCE(SUM(c.cost_usd), 0.0) AS cost_usd,
                        COALESCE(SUM(c.input_tokens), 0) AS input_tokens,
                        COALESCE(SUM(c.output_tokens), 0) AS output_tokens,
                        COUNT(c.id) AS call_count
                 FROM agent_calls c
                 JOIN jobs j ON j.id = c.job_id
                 WHERE c.created_at >= ? AND c.created_at < ?
                 GROUP BY j.id
                 ORDER BY cost_usd DESC
                 LIMIT 25",
            )
            .map_err(|err| format!("db prepare top_runs failed: {err}"))?;
        let rows = stmt
            .query_map(params![since_iso, until_iso], |row| {
                Ok(TopRun {
                    job_id: row.get(0)?,
                    workflow: row.get(1)?,
                    status: row.get(2)?,
                    started_at: row.get(3)?,
                    duration_ms: row.get(4)?,
                    cost_usd: row.get(5)?,
                    input_tokens: row.get(6)?,
                    output_tokens: row.get(7)?,
                    call_count: row.get(8)?,
                })
            })
            .map_err(|err| format!("db query top_runs failed: {err}"))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|err| format!("db row top_runs failed: {err}"))?);
        }
        out
    };

    Ok(PerformanceOverview {
        since_iso,
        until_iso,
        total_cost_usd,
        total_calls,
        total_input_tokens,
        total_output_tokens,
        total_cache_read_tokens,
        cache_hit_rate,
        avg_cost_per_run_usd,
        by_workflow,
        by_backend_model,
        top_runs,
    })
}

#[tauri::command]
async fn save_app_settings(
    settings: AppSettings,
    state: State<'_, AppState>,
) -> Result<SaveSettingsResponse, String> {
    validate_settings_for_save(&settings)?;

    let connection =
        Connection::open(&*state.db_path).map_err(|err| format!("db open failed: {err}"))?;
    persist_app_settings(&connection, &settings)?;

    // Terminate the sidecar so the supervisor respawns it with the fresh
    // settings. Without this the sidecar keeps its in-memory config from
    // startup and never picks up access-control / Slack-token / repo-path
    // changes until the app is restarted. request_restart() tells the
    // supervisor this exit is intentional so it skips crash-loop accounting.
    // Settings are already persisted, so if termination fails we log it but
    // don't fail the save.
    state.supervisor_control.request_restart();
    match state.supervisor_control.terminate_sidecar() {
        Ok(true) => {
            state
                .supervisor
                .set("restarting to load new settings")
                .await;
        }
        Ok(false) => {
            // Sidecar isn't running yet (startup in progress or blocked on
            // incomplete settings). It will read fresh settings on next spawn.
            // Clear the flag so it doesn't apply to a later unrelated exit.
            let _ = state.supervisor_control.consume_restart_request();
        }
        Err(err) => {
            eprintln!("failed to terminate sidecar after settings save: {err}");
            let _ = state.supervisor_control.consume_restart_request();
        }
    }

    Ok(SaveSettingsResponse {
        configured: is_settings_complete(&settings),
    })
}

#[tauri::command]
async fn submit_launchpad_task(
    target: String,
    prompt: String,
    state: State<'_, AppState>,
) -> Result<SubmitLaunchpadTaskResponse, String> {
    let connection =
        Connection::open(&*state.db_path).map_err(|err| format!("db open failed: {err}"))?;
    submit_launchpad_task_inner(&connection, &target, &prompt)
}

#[tauri::command]
async fn import_notification_audio(
    file_name: String,
    data_base64: String,
    state: State<'_, AppState>,
) -> Result<NotificationAudioUploadResponse, String> {
    let cleaned_file_name = sanitize_uploaded_notification_audio_file_name(&file_name)?;
    let extension = notification_audio_extension_from_name(&cleaned_file_name)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.trim())
        .map_err(|err| format!("notification audio decode failed: {err}"))?;

    if bytes.is_empty() {
        return Err("notificationAudio file must not be empty".to_string());
    }

    if bytes.len() > NOTIFICATION_AUDIO_MAX_BYTES {
        return Err("notificationAudio file must be 10MB or smaller".to_string());
    }

    let app_data_dir = state
        .db_path
        .parent()
        .ok_or_else(|| "failed to resolve app data dir".to_string())?;
    let audio_dir = app_data_dir.join(NOTIFICATION_AUDIO_DIR);
    fs::create_dir_all(&audio_dir)
        .map_err(|err| format!("failed to prepare notification audio dir: {err}"))?;

    let stem = Path::new(&cleaned_file_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("notification-audio");
    let stored_file_name = format!(
        "{}-{}.{}",
        sanitize_notification_audio_file_stem(stem),
        Uuid::new_v4().simple(),
        extension
    );
    let stored_path = audio_dir.join(stored_file_name);

    fs::write(&stored_path, bytes)
        .map_err(|err| format!("failed to store notification audio file: {err}"))?;

    Ok(NotificationAudioUploadResponse {
        file_name: cleaned_file_name,
        path: stored_path.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
async fn emit_preview_notification(
    settings: AppSettings,
    tone: NotificationAudioTone,
    app: AppHandle,
) -> Result<(), String> {
    validate_notification_audio_profile(&settings, tone)?;
    emit_notification_with_settings(
        &app,
        match tone {
            NotificationAudioTone::Success => "Watchtower success preview",
            NotificationAudioTone::Failure => "Watchtower failure preview",
        },
        match tone {
            NotificationAudioTone::Success => {
                "Synthetic success notification for validating the in-app toast, native desktop alert, and success sound."
            }
            NotificationAudioTone::Failure => {
                "Synthetic failure notification for validating the in-app toast, native desktop alert, and failure sound."
            }
        },
        Some(&settings),
        tone,
    );
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JobDiffData {
    job_id: String,
    branch_name: String,
    repo_path: String,
    diff_text: String,
    files: serde_json::Value,
    insertions: i64,
    deletions: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreatePrResponse {
    pr_url: String,
}

#[tauri::command]
async fn get_job_diff(
    job_id: String,
    state: State<'_, AppState>,
) -> Result<Option<JobDiffData>, String> {
    let connection =
        Connection::open(&*state.db_path).map_err(|err| format!("db open failed: {err}"))?;

    let mut stmt = connection
        .prepare(
            "SELECT job_id, branch_name, repo_path, diff_text, files_json, insertions, deletions
             FROM job_diffs
             WHERE job_id = ?
             LIMIT 1",
        )
        .map_err(|err| format!("db prepare job_diffs failed: {err}"))?;

    let result = stmt
        .query_row(params![job_id], |row| {
            let files_raw: String = row.get(4)?;
            let files: serde_json::Value =
                serde_json::from_str(&files_raw).unwrap_or(serde_json::Value::Array(vec![]));
            Ok(JobDiffData {
                job_id: row.get(0)?,
                branch_name: row.get(1)?,
                repo_path: row.get(2)?,
                diff_text: row.get(3)?,
                files,
                insertions: row.get(5)?,
                deletions: row.get(6)?,
            })
        })
        .optional()
        .map_err(|err| format!("db query job_diffs failed: {err}"))?;

    Ok(result)
}

#[tauri::command]
async fn create_pr_from_job(
    job_id: String,
    title: String,
    body: String,
    state: State<'_, AppState>,
) -> Result<CreatePrResponse, String> {
    let connection =
        Connection::open(&*state.db_path).map_err(|err| format!("db open failed: {err}"))?;

    let mut stmt = connection
        .prepare(
            "SELECT branch_name, repo_path FROM job_diffs WHERE job_id = ? LIMIT 1",
        )
        .map_err(|err| format!("db prepare job_diffs failed: {err}"))?;

    let (branch_name, repo_path): (String, String) = stmt
        .query_row(params![job_id], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .map_err(|err| format!("No diff found for job {job_id}: {err}"))?;

    let output = std::process::Command::new("gh")
        .args([
            "pr", "create",
            "--title", &title,
            "--body", &body,
            "--head", &branch_name,
        ])
        .current_dir(&repo_path)
        .output()
        .map_err(|err| format!("Failed to run gh pr create: {err}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("gh pr create failed: {stderr}"));
    }

    let pr_url = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(CreatePrResponse { pr_url })
}

#[tauri::command]
async fn cancel_job(job_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let connection =
        Connection::open(&*state.db_path).map_err(|err| format!("db open failed: {err}"))?;

    // Ensure the pending_cancel_jobs table exists (safe to call multiple times)
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
            params![job_id, Utc::now().to_rfc3339()],
        )
        .map_err(|err| format!("db insert cancel request failed: {err}"))?;

    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DossierSummary {
    user_id: String,
    display_name: Option<String>,
    real_name: Option<String>,
    role: Option<String>,
    tz: Option<String>,
    updated_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DossierAffinityRow {
    repo: String,
    hits: i64,
    successes: i64,
    failures: i64,
    last_used_at: Option<String>,
    computed_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DossierMetricRow {
    metric_key: String,
    metric_value: String,
    computed_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DossierDetail {
    user_id: String,
    display_name: Option<String>,
    real_name: Option<String>,
    tz: Option<String>,
    email: Option<String>,
    role: Option<String>,
    notes: Option<String>,
    source: Option<String>,
    first_seen_at: Option<String>,
    updated_at: Option<String>,
    tone: Option<String>,
    tone_source: Option<String>,
    affinity: Vec<DossierAffinityRow>,
    metrics: Vec<DossierMetricRow>,
}

#[tauri::command]
async fn list_dossiers(state: State<'_, AppState>) -> Result<Vec<DossierSummary>, String> {
    let connection =
        Connection::open(&*state.db_path).map_err(|err| format!("db open failed: {err}"))?;
    let mut stmt = connection
        .prepare(
            "SELECT user_id, display_name, real_name, role, tz, updated_at
             FROM user_dossiers
             ORDER BY updated_at DESC
             LIMIT 500",
        )
        .map_err(|err| format!("db prepare failed: {err}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(DossierSummary {
                user_id: row.get(0)?,
                display_name: row.get(1)?,
                real_name: row.get(2)?,
                role: row.get(3)?,
                tz: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })
        .map_err(|err| format!("db query failed: {err}"))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|err| format!("db row failed: {err}"))?);
    }
    Ok(out)
}

#[tauri::command]
async fn get_dossier(user_id: String, state: State<'_, AppState>) -> Result<DossierDetail, String> {
    let connection =
        Connection::open(&*state.db_path).map_err(|err| format!("db open failed: {err}"))?;

    let profile = connection
        .query_row(
            "SELECT user_id, display_name, real_name, tz, email, role, notes, source, first_seen_at, updated_at
             FROM user_dossiers WHERE user_id = ? LIMIT 1",
            params![user_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                ))
            },
        )
        .optional()
        .map_err(|err| format!("db query failed: {err}"))?;

    let (profile_user_id, display_name, real_name, tz, email, role, notes, source, first_seen_at, updated_at) =
        match profile {
            Some(p) => (
                p.0,
                p.1,
                p.2,
                p.3,
                p.4,
                p.5,
                p.6,
                p.7,
                Some(p.8),
                Some(p.9),
            ),
            None => (
                user_id.clone(),
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
            ),
        };

    let mut affinity = Vec::new();
    {
        let mut stmt = connection
            .prepare(
                "SELECT repo, hits, successes, failures, last_used_at, computed_at
                 FROM user_project_affinity WHERE user_id = ? ORDER BY hits DESC",
            )
            .map_err(|err| format!("db prepare failed: {err}"))?;
        let rows = stmt
            .query_map(params![user_id], |row| {
                Ok(DossierAffinityRow {
                    repo: row.get(0)?,
                    hits: row.get(1)?,
                    successes: row.get(2)?,
                    failures: row.get(3)?,
                    last_used_at: row.get(4)?,
                    computed_at: row.get(5)?,
                })
            })
            .map_err(|err| format!("db query failed: {err}"))?;
        for row in rows {
            affinity.push(row.map_err(|err| format!("db row failed: {err}"))?);
        }
    }

    let mut metrics = Vec::new();
    {
        let mut stmt = connection
            .prepare(
                "SELECT metric_key, metric_value, computed_at
                 FROM user_metrics WHERE user_id = ?",
            )
            .map_err(|err| format!("db prepare failed: {err}"))?;
        let rows = stmt
            .query_map(params![user_id], |row| {
                Ok(DossierMetricRow {
                    metric_key: row.get(0)?,
                    metric_value: row.get(1)?,
                    computed_at: row.get(2)?,
                })
            })
            .map_err(|err| format!("db query failed: {err}"))?;
        for row in rows {
            metrics.push(row.map_err(|err| format!("db row failed: {err}"))?);
        }
    }

    let tone_row: Option<(String, Option<String>)> = connection
        .query_row(
            "SELECT mode, source FROM personality_profiles WHERE scope = 'user' AND scope_id = ? LIMIT 1",
            params![user_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()
        .map_err(|err| format!("db query failed: {err}"))?;

    let (tone, tone_source) = match tone_row {
        Some((mode, src)) => (Some(mode), src),
        None => (None, None),
    };

    Ok(DossierDetail {
        user_id: profile_user_id,
        display_name,
        real_name,
        tz,
        email,
        role,
        notes,
        source,
        first_seen_at,
        updated_at,
        tone,
        tone_source,
        affinity,
        metrics,
    })
}

/// Notify the sidecar that a user's dossier has been edited from the desktop.
/// The sidecar's getDossier reads `dossier_cache_signals` on every call; when
/// the row's updated_at is newer than its last-seen value the cache is
/// invalidated and a vault render is queued. Safe to call after any dossier or
/// pinned-fact mutation; failures are non-fatal because the only cost is a
/// briefly stale cache, never lost data.
fn write_dossier_cache_signal(connection: &Connection, user_id: &str) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    connection
        .execute(
            "INSERT INTO dossier_cache_signals(user_id, updated_at) VALUES(?, ?)
             ON CONFLICT(user_id) DO UPDATE SET updated_at = excluded.updated_at",
            params![user_id, now],
        )
        .map_err(|err| format!("dossier signal write failed: {err}"))?;
    Ok(())
}

#[tauri::command]
async fn save_dossier_field(
    user_id: String,
    field: String,
    value: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if field != "role" && field != "notes" {
        return Err(format!("field '{field}' is not editable"));
    }
    if field == "role" {
        if let Some(ref v) = value {
            if !matches!(v.as_str(), "pm" | "dev" | "designer" | "ops") {
                return Err(format!("role '{v}' is not allowed"));
            }
        }
    }
    let connection =
        Connection::open(&*state.db_path).map_err(|err| format!("db open failed: {err}"))?;
    let now = Utc::now().to_rfc3339();
    let sql = format!(
        "INSERT INTO user_dossiers(user_id, {field}, source, first_seen_at, updated_at)
         VALUES(?, ?, 'admin-edit', ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           {field} = excluded.{field},
           source = 'admin-edit',
           updated_at = excluded.updated_at"
    );
    connection
        .execute(&sql, params![user_id, value, now, now])
        .map_err(|err| format!("db update failed: {err}"))?;
    write_dossier_cache_signal(&connection, &user_id)?;
    Ok(())
}

#[tauri::command]
async fn forget_dossier_field(
    user_id: String,
    field: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let connection =
        Connection::open(&*state.db_path).map_err(|err| format!("db open failed: {err}"))?;
    let now = Utc::now().to_rfc3339();
    match field.as_str() {
        "role" => {
            connection
                .execute(
                    "UPDATE user_dossiers SET role = NULL, source = 'forget', updated_at = ? WHERE user_id = ?",
                    params![now, user_id],
                )
                .map_err(|err| format!("db update failed: {err}"))?;
        }
        "notes" => {
            connection
                .execute(
                    "UPDATE user_dossiers SET notes = NULL, source = 'forget', updated_at = ? WHERE user_id = ?",
                    params![now, user_id],
                )
                .map_err(|err| format!("db update failed: {err}"))?;
        }
        "tone" => {
            connection
                .execute(
                    "DELETE FROM personality_profiles WHERE scope = 'user' AND scope_id = ?",
                    params![user_id],
                )
                .map_err(|err| format!("db delete failed: {err}"))?;
        }
        "project_affinity" => {
            connection
                .execute(
                    "DELETE FROM user_project_affinity WHERE user_id = ?",
                    params![user_id],
                )
                .map_err(|err| format!("db delete failed: {err}"))?;
        }
        "metrics" => {
            connection
                .execute(
                    "DELETE FROM user_metrics WHERE user_id = ?",
                    params![user_id],
                )
                .map_err(|err| format!("db delete failed: {err}"))?;
        }
        "all" => {
            // The Dossier UI promises this action removes the entire dossier,
            // pinned facts, and memory rows. Skipping user_pinned_facts /
            // user_memories here would leak supposedly-forgotten data back
            // into recall assembly the next time the user is mentioned.
            connection
                .execute(
                    "DELETE FROM personality_profiles WHERE scope = 'user' AND scope_id = ?",
                    params![user_id],
                )
                .map_err(|err| format!("db delete failed: {err}"))?;
            connection
                .execute(
                    "DELETE FROM user_project_affinity WHERE user_id = ?",
                    params![user_id],
                )
                .map_err(|err| format!("db delete failed: {err}"))?;
            connection
                .execute(
                    "DELETE FROM user_metrics WHERE user_id = ?",
                    params![user_id],
                )
                .map_err(|err| format!("db delete failed: {err}"))?;
            connection
                .execute(
                    "DELETE FROM user_dossiers WHERE user_id = ?",
                    params![user_id],
                )
                .map_err(|err| format!("db delete failed: {err}"))?;
            connection
                .execute(
                    "DELETE FROM user_pinned_facts WHERE user_id = ?",
                    params![user_id],
                )
                .map_err(|err| format!("db delete failed: {err}"))?;
            connection
                .execute(
                    "DELETE FROM user_memories WHERE user_id = ?",
                    params![user_id],
                )
                .map_err(|err| format!("db delete failed: {err}"))?;
        }
        other => return Err(format!("field '{other}' is not a valid forget target")),
    }
    write_dossier_cache_signal(&connection, &user_id)?;
    Ok(())
}

// ─── Phase E: pinned facts + memories admin surface ─────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PinnedFact {
    id: i64,
    user_id: String,
    text: String,
    source: String,
    created_at: String,
    updated_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UserMemory {
    id: i64,
    user_id: String,
    job_id: Option<String>,
    workflow: Option<String>,
    status: Option<String>,
    repo: Option<String>,
    pr_url: Option<String>,
    product: Option<String>,
    summary: String,
    created_at: String,
}

const PINNED_FACT_MAX_CHARS: usize = 280;
const PINNED_FACT_USER_CAP: i64 = 50;

#[tauri::command]
async fn list_pinned_facts(user_id: String, state: State<'_, AppState>) -> Result<Vec<PinnedFact>, String> {
    let connection =
        Connection::open(&*state.db_path).map_err(|err| format!("db open failed: {err}"))?;
    let mut stmt = connection
        .prepare(
            "SELECT id, user_id, text, source, created_at, updated_at
             FROM user_pinned_facts
             WHERE user_id = ?
             ORDER BY created_at DESC, id DESC",
        )
        .map_err(|err| format!("db prepare failed: {err}"))?;
    let rows = stmt
        .query_map(params![user_id], |row| {
            Ok(PinnedFact {
                id: row.get(0)?,
                user_id: row.get(1)?,
                text: row.get(2)?,
                source: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })
        .map_err(|err| format!("db query failed: {err}"))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|err| format!("db row failed: {err}"))?);
    }
    Ok(out)
}

#[tauri::command]
async fn add_pinned_fact(
    user_id: String,
    text: String,
    state: State<'_, AppState>,
) -> Result<PinnedFact, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("Pinned fact text must not be empty".to_string());
    }
    let truncated = if trimmed.len() > PINNED_FACT_MAX_CHARS {
        trimmed.chars().take(PINNED_FACT_MAX_CHARS).collect::<String>()
    } else {
        trimmed.to_string()
    };

    let connection =
        Connection::open(&*state.db_path).map_err(|err| format!("db open failed: {err}"))?;
    let now = Utc::now().to_rfc3339();

    // Idempotency: identical text → return existing row.
    let existing: Option<PinnedFact> = connection
        .query_row(
            "SELECT id, user_id, text, source, created_at, updated_at
             FROM user_pinned_facts
             WHERE user_id = ? AND text = ?
             LIMIT 1",
            params![user_id, truncated],
            |row| {
                Ok(PinnedFact {
                    id: row.get(0)?,
                    user_id: row.get(1)?,
                    text: row.get(2)?,
                    source: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                })
            },
        )
        .optional()
        .map_err(|err| format!("db query failed: {err}"))?;
    if let Some(row) = existing {
        return Ok(row);
    }

    connection
        .execute(
            "INSERT INTO user_pinned_facts(user_id, text, source, created_at, updated_at)
             VALUES(?, ?, 'admin-edit', ?, ?)",
            params![user_id, truncated, now, now],
        )
        .map_err(|err| format!("db insert failed: {err}"))?;
    let new_id = connection.last_insert_rowid();

    // Cap enforcement: evict the oldest if we just exceeded the per-user cap.
    let count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM user_pinned_facts WHERE user_id = ?",
            params![user_id],
            |row| row.get(0),
        )
        .map_err(|err| format!("db query failed: {err}"))?;
    if count > PINNED_FACT_USER_CAP {
        connection
            .execute(
                "DELETE FROM user_pinned_facts
                 WHERE id = (
                   SELECT id FROM user_pinned_facts
                   WHERE user_id = ?
                   ORDER BY created_at ASC, id ASC
                   LIMIT 1
                 )",
                params![user_id],
            )
            .map_err(|err| format!("db evict failed: {err}"))?;
    }

    let row = connection
        .query_row(
            "SELECT id, user_id, text, source, created_at, updated_at
             FROM user_pinned_facts WHERE id = ?",
            params![new_id],
            |row| {
                Ok(PinnedFact {
                    id: row.get(0)?,
                    user_id: row.get(1)?,
                    text: row.get(2)?,
                    source: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                })
            },
        )
        .map_err(|err| format!("db row read failed: {err}"))?;
    write_dossier_cache_signal(&connection, &user_id)?;
    Ok(row)
}

#[tauri::command]
async fn remove_pinned_fact(
    user_id: String,
    id: i64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let connection =
        Connection::open(&*state.db_path).map_err(|err| format!("db open failed: {err}"))?;
    connection
        .execute(
            "DELETE FROM user_pinned_facts WHERE id = ? AND user_id = ?",
            params![id, user_id],
        )
        .map_err(|err| format!("db delete failed: {err}"))?;
    write_dossier_cache_signal(&connection, &user_id)?;
    Ok(())
}

#[tauri::command]
async fn get_user_memories(
    user_id: String,
    limit: Option<i64>,
    state: State<'_, AppState>,
) -> Result<Vec<UserMemory>, String> {
    let connection =
        Connection::open(&*state.db_path).map_err(|err| format!("db open failed: {err}"))?;
    let mut stmt = connection
        .prepare(
            "SELECT id, user_id, job_id, workflow, status, repo, pr_url, product, summary, created_at
             FROM user_memories
             WHERE user_id = ?
             ORDER BY created_at DESC
             LIMIT ?",
        )
        .map_err(|err| format!("db prepare failed: {err}"))?;
    let rows = stmt
        .query_map(params![user_id, limit.unwrap_or(50)], |row| {
            Ok(UserMemory {
                id: row.get(0)?,
                user_id: row.get(1)?,
                job_id: row.get(2)?,
                workflow: row.get(3)?,
                status: row.get(4)?,
                repo: row.get(5)?,
                pr_url: row.get(6)?,
                product: row.get(7)?,
                summary: row.get(8)?,
                created_at: row.get(9)?,
            })
        })
        .map_err(|err| format!("db query failed: {err}"))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|err| format!("db row failed: {err}"))?);
    }
    Ok(out)
}

/// Capability bundle as seen from the desktop UI. Mirrors the sidecar's
/// `Bundle` interface in `sidecar/src/types/contracts.ts`. `resolved_user_ids`
/// is NOT persisted in the table (subteam membership lives in Slack); the
/// sidecar hydrates it after load via `hydrateBundleUserIds`. The UI sees an
/// empty array on reads and is not expected to send a non-empty one — it's
/// included here for round-trip type compatibility.
#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct BundleRecord {
    name: String,
    slack_user_group_handle: String,
    manual_user_ids: String,
    #[serde(default)]
    resolved_user_ids: Vec<String>,
    capabilities: Vec<String>,
    allowed_channel_ids: Vec<String>,
    allow_im: bool,
    allow_mpim: bool,
}

/// Notify the sidecar that the bundles table has been edited from the
/// desktop. The sidecar's per-workflow access check compares this signal's
/// `updated_at` against its in-memory bundles build time; when newer, it
/// reloads bundles in place. Safe to call after any bundle mutation;
/// failures are non-fatal (worst case: stale cache until next restart).
fn write_access_cache_signal(connection: &Connection) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    connection
        .execute(
            "INSERT INTO access_cache_signals(id, updated_at) VALUES(1, ?)
             ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at",
            params![now],
        )
        .map_err(|err| format!("access signal write failed: {err}"))?;
    Ok(())
}

#[tauri::command]
async fn get_bundles(state: State<'_, AppState>) -> Result<Vec<BundleRecord>, String> {
    let connection =
        Connection::open(&*state.db_path).map_err(|err| format!("db open failed: {err}"))?;
    let mut stmt = connection
        .prepare(
            "SELECT name, slack_user_group_handle, manual_user_ids, capabilities,
                    allowed_channel_ids, allow_im, allow_mpim
             FROM bundles
             ORDER BY name",
        )
        .map_err(|err| format!("db prepare bundles failed: {err}"))?;
    let rows = stmt
        .query_map([], |row| {
            let capabilities_json: String = row.get(3)?;
            let allowed_channels_csv: String = row.get(4)?;
            let allow_im: i64 = row.get(5)?;
            let allow_mpim: i64 = row.get(6)?;
            let capabilities: Vec<String> = serde_json::from_str(&capabilities_json).unwrap_or_default();
            let allowed_channel_ids = allowed_channels_csv
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            Ok(BundleRecord {
                name: row.get(0)?,
                slack_user_group_handle: row.get(1)?,
                manual_user_ids: row.get(2)?,
                resolved_user_ids: Vec::new(),
                capabilities,
                allowed_channel_ids,
                allow_im: allow_im != 0,
                allow_mpim: allow_mpim != 0,
            })
        })
        .map_err(|err| format!("db query bundles failed: {err}"))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|err| format!("db row failed: {err}"))?);
    }
    Ok(out)
}

#[tauri::command]
async fn save_bundle(bundle: BundleRecord, state: State<'_, AppState>) -> Result<(), String> {
    let name = bundle.name.trim().to_string();
    if name.is_empty() {
        return Err("bundle name cannot be empty".to_string());
    }
    let capabilities_json = serde_json::to_string(&bundle.capabilities)
        .map_err(|err| format!("capability encode failed: {err}"))?;
    let allowed_channels_csv = bundle
        .allowed_channel_ids
        .iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(",");
    let connection =
        Connection::open(&*state.db_path).map_err(|err| format!("db open failed: {err}"))?;
    let now = Utc::now().to_rfc3339();
    connection
        .execute(
            "INSERT INTO bundles(name, slack_user_group_handle, manual_user_ids, capabilities,
                                 allowed_channel_ids, allow_im, allow_mpim, updated_at)
             VALUES(?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(name) DO UPDATE SET
               slack_user_group_handle = excluded.slack_user_group_handle,
               manual_user_ids = excluded.manual_user_ids,
               capabilities = excluded.capabilities,
               allowed_channel_ids = excluded.allowed_channel_ids,
               allow_im = excluded.allow_im,
               allow_mpim = excluded.allow_mpim,
               updated_at = excluded.updated_at",
            params![
                name,
                bundle.slack_user_group_handle,
                bundle.manual_user_ids,
                capabilities_json,
                allowed_channels_csv,
                if bundle.allow_im { 1 } else { 0 },
                if bundle.allow_mpim { 1 } else { 0 },
                now,
            ],
        )
        .map_err(|err| format!("db save bundle failed: {err}"))?;
    write_access_cache_signal(&connection)?;
    Ok(())
}

#[tauri::command]
async fn delete_bundle(name: String, state: State<'_, AppState>) -> Result<(), String> {
    let connection =
        Connection::open(&*state.db_path).map_err(|err| format!("db open failed: {err}"))?;
    connection
        .execute("DELETE FROM bundles WHERE name = ?", params![name])
        .map_err(|err| format!("db delete bundle failed: {err}"))?;
    write_access_cache_signal(&connection)?;
    Ok(())
}

fn query_runs(connection: &Connection, sql: &str) -> Result<Vec<RunSummary>, String> {
    let mut stmt = connection
        .prepare(sql)
        .map_err(|err| format!("db prepare failed: {err}"))?;
    let rows = stmt
        .query_map([], |row| {
            let workflow: String = row.get(1)?;
            let error_message: Option<String> = row.get(7)?;
            let payload_json: Option<String> = row.get(8)?;
            Ok(RunSummary {
                id: row.get(0)?,
                workflow: workflow.clone(),
                status: row.get(2)?,
                task_summary: derive_task_summary(
                    &workflow,
                    payload_json.as_deref(),
                    error_message.as_deref(),
                ),
                channel_id: row.get(3)?,
                thread_ts: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
                error_message,
            })
        })
        .map_err(|err| format!("db query failed: {err}"))?;

    let mut output = Vec::new();
    for row in rows {
        output.push(row.map_err(|err| format!("db row failed: {err}"))?);
    }
    Ok(output)
}

fn derive_task_summary(
    workflow: &str,
    payload_json: Option<&str>,
    error_message: Option<&str>,
) -> String {
    if let Some(text) = extract_payload_text(payload_json) {
        let cleaned = strip_request_leadin(&clean_slack_text(&text));
        if workflow == "DEV_ASSIST" {
            if let Some(summary) = summarize_dev_assist_command(&cleaned) {
                return summary;
            }
        }
        if workflow == "PR_REVIEW" {
            if let Some(summary) = summarize_pull_request(&cleaned) {
                return summary;
            }
        }
        if !cleaned.is_empty() {
            return sentence_case(&truncate_summary(&cleaned, 96));
        }
    }

    if let Some(message) = error_message {
        let concise = message.split(':').next().unwrap_or(message).trim();
        if !concise.is_empty() {
            return truncate_summary(concise, 72);
        }
    }

    match workflow {
        "PR_REVIEW" => "Pull request review".to_string(),
        "OWNER_AUTOPILOT" => "Owner request".to_string(),
        "DEV_ASSIST" => "Watchtower command".to_string(),
        _ => "Workflow task".to_string(),
    }
}

fn extract_payload_text(payload_json: Option<&str>) -> Option<String> {
    let payload = payload_json?;
    let parsed: serde_json::Value = serde_json::from_str(payload).ok()?;
    let text = parsed.get("text")?.as_str()?.trim();
    if text.is_empty() {
        return None;
    }
    Some(text.to_string())
}

fn clean_slack_text(raw: &str) -> String {
    let mut output = String::new();
    let mut remainder = raw;

    while let Some(start) = remainder.find('<') {
        output.push_str(&remainder[..start]);
        let token_start = start + 1;
        let Some(end_offset) = remainder[token_start..].find('>') else {
            output.push_str(&remainder[start..]);
            remainder = "";
            break;
        };

        let token_end = token_start + end_offset;
        output.push_str(&decode_slack_token(&remainder[token_start..token_end]));
        remainder = &remainder[token_end + 1..];
    }

    output.push_str(remainder);

    output
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn decode_slack_token(token: &str) -> String {
    if token.starts_with('@') || token.starts_with('!') {
        return String::new();
    }

    if token.starts_with('#') {
        if let Some((_, label)) = token.split_once('|') {
            return format!("#{}", label.trim_start_matches('#'));
        }
        return "channel".to_string();
    }

    if let Some((url, label)) = token.split_once('|') {
        if !label.is_empty() {
            return label.to_string();
        }
        return url.to_string();
    }

    token.to_string()
}

fn strip_request_leadin(input: &str) -> String {
    let mut cleaned = input.trim();
    let prefixes = [
        "watchtower ",
        "wt ",
        "please ",
        "pls ",
        "can you ",
        "could you ",
        "would you ",
        "hey ",
        "hi ",
        "hello ",
    ];

    loop {
        let lower = cleaned.to_ascii_lowercase();
        let mut matched = false;
        for prefix in prefixes {
            if lower.starts_with(prefix) {
                cleaned = cleaned[prefix.len()..].trim_start_matches([' ', ':', ',', '-']);
                matched = true;
                break;
            }
        }
        if !matched {
            break;
        }
    }

    cleaned.trim().to_string()
}

fn summarize_dev_assist_command(text: &str) -> Option<String> {
    let command = text.trim();
    if command.is_empty() {
        return None;
    }

    let lower = command.to_ascii_lowercase();
    let summary = if lower == "help" {
        "Show available Watchtower commands"
    } else if lower == "status" {
        "Show Watchtower status"
    } else if lower.starts_with("runs") {
        "List recent runs"
    } else if lower.starts_with("failures") {
        "List recent failures"
    } else if lower.starts_with("trace ") {
        "Show trace for a job"
    } else if lower.starts_with("diagnose ") {
        "Diagnose a failed job"
    } else if lower == "learn" {
        "Run the learning pass"
    } else if lower.starts_with("heat") {
        "Show channel heat"
    } else if lower.starts_with("personality set ") || lower.starts_with("personality show") {
        "Reply style settings removed"
    } else if lower.starts_with("replay ") {
        "Replay a previous job"
    } else if lower.starts_with("fork ") {
        "Fork a previous job"
    } else if lower.starts_with("my queue") {
        "Show my prioritized queue"
    } else {
        return None;
    };

    Some(summary.to_string())
}

fn summarize_pull_request(text: &str) -> Option<String> {
    for token in text.split_whitespace() {
        let trimmed = token.trim_matches(|ch: char| matches!(ch, '.' | ',' | ')' | '('));
        let Some(marker_index) = trimmed.find("github.com/") else {
            continue;
        };
        let path = &trimmed[marker_index + "github.com/".len()..];
        let mut parts = path.split('/');
        let Some(owner) = parts.next() else {
            continue;
        };
        let Some(repo) = parts.next() else {
            continue;
        };
        let Some(kind) = parts.next() else {
            continue;
        };
        if kind != "pull" {
            continue;
        }
        let Some(number_part) = parts.next() else {
            continue;
        };
        let number = number_part.trim_matches(|ch: char| !ch.is_ascii_digit());
        if !owner.is_empty() && !repo.is_empty() && !number.is_empty() {
            return Some(format!("Review PR {owner}/{repo}#{number}"));
        }
    }

    None
}

fn truncate_summary(input: &str, max_chars: usize) -> String {
    if input.chars().count() <= max_chars {
        return input.to_string();
    }

    let soft_limit = max_chars.saturating_sub(3);
    let mut truncated = String::new();

    for word in input.split_whitespace() {
        let next_len = if truncated.is_empty() {
            word.chars().count()
        } else {
            truncated.chars().count() + 1 + word.chars().count()
        };

        if next_len > soft_limit {
            break;
        }

        if !truncated.is_empty() {
            truncated.push(' ');
        }
        truncated.push_str(word);
    }

    if truncated.is_empty() {
        truncated = input.chars().take(soft_limit).collect();
    }

    format!("{truncated}...")
}

fn sentence_case(input: &str) -> String {
    let mut chars = input.chars();
    let Some(first) = chars.next() else {
        return String::new();
    };
    let mut output = first.to_uppercase().collect::<String>();
    output.push_str(chars.as_str());
    output
}

fn is_actionable_unknown_text(input: &str) -> bool {
    let normalized = input
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");

    if normalized.is_empty() {
        return false;
    }

    let has_actionable_signal = [
        "what did you learn",
        "what have you learned",
        "show learning",
        "learn",
        "learning",
        "status",
        "health",
        "queue",
        "channel heat",
        "hot channels",
        "heat",
        "failures",
        "failure",
        "errors",
        "error",
        "trace",
        "diagnose",
        "github mcp",
        "mcp",
        "watchtower",
        "wt",
    ]
    .iter()
    .any(|signal| normalized.contains(signal));

    if !has_actionable_signal {
        return false;
    }

    let looks_like_social_chatter = [
        "you there",
        "are you up",
        "retire bro",
        "feeling sad",
        "who is your master",
        "go to sleep",
        "dialogues",
        "kaam",
    ]
    .iter()
    .any(|signal| normalized.contains(signal));

    if !looks_like_social_chatter {
        return true;
    }

    [
        "status",
        "health",
        "queue",
        "channel heat",
        "hot channels",
        "failures",
        "errors",
        "trace",
        "diagnose",
        "github",
        "mcp",
    ]
    .iter()
    .any(|signal| normalized.contains(signal))
}

fn query_actionable_unknown_tasks_24h(connection: &Connection) -> Result<i64, String> {
    let mut stmt = connection
        .prepare(
            "SELECT payload_json
             FROM jobs
             WHERE workflow = 'UNKNOWN'
               AND julianday(created_at) >= julianday('now', '-1 day')",
        )
        .map_err(|err| format!("db prepare unknown_tasks_24h failed: {err}"))?;

    let rows = stmt
        .query_map([], |row| row.get::<_, Option<String>>(0))
        .map_err(|err| format!("db query unknown_tasks_24h failed: {err}"))?;

    let mut actionable = 0i64;
    for row in rows {
        let payload_json = row.map_err(|err| format!("db row unknown_tasks_24h failed: {err}"))?;
        let Some(text) = extract_payload_text(payload_json.as_deref()) else {
            continue;
        };
        let cleaned = strip_request_leadin(&clean_slack_text(&text));
        if is_actionable_unknown_text(&cleaned) {
            actionable += 1;
        }
    }

    Ok(actionable)
}

fn query_dashboard_metrics(connection: &Connection) -> Result<DashboardMetrics, String> {
    let runs_24h: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM jobs WHERE julianday(created_at) >= julianday('now', '-1 day')",
            [],
            |row| row.get(0),
        )
        .map_err(|err| format!("db query runs_24h failed: {err}"))?;

    let failed_runs_24h: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM jobs WHERE status = 'FAILED' AND julianday(created_at) >= julianday('now', '-1 day')",
            [],
            |row| row.get(0),
        )
        .map_err(|err| format!("db query failed_runs_24h failed: {err}"))?;

    let success_runs_24h: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM jobs WHERE status = 'SUCCESS' AND julianday(created_at) >= julianday('now', '-1 day')",
            [],
            |row| row.get(0),
        )
        .map_err(|err| format!("db query success_runs_24h failed: {err}"))?;

    let avg_resolution_seconds_24h: f64 = connection
        .query_row(
            "SELECT COALESCE(AVG((julianday(updated_at) - julianday(created_at)) * 86400.0), 0.0)
             FROM jobs
             WHERE julianday(created_at) >= julianday('now', '-1 day')",
            [],
            |row| row.get(0),
        )
        .map_err(|err| format!("db query avg_resolution_seconds_24h failed: {err}"))?;

    let unknown_tasks_24h = query_actionable_unknown_tasks_24h(connection)?;

    let catchup_recovered_24h: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM events WHERE event_id LIKE 'replay:%' AND julianday(created_at) >= julianday('now', '-1 day')",
            [],
            |row| row.get(0),
        )
        .map_err(|err| format!("db query catchup_recovered_24h failed: {err}"))?;

    let access_audit_would_deny_24h: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM job_logs
             WHERE stage = 'access.audit.would_deny'
               AND julianday(created_at) >= julianday('now', '-1 day')",
            [],
            |row| row.get(0),
        )
        .map_err(|err| format!("db query access_audit_would_deny_24h failed: {err}"))?;

    let success_rate_24h = if runs_24h <= 0 {
        100.0
    } else {
        ((success_runs_24h as f64 / runs_24h as f64) * 100.0 * 10.0).round() / 10.0
    };

    let success_streak = query_success_streak(connection)?;
    let mut chaos_index =
        failed_runs_24h * 4 + unknown_tasks_24h * 2 + access_audit_would_deny_24h.min(5);
    if avg_resolution_seconds_24h >= 600.0 {
        chaos_index += 2;
    }
    chaos_index = chaos_index.clamp(0, 100);

    // Cost & token rollups from agent_calls (table is created by sidecar on
    // first run; query is tolerant of an empty/missing-column scenario).
    let cost_row = connection
        .query_row(
            "SELECT
                COALESCE(SUM(cost_usd), 0.0) AS total_cost,
                COALESCE(SUM(input_tokens), 0) AS total_input,
                COALESCE(SUM(output_tokens), 0) AS total_output,
                COALESCE(SUM(cache_read_tokens), 0) AS total_cache_read
             FROM agent_calls
             WHERE julianday(created_at) >= julianday('now', '-1 day')",
            [],
            |row| {
                Ok((
                    row.get::<_, f64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .unwrap_or((0.0, 0, 0, 0));
    let (cost_24h_usd, tokens_input_24h, tokens_output_24h, cache_read_tokens_24h) = cost_row;

    let cache_denominator = tokens_input_24h + cache_read_tokens_24h;
    let cache_hit_rate_24h = if cache_denominator > 0 {
        cache_read_tokens_24h as f64 / cache_denominator as f64
    } else {
        0.0
    };
    let avg_cost_per_run_usd = if runs_24h > 0 {
        cost_24h_usd / runs_24h as f64
    } else {
        0.0
    };

    Ok(DashboardMetrics {
        runs_24h,
        success_rate_24h,
        failed_runs_24h,
        avg_resolution_seconds_24h: avg_resolution_seconds_24h.round() as i64,
        unknown_tasks_24h,
        catchup_recovered_24h,
        access_audit_would_deny_24h,
        success_streak,
        chaos_index,
        cost_24h_usd,
        tokens_input_24h,
        tokens_output_24h,
        cache_read_tokens_24h,
        cache_hit_rate_24h,
        avg_cost_per_run_usd,
    })
}

fn query_active_job_count(connection: &Connection) -> Result<i64, String> {
    connection
        .query_row(
            "SELECT COUNT(*) FROM jobs WHERE status = 'RUNNING'",
            [],
            |row| row.get(0),
        )
        .map_err(|err| format!("db query active_jobs failed: {err}"))
}

async fn query_tray_stats_snapshot(state: &AppState) -> Result<TrayStatsSnapshot, String> {
    let sidecar_status = state.supervisor.get().await;
    let connection =
        Connection::open(&*state.db_path).map_err(|err| format!("db open failed: {err}"))?;
    let metrics = query_dashboard_metrics(&connection)?;
    let settings = read_app_settings(&connection)?;

    Ok(TrayStatsSnapshot {
        active_jobs: query_active_job_count(&connection)?,
        max_concurrent_jobs: settings.max_concurrent_jobs.max(1),
        runs_24h: metrics.runs_24h,
        failed_runs_24h: metrics.failed_runs_24h,
        success_rate_24h: metrics.success_rate_24h,
        success_streak: metrics.success_streak,
        sidecar_status,
        settings_configured: is_settings_complete(&settings),
    })
}

fn compact_sidecar_status_label(status: &str, settings_configured: bool) -> &'static str {
    if !settings_configured || status.starts_with("waiting for settings") {
        "setup"
    } else if status.starts_with("running") {
        "running"
    } else if status.starts_with("starting") {
        "starting"
    } else if status.starts_with("restarting") {
        "retrying"
    } else if status.starts_with("failed") || status.starts_with("error") {
        "issue"
    } else if status.starts_with("stopped") {
        "stopped"
    } else {
        "status"
    }
}

fn format_percent(value: f64) -> String {
    let rounded = (value * 10.0).round() / 10.0;
    if (rounded - rounded.round()).abs() < f64::EPSILON {
        format!("{}%", rounded.round() as i64)
    } else {
        format!("{rounded:.1}%")
    }
}

fn format_tray_title(snapshot: &TrayStatsSnapshot) -> String {
    let queue = format!("{}/{}", snapshot.active_jobs, snapshot.max_concurrent_jobs);
    let sidecar_label =
        compact_sidecar_status_label(&snapshot.sidecar_status, snapshot.settings_configured);

    if sidecar_label == "running" {
        format!(
            "WT {queue} active | {}",
            format_percent(snapshot.success_rate_24h)
        )
    } else {
        format!("WT {queue} active | {sidecar_label}")
    }
}

fn format_tray_tooltip(snapshot: &TrayStatsSnapshot) -> String {
    format!(
        "Watchtower | Active jobs: {} / {} | Runs (24h): {} | Failures (24h): {} | Success (24h): {} | Sidecar: {}",
        snapshot.active_jobs,
        snapshot.max_concurrent_jobs,
        snapshot.runs_24h,
        snapshot.failed_runs_24h,
        format_percent(snapshot.success_rate_24h),
        sentence_case(&snapshot.sidecar_status)
    )
}

fn build_tray_menu(
    app_handle: &AppHandle,
    snapshot: &TrayStatsSnapshot,
) -> Result<Menu<tauri::Wry>, String> {
    let queue_text = if snapshot.settings_configured {
        format!(
            "Active jobs: {} / {}",
            snapshot.active_jobs, snapshot.max_concurrent_jobs
        )
    } else {
        format!(
            "Active jobs: {} / {} (setup incomplete)",
            snapshot.active_jobs, snapshot.max_concurrent_jobs
        )
    };

    let active = MenuItem::with_id(app_handle, "stats_active", queue_text, false, None::<&str>)
        .map_err(|err| format!("tray menu active jobs failed: {err}"))?;
    let runs = MenuItem::with_id(
        app_handle,
        "stats_runs_24h",
        format!("Runs last 24h: {}", snapshot.runs_24h),
        false,
        None::<&str>,
    )
    .map_err(|err| format!("tray menu runs failed: {err}"))?;
    let failures = MenuItem::with_id(
        app_handle,
        "stats_failures_24h",
        format!("Failures last 24h: {}", snapshot.failed_runs_24h),
        false,
        None::<&str>,
    )
    .map_err(|err| format!("tray menu failures failed: {err}"))?;
    let success = MenuItem::with_id(
        app_handle,
        "stats_success_24h",
        format!(
            "Success rate last 24h: {}",
            format_percent(snapshot.success_rate_24h)
        ),
        false,
        None::<&str>,
    )
    .map_err(|err| format!("tray menu success failed: {err}"))?;
    let streak = MenuItem::with_id(
        app_handle,
        "stats_success_streak",
        format!("Success streak: {}", snapshot.success_streak),
        false,
        None::<&str>,
    )
    .map_err(|err| format!("tray menu streak failed: {err}"))?;
    let sidecar = MenuItem::with_id(
        app_handle,
        "stats_sidecar_status",
        format!("Sidecar: {}", sentence_case(&snapshot.sidecar_status)),
        false,
        None::<&str>,
    )
    .map_err(|err| format!("tray menu sidecar failed: {err}"))?;
    let separator = PredefinedMenuItem::separator(app_handle)
        .map_err(|err| format!("tray menu separator failed: {err}"))?;
    let open = MenuItem::with_id(app_handle, "open", "Open Watchtower", true, None::<&str>)
        .map_err(|err| format!("tray menu open failed: {err}"))?;
    let quit = MenuItem::with_id(app_handle, "quit", "Quit", true, None::<&str>)
        .map_err(|err| format!("tray menu quit failed: {err}"))?;

    Menu::with_items(
        app_handle,
        &[
            &active, &runs, &failures, &success, &streak, &sidecar, &separator, &open, &quit,
        ],
    )
    .map_err(|err| format!("tray menu build failed: {err}"))
}

async fn refresh_tray_widget(app_handle: &AppHandle, state: &AppState) -> Result<(), String> {
    let snapshot = query_tray_stats_snapshot(state).await?;
    let menu = build_tray_menu(app_handle, &snapshot)?;
    let tray = app_handle
        .tray_by_id(TRAY_ID)
        .ok_or_else(|| "tray icon not found".to_string())?;

    tray.set_title(Some(format_tray_title(&snapshot)))
        .map_err(|err| format!("tray title update failed: {err}"))?;
    tray.set_tooltip(Some(format_tray_tooltip(&snapshot)))
        .map_err(|err| format!("tray tooltip update failed: {err}"))?;
    tray.set_menu(Some(menu))
        .map_err(|err| format!("tray menu update failed: {err}"))?;

    Ok(())
}

async fn start_tray_refresh_loop(app_handle: AppHandle, state: AppState) {
    let mut interval = tokio::time::interval(TRAY_REFRESH_INTERVAL);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        interval.tick().await;
        if state.supervisor_control.is_shutdown_requested() {
            break;
        }

        if let Err(err) = refresh_tray_widget(&app_handle, &state).await {
            eprintln!("failed to refresh tray widget: {err}");
        }
    }
}

fn query_success_streak(connection: &Connection) -> Result<i64, String> {
    let mut stmt = connection
        .prepare("SELECT status FROM jobs ORDER BY updated_at DESC LIMIT 200")
        .map_err(|err| format!("db prepare success streak failed: {err}"))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|err| format!("db query success streak failed: {err}"))?;

    let mut streak = 0i64;
    for row in rows {
        let status = row.map_err(|err| format!("db row success streak failed: {err}"))?;
        if status == "SUCCESS" {
            streak += 1;
        } else {
            break;
        }
    }
    Ok(streak)
}

fn query_channel_heat(connection: &Connection) -> Result<Vec<ChannelHeat>, String> {
    let mut stmt = connection
        .prepare(
            "SELECT
               channel_id,
               COUNT(*) as runs,
               SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) as failures
             FROM jobs
             WHERE channel_id != ''
               AND julianday(created_at) >= julianday('now', '-7 day')
             GROUP BY channel_id
             ORDER BY runs DESC
             LIMIT 8",
        )
        .map_err(|err| format!("db prepare channel heat failed: {err}"))?;

    let rows = stmt
        .query_map([], |row| {
            Ok(ChannelHeat {
                channel_id: row.get(0)?,
                runs: row.get(1)?,
                failures: row.get(2)?,
            })
        })
        .map_err(|err| format!("db query channel heat failed: {err}"))?;

    let mut output = Vec::new();
    for row in rows {
        output.push(row.map_err(|err| format!("db row channel heat failed: {err}"))?);
    }
    Ok(output)
}

fn query_learning_insights(connection: &Connection) -> Result<LearningInsights, String> {
    let signals_24h: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM learning_signals WHERE julianday(created_at) >= julianday('now', '-1 day')",
            [],
            |row| row.get(0),
        )
        .map_err(|err| format!("db query learning_signals 24h failed: {err}"))?;

    let corrections_learned: i64 = connection
        .query_row("SELECT COUNT(*) FROM intent_corrections", [], |row| {
            row.get(0)
        })
        .map_err(|err| format!("db query intent corrections failed: {err}"))?;

    let corrections_applied_24h: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM learning_signals WHERE correction_applied = 1 AND julianday(created_at) >= julianday('now', '-1 day')",
            [],
            |row| row.get(0),
        )
        .map_err(|err| format!("db query correction-applied 24h failed: {err}"))?;

    let personality_profiles: i64 = connection
        .query_row("SELECT COUNT(*) FROM personality_profiles", [], |row| {
            row.get(0)
        })
        .map_err(|err| format!("db query personality profile count failed: {err}"))?;

    let profiles_by_mode = if personality_profiles > 0 {
        vec![PersonalityModeStats {
            mode: "normal".to_string(),
            count: personality_profiles,
        }]
    } else {
        Vec::new()
    };

    let dominant_personality_mode = "normal".to_string();

    let (top_failure_kind, top_failure_count) = connection
        .query_row(
            "SELECT error_kind, COUNT(*) as cnt
             FROM learning_signals
             WHERE error_kind IS NOT NULL AND error_kind != ''
             GROUP BY error_kind
             ORDER BY cnt DESC, error_kind ASC
             LIMIT 1",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()
        .map_err(|err| format!("db query failure doctor stats failed: {err}"))?
        .unwrap_or_else(|| ("none".to_string(), 0));

    Ok(LearningInsights {
        signals_24h,
        corrections_learned,
        corrections_applied_24h,
        personality_profiles,
        dominant_personality_mode,
        top_failure_kind,
        top_failure_count,
        profiles_by_mode,
    })
}

fn build_recommendations(
    metrics: &DashboardMetrics,
    channel_heat: &[ChannelHeat],
) -> Vec<DashboardRecommendation> {
    let mut recommendations = Vec::new();

    if metrics.failed_runs_24h >= 5 {
        recommendations.push(DashboardRecommendation {
            id: "stability-drill".to_string(),
            priority: "HIGH".to_string(),
            title: "Run a stability drill".to_string(),
            detail: format!(
                "{} failed runs in the last 24h. Prioritize failure triage before new automations.",
                metrics.failed_runs_24h
            ),
        });
    }

    if metrics.unknown_tasks_24h >= 4 {
        recommendations.push(DashboardRecommendation {
            id: "intent-gap".to_string(),
            priority: "MEDIUM".to_string(),
            title: "Teach Watchtower new intents".to_string(),
            detail: format!(
                "{} unknown requests in 24h. Add one workflow route to reduce manual replies.",
                metrics.unknown_tasks_24h
            ),
        });
    }

    if metrics.catchup_recovered_24h > 0 {
        recommendations.push(DashboardRecommendation {
            id: "catchup-win".to_string(),
            priority: "LOW".to_string(),
            title: "Sleep recovery is paying off".to_string(),
            detail: format!(
                "Recovered {} missed mentions after wake/relaunch in the last 24h.",
                metrics.catchup_recovered_24h
            ),
        });
    }

    if metrics.access_audit_would_deny_24h > 0 {
        recommendations.push(DashboardRecommendation {
            id: "access-audit".to_string(),
            priority: "MEDIUM".to_string(),
            title: "Access audit warnings need review".to_string(),
            detail: format!(
                "{} request(s) would have been denied in the last 24h. Review audit logs before switching access mode to enforce.",
                metrics.access_audit_would_deny_24h
            ),
        });
    }

    if metrics.success_streak >= 10 {
        recommendations.push(DashboardRecommendation {
            id: "streak".to_string(),
            priority: "LOW".to_string(),
            title: "Hot streak detected".to_string(),
            detail: format!(
                "{} successful jobs in a row. Good time to raise max concurrency slightly.",
                metrics.success_streak
            ),
        });
    }

    if let Some(hottest) = select_failure_hotspot(channel_heat) {
        if hottest.failures >= 3 {
            recommendations.push(DashboardRecommendation {
                id: "channel-hotspot".to_string(),
                priority: "MEDIUM".to_string(),
                title: "Channel hotspot".to_string(),
                detail: format!(
                    "Channel {} has {} failures this week. Consider channel-specific prompts/guardrails.",
                    hottest.channel_id, hottest.failures
                ),
            });
        }
    }

    if recommendations.is_empty() {
        recommendations.push(DashboardRecommendation {
            id: "steady".to_string(),
            priority: "LOW".to_string(),
            title: "System healthy".to_string(),
            detail: "No urgent optimization needed. Keep iterating on workflow coverage and response quality."
                .to_string(),
        });
    }

    recommendations
}

fn select_failure_hotspot(channel_heat: &[ChannelHeat]) -> Option<&ChannelHeat> {
    channel_heat
        .iter()
        .filter(|channel| channel.failures > 0)
        .max_by(|left, right| {
            left.failures
                .cmp(&right.failures)
                .then_with(|| {
                    let left_runs = left.runs.max(1);
                    let right_runs = right.runs.max(1);
                    (left.failures * right_runs).cmp(&(right.failures * left_runs))
                })
                .then_with(|| left.runs.cmp(&right.runs))
        })
}

fn initialize_db(path: &PathBuf) -> Result<(), String> {
    let connection = Connection::open(path).map_err(|err| format!("db open failed: {err}"))?;
    connection
        .execute_batch(
            "
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS jobs (
              id TEXT PRIMARY KEY,
              event_id TEXT NOT NULL,
              dedupe_key TEXT NOT NULL,
              workflow TEXT NOT NULL,
              status TEXT NOT NULL,
              channel_id TEXT NOT NULL,
              thread_ts TEXT NOT NULL,
              payload_json TEXT,
              result_json TEXT,
              error_message TEXT,
              attempts INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_jobs_event_id ON jobs(event_id);
            CREATE INDEX IF NOT EXISTS idx_jobs_dedupe_key ON jobs(dedupe_key);

            CREATE TABLE IF NOT EXISTS job_logs (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              job_id TEXT NOT NULL,
              level TEXT NOT NULL,
              stage TEXT NOT NULL,
              message TEXT NOT NULL,
              data_json TEXT,
              created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_job_logs_job_id ON job_logs(job_id);

            CREATE TABLE IF NOT EXISTS events (
              event_id TEXT PRIMARY KEY,
              channel_id TEXT,
              thread_ts TEXT,
              created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sidecar_state (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS launchpad_requests (
              id TEXT PRIMARY KEY,
              target TEXT NOT NULL,
              prompt TEXT NOT NULL,
              owner_user_id TEXT NOT NULL,
              status TEXT NOT NULL,
              job_id TEXT,
              slack_channel_id TEXT,
              anchor_ts TEXT,
              result_json TEXT,
              error_message TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_launchpad_requests_status_created_at ON launchpad_requests(status, created_at);

            CREATE TABLE IF NOT EXISTS learning_signals (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              job_id TEXT,
              event_id TEXT,
              channel_id TEXT,
              user_id TEXT,
              workflow TEXT,
              status TEXT,
              intent TEXT,
              correction_applied INTEGER NOT NULL DEFAULT 0,
              personality_mode TEXT,
              error_kind TEXT,
              created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_learning_signals_created_at ON learning_signals(created_at);
            CREATE INDEX IF NOT EXISTS idx_learning_signals_channel_id ON learning_signals(channel_id);

            CREATE TABLE IF NOT EXISTS intent_corrections (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              channel_id TEXT NOT NULL,
              user_id TEXT NOT NULL,
              phrase_key TEXT NOT NULL,
              corrected_intent TEXT NOT NULL,
              hits INTEGER NOT NULL DEFAULT 1,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              UNIQUE(channel_id, user_id, phrase_key)
            );
            CREATE INDEX IF NOT EXISTS idx_intent_corrections_channel_user ON intent_corrections(channel_id, user_id);

            CREATE TABLE IF NOT EXISTS personality_profiles (
              scope TEXT NOT NULL,
              scope_id TEXT NOT NULL,
              mode TEXT NOT NULL,
              source TEXT,
              updated_at TEXT NOT NULL,
              PRIMARY KEY(scope, scope_id)
            );
            CREATE INDEX IF NOT EXISTS idx_personality_profiles_scope ON personality_profiles(scope, scope_id);

            CREATE TABLE IF NOT EXISTS app_settings (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              slack_bot_token TEXT NOT NULL DEFAULT '',
              slack_app_token TEXT NOT NULL DEFAULT '',
              owner_slack_user_ids TEXT NOT NULL DEFAULT '',
              bot_user_id TEXT NOT NULL DEFAULT '',
              bugs_and_updates_channel_id TEXT NOT NULL DEFAULT 'C01H25RNLJH',
              newton_web_path TEXT NOT NULL DEFAULT '',
              newton_api_path TEXT NOT NULL DEFAULT '',
              max_concurrent_jobs INTEGER NOT NULL DEFAULT 2,
              pr_review_timeout_ms INTEGER NOT NULL DEFAULT 1200000,
              bug_fix_timeout_ms INTEGER NOT NULL DEFAULT 2700000,
              repo_classifier_threshold REAL NOT NULL DEFAULT 0.75,
              theme_preset TEXT NOT NULL DEFAULT 'watchtower-midnight',
              theme_background_color TEXT NOT NULL DEFAULT '#06090C',
              theme_foreground_color TEXT NOT NULL DEFAULT '#F2F7FB',
              theme_accent_color TEXT NOT NULL DEFAULT '#53D2FF',
              theme_font_family TEXT NOT NULL DEFAULT 'ibm-plex',
              notification_audio_mode TEXT NOT NULL DEFAULT 'off',
              notification_audio_default_sound TEXT NOT NULL DEFAULT 'glass',
              notification_audio_custom_path TEXT NOT NULL DEFAULT '',
              success_notification_audio_mode TEXT NOT NULL DEFAULT 'off',
              success_notification_audio_default_sound TEXT NOT NULL DEFAULT 'glass',
              success_notification_audio_custom_path TEXT NOT NULL DEFAULT '',
              failure_notification_audio_mode TEXT NOT NULL DEFAULT 'off',
              failure_notification_audio_default_sound TEXT NOT NULL DEFAULT 'glass',
              failure_notification_audio_custom_path TEXT NOT NULL DEFAULT '',
              updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            INSERT OR IGNORE INTO app_settings(id) VALUES(1);
          ",
        )
        .map_err(|err| format!("db migration failed: {err}"))?;

    let success_mode_added = ensure_app_settings_column(
        &connection,
        "success_notification_audio_mode",
        "TEXT NOT NULL DEFAULT 'off'",
    )?;
    let success_default_sound_added = ensure_app_settings_column(
        &connection,
        "success_notification_audio_default_sound",
        "TEXT NOT NULL DEFAULT 'glass'",
    )?;
    let success_custom_path_added = ensure_app_settings_column(
        &connection,
        "success_notification_audio_custom_path",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    let failure_mode_added = ensure_app_settings_column(
        &connection,
        "failure_notification_audio_mode",
        "TEXT NOT NULL DEFAULT 'off'",
    )?;
    let failure_default_sound_added = ensure_app_settings_column(
        &connection,
        "failure_notification_audio_default_sound",
        "TEXT NOT NULL DEFAULT 'glass'",
    )?;
    let failure_custom_path_added = ensure_app_settings_column(
        &connection,
        "failure_notification_audio_custom_path",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    ensure_app_settings_column(
        &connection,
        "theme_preset",
        "TEXT NOT NULL DEFAULT 'watchtower-midnight'",
    )?;
    ensure_app_settings_column(
        &connection,
        "theme_background_color",
        "TEXT NOT NULL DEFAULT '#06090C'",
    )?;
    ensure_app_settings_column(
        &connection,
        "theme_foreground_color",
        "TEXT NOT NULL DEFAULT '#F2F7FB'",
    )?;
    ensure_app_settings_column(
        &connection,
        "theme_accent_color",
        "TEXT NOT NULL DEFAULT '#53D2FF'",
    )?;
    ensure_app_settings_column(
        &connection,
        "theme_font_family",
        "TEXT NOT NULL DEFAULT 'ibm-plex'",
    )?;
    ensure_app_settings_column(
        &connection,
        "notification_audio_mode",
        "TEXT NOT NULL DEFAULT 'off'",
    )?;
    ensure_app_settings_column(
        &connection,
        "notification_audio_default_sound",
        "TEXT NOT NULL DEFAULT 'glass'",
    )?;
    ensure_app_settings_column(
        &connection,
        "notification_audio_custom_path",
        "TEXT NOT NULL DEFAULT ''",
    )?;

    if success_mode_added
        || success_default_sound_added
        || success_custom_path_added
        || failure_mode_added
        || failure_default_sound_added
        || failure_custom_path_added
    {
        migrate_legacy_notification_audio_settings(&connection)?;
    }

    ensure_app_settings_column(
        &connection,
        "multi_agent_enabled",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_app_settings_column(
        &connection,
        "agent_backend",
        "TEXT NOT NULL DEFAULT 'codex'",
    )?;

    connection
        .execute_batch(
            "
            CREATE TABLE IF NOT EXISTS job_diffs (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              job_id TEXT NOT NULL UNIQUE,
              branch_name TEXT NOT NULL,
              repo_path TEXT NOT NULL,
              diff_text TEXT NOT NULL,
              files_json TEXT NOT NULL,
              insertions INTEGER NOT NULL DEFAULT 0,
              deletions INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_job_diffs_job_id ON job_diffs(job_id);
            ",
        )
        .map_err(|err| format!("db migration job_diffs failed: {err}"))?;

    connection
        .execute_batch(
            "
            CREATE TABLE IF NOT EXISTS access_control_settings (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              mode TEXT NOT NULL DEFAULT 'audit',
              updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            INSERT OR IGNORE INTO access_control_settings(id) VALUES(1);

            CREATE TABLE IF NOT EXISTS access_control_groups (
              group_key TEXT PRIMARY KEY,
              slack_user_group_handle TEXT NOT NULL DEFAULT '',
              manual_user_ids TEXT NOT NULL DEFAULT '',
              allowed_channel_ids TEXT NOT NULL DEFAULT '',
              allow_im INTEGER NOT NULL DEFAULT 0,
              allow_mpim INTEGER NOT NULL DEFAULT 0,
              updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            ",
        )
        .map_err(|err| format!("db migration access control failed: {err}"))?;

    let _ = connection.execute("ALTER TABLE app_settings ADD COLUMN pm_slack_user_ids TEXT NOT NULL DEFAULT ''", []);
    let _ = connection.execute("ALTER TABLE app_settings ADD COLUMN pm_task_timeout_ms INTEGER NOT NULL DEFAULT 600000", []);
    let _ = connection.execute("ALTER TABLE app_settings ADD COLUMN core_dev_slack_user_ids TEXT NOT NULL DEFAULT ''", []);
    let _ = connection.execute("ALTER TABLE app_settings ADD COLUMN core_dev_slack_user_group TEXT NOT NULL DEFAULT ''", []);
    let _ = connection.execute("ALTER TABLE app_settings ADD COLUMN vault_path TEXT NOT NULL DEFAULT ''", []);
    let _ = connection.execute("ALTER TABLE app_settings ADD COLUMN vault_enabled INTEGER NOT NULL DEFAULT 0", []);
    // mini_og_repo_root: read_app_settings selects this column unconditionally. Fresh-install
    // DBs created by initialize_db never had the column until the sidecar self-migration ran,
    // so the very first read_app_settings call from the desktop on launch crashed with
    // "no such column: mini_og_repo_root". Add it here so the Rust read path is always safe.
    let _ = connection.execute(
        "ALTER TABLE app_settings ADD COLUMN mini_og_repo_root TEXT NOT NULL DEFAULT '/Users/dipesh/code/mini-og'",
        [],
    );
    // newton_marketing_web_path: same fresh-install hazard as mini_og_repo_root — the Rust
    // read path selects it unconditionally, so the column must exist before first read.
    let _ = connection.execute(
        "ALTER TABLE app_settings ADD COLUMN newton_marketing_web_path TEXT NOT NULL DEFAULT ''",
        [],
    );
    // executed_workflow tracks the workflow that actually ran after router AI
    // reclassification. The sidecar's listDevRuns query reads it via COALESCE so
    // dashboard surfaces show the right label without disturbing jobs.workflow
    // (which pauseResume uses for resume detection).
    let _ = connection.execute("ALTER TABLE jobs ADD COLUMN executed_workflow TEXT", []);
    // dossier_cache_signals is a SQLite-only bridge from desktop Tauri commands
    // to the sidecar's in-memory dossier cache. Whenever the desktop mutates a
    // user's dossier or pinned facts, it INSERT OR REPLACEs the user_id with
    // a fresh updated_at. The sidecar's getDossier checks this on every call
    // and invalidates its cache when the signal is newer than the last seen.
    let _ = connection.execute(
        "CREATE TABLE IF NOT EXISTS dossier_cache_signals (user_id TEXT PRIMARY KEY, updated_at TEXT NOT NULL)",
        [],
    );
    ensure_access_control_seeded(&connection)?;

    Ok(())
}

fn ensure_app_settings_column(
    connection: &Connection,
    column_name: &str,
    column_definition: &str,
) -> Result<bool, String> {
    let mut stmt = connection
        .prepare("PRAGMA table_info(app_settings)")
        .map_err(|err| format!("db inspect settings schema failed: {err}"))?;

    let mut columns = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|err| format!("db inspect settings columns failed: {err}"))?;

    let has_column = columns.any(|column| matches!(column, Ok(ref name) if name == column_name));
    if has_column {
        return Ok(false);
    }

    connection
        .execute(
            &format!("ALTER TABLE app_settings ADD COLUMN {column_name} {column_definition}"),
            [],
        )
        .map_err(|err| format!("db add settings column {column_name} failed: {err}"))?;

    Ok(true)
}

fn ensure_access_control_seeded(connection: &Connection) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    let existing_group_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM access_control_groups", [], |row| row.get(0))
        .map_err(|err| format!("db inspect access_control_groups failed: {err}"))?;

    for key in access_group_keys() {
        connection
            .execute(
                "INSERT OR IGNORE INTO access_control_groups(
                   group_key,
                   slack_user_group_handle,
                   manual_user_ids,
                   allowed_channel_ids,
                   allow_im,
                   allow_mpim,
                   updated_at
                 ) VALUES(?, '', '', '', 0, 0, ?)",
                params![key, now],
            )
            .map_err(|err| format!("db seed access_control_groups failed: {err}"))?;
    }

    if existing_group_count > 0 {
        return Ok(());
    }

    let legacy = connection
        .query_row(
            "SELECT
               COALESCE(bugs_and_updates_channel_id, ''),
               COALESCE(core_dev_slack_user_ids, ''),
               COALESCE(core_dev_slack_user_group, '')
             FROM app_settings
             WHERE id = 1
             LIMIT 1",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|err| format!("db read legacy access seed failed: {err}"))?
        .unwrap_or_else(|| (String::new(), String::new(), String::new()));

    connection
        .execute(
            "UPDATE access_control_settings
             SET mode = 'audit',
                 updated_at = ?
             WHERE id = 1",
            params![now],
        )
        .map_err(|err| format!("db seed access_control_settings failed: {err}"))?;

    if !legacy.0.trim().is_empty() {
        connection
            .execute(
                "UPDATE access_control_groups
                 SET allowed_channel_ids = ?,
                     updated_at = ?
                 WHERE group_key = 'builder'",
                params![legacy.0.trim(), now],
            )
            .map_err(|err| format!("db seed builder access group failed: {err}"))?;
    }

    connection
        .execute(
            "UPDATE access_control_groups
             SET slack_user_group_handle = ?,
                 manual_user_ids = ?,
                 allowed_channel_ids = ?,
                 allow_im = 1,
                 allow_mpim = 1,
                 updated_at = ?
             WHERE group_key = 'admin'",
            params![legacy.2.trim(), legacy.1.trim(), legacy.0.trim(), now],
        )
        .map_err(|err| format!("db seed admin access group failed: {err}"))?;

    Ok(())
}

fn read_access_control_settings(connection: &Connection) -> Result<AccessControlSettings, String> {
    ensure_access_control_seeded(connection)?;

    let mode = connection
        .query_row(
            "SELECT mode FROM access_control_settings WHERE id = 1 LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|err| format!("db read access mode failed: {err}"))?
        .unwrap_or_else(|| "audit".to_string());

    let mut settings = AccessControlSettings {
        mode: if mode == "enforce" {
            "enforce".to_string()
        } else {
            "audit".to_string()
        },
        ..AccessControlSettings::default()
    };

    let mut stmt = connection
        .prepare(
            "SELECT
               group_key,
               slack_user_group_handle,
               manual_user_ids,
               allowed_channel_ids,
               allow_im,
               allow_mpim
             FROM access_control_groups",
        )
        .map_err(|err| format!("db prepare access groups failed: {err}"))?;

    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                AccessGroupSettings {
                    slack_user_group_handle: row.get(1)?,
                    manual_user_ids: row.get(2)?,
                    allowed_channel_ids: row.get(3)?,
                    allow_im: row.get::<_, i64>(4)? != 0,
                    allow_mpim: row.get::<_, i64>(5)? != 0,
                },
            ))
        })
        .map_err(|err| format!("db query access groups failed: {err}"))?;

    for row in rows {
        let (group_key, group_settings) =
            row.map_err(|err| format!("db row access group failed: {err}"))?;
        settings.groups.insert(group_key, group_settings);
    }

    Ok(settings)
}

fn persist_access_control_settings(
    connection: &Connection,
    access_control: &AccessControlSettings,
) -> Result<(), String> {
    ensure_access_control_seeded(connection)?;
    let now = Utc::now().to_rfc3339();

    connection
        .execute(
            "INSERT INTO access_control_settings(id, mode, updated_at)
             VALUES(1, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               mode = excluded.mode,
               updated_at = excluded.updated_at",
            params![access_control.mode.trim(), now],
        )
        .map_err(|err| format!("db save access mode failed: {err}"))?;

    for key in access_group_keys() {
        let group = access_control
            .groups
            .get(key)
            .cloned()
            .unwrap_or_else(default_access_group_settings);

        connection
            .execute(
                "INSERT INTO access_control_groups(
                   group_key,
                   slack_user_group_handle,
                   manual_user_ids,
                   allowed_channel_ids,
                   allow_im,
                   allow_mpim,
                   updated_at
                 ) VALUES(?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(group_key) DO UPDATE SET
                   slack_user_group_handle = excluded.slack_user_group_handle,
                   manual_user_ids = excluded.manual_user_ids,
                   allowed_channel_ids = excluded.allowed_channel_ids,
                   allow_im = excluded.allow_im,
                   allow_mpim = excluded.allow_mpim,
                   updated_at = excluded.updated_at",
                params![
                    key,
                    group.slack_user_group_handle.trim(),
                    group.manual_user_ids.trim(),
                    group.allowed_channel_ids.trim(),
                    if group.allow_im { 1 } else { 0 },
                    if group.allow_mpim { 1 } else { 0 },
                    now,
                ],
            )
            .map_err(|err| format!("db save access group {key} failed: {err}"))?;
    }

    Ok(())
}

fn migrate_legacy_notification_audio_settings(connection: &Connection) -> Result<(), String> {
    connection
        .execute(
            "UPDATE app_settings
             SET
               success_notification_audio_mode = notification_audio_mode,
               success_notification_audio_default_sound = notification_audio_default_sound,
               success_notification_audio_custom_path = notification_audio_custom_path,
               failure_notification_audio_mode = notification_audio_mode,
               failure_notification_audio_default_sound = notification_audio_default_sound,
               failure_notification_audio_custom_path = notification_audio_custom_path
             WHERE id = 1",
            [],
        )
        .map_err(|err| format!("db migrate notification audio settings failed: {err}"))?;

    Ok(())
}

fn read_app_settings(connection: &Connection) -> Result<AppSettings, String> {
    let mut stmt = connection
        .prepare(
            "SELECT
              slack_bot_token,
              slack_app_token,
              owner_slack_user_ids,
              bot_user_id,
              bugs_and_updates_channel_id,
              newton_web_path,
              newton_api_path,
              max_concurrent_jobs,
              pr_review_timeout_ms,
              bug_fix_timeout_ms,
              repo_classifier_threshold,
              theme_preset,
              theme_background_color,
              theme_foreground_color,
              theme_accent_color,
              theme_font_family,
              success_notification_audio_mode,
              success_notification_audio_default_sound,
              success_notification_audio_custom_path,
              failure_notification_audio_mode,
              failure_notification_audio_default_sound,
              failure_notification_audio_custom_path,
              agent_backend,
              COALESCE(pm_slack_user_ids, '') as pm_slack_user_ids,
              COALESCE(pm_task_timeout_ms, 600000) as pm_task_timeout_ms,
              COALESCE(core_dev_slack_user_ids, '') as core_dev_slack_user_ids,
              COALESCE(core_dev_slack_user_group, '') as core_dev_slack_user_group,
              COALESCE(vault_path, '') as vault_path,
              COALESCE(vault_enabled, 0) as vault_enabled,
              COALESCE(mini_og_repo_root, '/Users/dipesh/code/mini-og') as mini_og_repo_root,
              COALESCE(newton_marketing_web_path, '') as newton_marketing_web_path
             FROM app_settings
             WHERE id = 1
             LIMIT 1",
        )
        .map_err(|err| format!("db prepare settings failed: {err}"))?;

    let mut settings = stmt
        .query_row([], |row| {
            Ok(AppSettings {
                slack_bot_token: row.get(0)?,
                slack_app_token: row.get(1)?,
                owner_slack_user_ids: row.get(2)?,
                bot_user_id: row.get(3)?,
                bugs_and_updates_channel_id: row.get(4)?,
                newton_web_path: row.get(5)?,
                newton_api_path: row.get(6)?,
                max_concurrent_jobs: row.get(7)?,
                pr_review_timeout_ms: row.get(8)?,
                bug_fix_timeout_ms: row.get(9)?,
                repo_classifier_threshold: row.get(10)?,
                theme_preset: row.get(11)?,
                theme_background_color: row.get(12)?,
                theme_foreground_color: row.get(13)?,
                theme_accent_color: row.get(14)?,
                theme_font_family: row.get(15)?,
                success_notification_audio_mode: row.get(16)?,
                success_notification_audio_default_sound: row.get(17)?,
                success_notification_audio_custom_path: row.get(18)?,
                failure_notification_audio_mode: row.get(19)?,
                failure_notification_audio_default_sound: row.get(20)?,
                failure_notification_audio_custom_path: row.get(21)?,
                agent_backend: row.get(22)?,
                pm_slack_user_ids: row.get(23)?,
                pm_task_timeout_ms: row.get(24)?,
                core_dev_slack_user_ids: row.get(25)?,
                core_dev_slack_user_group: row.get(26)?,
                vault_path: row.get(27)?,
                vault_enabled: row.get::<_, i64>(28)? != 0,
                mini_og_repo_root: row.get(29)?,
                newton_marketing_web_path: row.get(30)?,
                access_control: AccessControlSettings::default(),
            })
        })
        .optional()
        .map_err(|err| format!("db read settings failed: {err}"))?
        .unwrap_or_default();

    settings.access_control = read_access_control_settings(connection)?;

    Ok(settings)
}

fn persist_app_settings(connection: &Connection, settings: &AppSettings) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO app_settings(
              id,
              slack_bot_token,
              slack_app_token,
              owner_slack_user_ids,
              bot_user_id,
              bugs_and_updates_channel_id,
              newton_web_path,
              newton_api_path,
              newton_marketing_web_path,
              max_concurrent_jobs,
              pr_review_timeout_ms,
              bug_fix_timeout_ms,
              repo_classifier_threshold,
              theme_preset,
              theme_background_color,
              theme_foreground_color,
              theme_accent_color,
              theme_font_family,
              success_notification_audio_mode,
              success_notification_audio_default_sound,
              success_notification_audio_custom_path,
              failure_notification_audio_mode,
              failure_notification_audio_default_sound,
              failure_notification_audio_custom_path,
              agent_backend,
              pm_slack_user_ids,
              pm_task_timeout_ms,
              core_dev_slack_user_ids,
              core_dev_slack_user_group,
              vault_path,
              vault_enabled,
              updated_at
             ) VALUES(1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
              slack_bot_token=excluded.slack_bot_token,
              slack_app_token=excluded.slack_app_token,
              owner_slack_user_ids=excluded.owner_slack_user_ids,
              bot_user_id=excluded.bot_user_id,
              bugs_and_updates_channel_id=excluded.bugs_and_updates_channel_id,
              newton_web_path=excluded.newton_web_path,
              newton_api_path=excluded.newton_api_path,
              newton_marketing_web_path=excluded.newton_marketing_web_path,
              max_concurrent_jobs=excluded.max_concurrent_jobs,
              pr_review_timeout_ms=excluded.pr_review_timeout_ms,
              bug_fix_timeout_ms=excluded.bug_fix_timeout_ms,
              repo_classifier_threshold=excluded.repo_classifier_threshold,
              theme_preset=excluded.theme_preset,
              theme_background_color=excluded.theme_background_color,
              theme_foreground_color=excluded.theme_foreground_color,
              theme_accent_color=excluded.theme_accent_color,
              theme_font_family=excluded.theme_font_family,
              success_notification_audio_mode=excluded.success_notification_audio_mode,
              success_notification_audio_default_sound=excluded.success_notification_audio_default_sound,
              success_notification_audio_custom_path=excluded.success_notification_audio_custom_path,
              failure_notification_audio_mode=excluded.failure_notification_audio_mode,
              failure_notification_audio_default_sound=excluded.failure_notification_audio_default_sound,
              failure_notification_audio_custom_path=excluded.failure_notification_audio_custom_path,
              agent_backend=excluded.agent_backend,
              pm_slack_user_ids=excluded.pm_slack_user_ids,
              pm_task_timeout_ms=excluded.pm_task_timeout_ms,
              core_dev_slack_user_ids=excluded.core_dev_slack_user_ids,
              core_dev_slack_user_group=excluded.core_dev_slack_user_group,
              vault_path=excluded.vault_path,
              vault_enabled=excluded.vault_enabled,
              updated_at=excluded.updated_at",
            params![
                settings.slack_bot_token.trim(),
                settings.slack_app_token.trim(),
                settings.owner_slack_user_ids.trim(),
                settings.bot_user_id.trim(),
                settings.bugs_and_updates_channel_id.trim(),
                settings.newton_web_path.trim(),
                settings.newton_api_path.trim(),
                settings.newton_marketing_web_path.trim(),
                settings.max_concurrent_jobs,
                settings.pr_review_timeout_ms,
                settings.bug_fix_timeout_ms,
                settings.repo_classifier_threshold,
                settings.theme_preset.trim(),
                settings.theme_background_color.trim(),
                settings.theme_foreground_color.trim(),
                settings.theme_accent_color.trim(),
                settings.theme_font_family.trim(),
                settings.success_notification_audio_mode.trim(),
                settings.success_notification_audio_default_sound.trim(),
                settings.success_notification_audio_custom_path.trim(),
                settings.failure_notification_audio_mode.trim(),
                settings.failure_notification_audio_default_sound.trim(),
                settings.failure_notification_audio_custom_path.trim(),
                settings.agent_backend.trim(),
                settings.pm_slack_user_ids.trim(),
                settings.pm_task_timeout_ms,
                settings.core_dev_slack_user_ids.trim(),
                settings.core_dev_slack_user_group.trim(),
                settings.vault_path.trim(),
                if settings.vault_enabled { 1_i64 } else { 0_i64 },
                Utc::now().to_rfc3339(),
            ],
        )
        .map_err(|err| format!("db save settings failed: {err}"))?;

    persist_access_control_settings(connection, &settings.access_control)?;

    Ok(())
}

fn submit_launchpad_task_inner(
    connection: &Connection,
    target: &str,
    prompt: &str,
) -> Result<SubmitLaunchpadTaskResponse, String> {
    let normalized_target = target.trim().to_ascii_lowercase();
    if normalized_target != "miniog" {
        return Err("Only miniOG launchpad execution is supported right now".to_string());
    }

    let trimmed_prompt = prompt.trim();
    if trimmed_prompt.is_empty() {
        return Err("Launchpad prompt must not be empty".to_string());
    }

    let settings = read_app_settings(connection)?;
    if !is_settings_complete(&settings) {
        return Err(
            "Runtime configuration is incomplete. Finish Settings before running miniOG from Launchpad."
                .to_string(),
        );
    }

    let owner_user_id = parse_owner_ids(&settings.owner_slack_user_ids)
        .into_iter()
        .next()
        .ok_or_else(|| "No owner Slack user IDs are configured".to_string())?;

    let request_id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    connection
        .execute(
            "INSERT INTO launchpad_requests(
              id,
              target,
              prompt,
              owner_user_id,
              status,
              created_at,
              updated_at
             ) VALUES(?, ?, ?, ?, 'PENDING', ?, ?)",
            params![
                request_id,
                normalized_target,
                trimmed_prompt,
                owner_user_id,
                now,
                now,
            ],
        )
        .map_err(|err| format!("db insert launchpad request failed: {err}"))?;

    Ok(SubmitLaunchpadTaskResponse { request_id })
}

fn validate_settings_for_save(settings: &AppSettings) -> Result<(), String> {
    if settings.max_concurrent_jobs < 1 || settings.max_concurrent_jobs > 10 {
        return Err("maxConcurrentJobs must be between 1 and 10".to_string());
    }

    if settings.pr_review_timeout_ms <= 0 {
        return Err("prReviewTimeoutMs must be > 0".to_string());
    }

    if settings.bug_fix_timeout_ms <= 0 {
        return Err("bugFixTimeoutMs must be > 0".to_string());
    }

    if !(0.0..=1.0).contains(&settings.repo_classifier_threshold) {
        return Err("repoClassifierThreshold must be between 0 and 1".to_string());
    }

    validate_optional_path(&settings.newton_web_path, "newtonWebPath")?;
    validate_optional_path(&settings.newton_api_path, "newtonApiPath")?;
    validate_optional_path(
        &settings.newton_marketing_web_path,
        "newtonMarketingWebPath",
    )?;
    validate_theme_setting(&settings.theme_preset, "themePreset")?;
    validate_theme_setting(&settings.theme_font_family, "themeFontFamily")?;
    validate_hex_color(&settings.theme_background_color, "themeBackgroundColor")?;
    validate_hex_color(&settings.theme_foreground_color, "themeForegroundColor")?;
    validate_hex_color(&settings.theme_accent_color, "themeAccentColor")?;
    validate_notification_audio_settings(settings)?;
    validate_access_control_settings(&settings.access_control)?;

    Ok(())
}

fn validate_access_control_settings(access_control: &AccessControlSettings) -> Result<(), String> {
    match access_control.mode.trim() {
        "audit" | "enforce" => {}
        _ => return Err("accessControl.mode must be audit or enforce".to_string()),
    }

    for key in access_group_keys() {
        if !access_control.groups.contains_key(key) {
            return Err(format!("accessControl.groups.{key} is required"));
        }
    }

    Ok(())
}

fn validate_optional_path(path_value: &str, field_name: &str) -> Result<(), String> {
    let trimmed = path_value.trim();
    if trimmed.is_empty() {
        return Ok(());
    }

    let path = Path::new(trimmed);
    if !path.is_absolute() {
        return Err(format!("{field_name} must be an absolute path"));
    }

    if !path.is_dir() {
        return Err(format!("{field_name} must point to an existing directory"));
    }

    Ok(())
}

fn validate_existing_file(path_value: &str, field_name: &str) -> Result<(), String> {
    let trimmed = path_value.trim();
    if trimmed.is_empty() {
        return Err(format!("{field_name} must not be empty"));
    }

    let path = Path::new(trimmed);
    if !path.is_absolute() {
        return Err(format!("{field_name} must be an absolute path"));
    }

    if !path.is_file() {
        return Err(format!("{field_name} must point to an existing file"));
    }

    Ok(())
}

fn validate_theme_setting(value: &str, field_name: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("{field_name} must not be empty"));
    }

    Ok(())
}

fn validate_notification_audio_settings(settings: &AppSettings) -> Result<(), String> {
    validate_notification_audio_profile(settings, NotificationAudioTone::Success)?;
    validate_notification_audio_profile(settings, NotificationAudioTone::Failure)?;
    Ok(())
}

fn validate_notification_audio_profile(
    settings: &AppSettings,
    tone: NotificationAudioTone,
) -> Result<(), String> {
    let (mode, default_sound, custom_path, field_prefix) =
        notification_audio_profile(settings, tone);

    match mode.trim() {
        "off" => Ok(()),
        "default" => {
            if builtin_notification_sound_file_name(default_sound).is_none() {
                Err(format!("{field_prefix}DefaultSound is not supported"))
            } else {
                Ok(())
            }
        }
        "custom" => validate_existing_file(custom_path, &format!("{field_prefix}CustomPath")),
        _ => Err(format!(
            "{field_prefix}Mode must be one of off, default, or custom"
        )),
    }
}

fn sanitize_uploaded_notification_audio_file_name(file_name: &str) -> Result<String, String> {
    let trimmed = file_name.trim();
    let base_name = Path::new(trimmed)
        .file_name()
        .and_then(|value| value.to_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "notificationAudio file name is invalid".to_string())?;

    Ok(base_name.to_string())
}

fn notification_audio_extension_from_name(file_name: &str) -> Result<String, String> {
    let extension = Path::new(file_name)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .ok_or_else(|| "notificationAudio file extension is required".to_string())?;

    if NOTIFICATION_AUDIO_EXTENSIONS.contains(&extension.as_str()) {
        Ok(extension)
    } else {
        Err("notificationAudio must be .aiff, .aif, .wav, .mp3, .m4a, or .caf".to_string())
    }
}

fn sanitize_notification_audio_file_stem(stem: &str) -> String {
    let cleaned: String = stem
        .chars()
        .map(|value| {
            if value.is_ascii_alphanumeric() {
                value.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();

    let trimmed = cleaned.trim_matches('-');
    if trimmed.is_empty() {
        "notification-audio".to_string()
    } else {
        trimmed.to_string()
    }
}

fn builtin_notification_sound_file_name(sound_id: &str) -> Option<&'static str> {
    BUILTIN_NOTIFICATION_SOUNDS
        .iter()
        .find_map(|(id, file_name)| (*id == sound_id.trim()).then_some(*file_name))
}

fn notification_audio_profile<'a>(
    settings: &'a AppSettings,
    tone: NotificationAudioTone,
) -> (&'a str, &'a str, &'a str, &'static str) {
    match tone {
        NotificationAudioTone::Success => (
            &settings.success_notification_audio_mode,
            &settings.success_notification_audio_default_sound,
            &settings.success_notification_audio_custom_path,
            "successNotificationAudio",
        ),
        NotificationAudioTone::Failure => (
            &settings.failure_notification_audio_mode,
            &settings.failure_notification_audio_default_sound,
            &settings.failure_notification_audio_custom_path,
            "failureNotificationAudio",
        ),
    }
}

fn resolve_notification_audio_path(
    settings: &AppSettings,
    tone: NotificationAudioTone,
) -> Option<PathBuf> {
    let (mode, default_sound, custom_path, _) = notification_audio_profile(settings, tone);

    match mode.trim() {
        "off" => None,
        "default" => builtin_notification_sound_file_name(default_sound)
            .map(|file_name| PathBuf::from("/System/Library/Sounds").join(file_name)),
        "custom" => {
            let path = PathBuf::from(custom_path.trim());
            (path.is_absolute() && path.is_file()).then_some(path)
        }
        _ => None,
    }
}

fn validate_hex_color(value: &str, field_name: &str) -> Result<(), String> {
    let trimmed = value.trim();
    let bytes = trimmed.as_bytes();

    if bytes.len() != 7 || bytes.first() != Some(&b'#') {
        return Err(format!("{field_name} must be a hex color like #RRGGBB"));
    }

    if !bytes[1..].iter().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!("{field_name} must be a hex color like #RRGGBB"));
    }

    Ok(())
}

fn parse_owner_ids(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn has_owner_ids(raw: &str) -> bool {
    !parse_owner_ids(raw).is_empty()
}

fn is_absolute_directory(path_value: &str) -> bool {
    let path = Path::new(path_value.trim());
    path.is_absolute() && path.is_dir()
}

/// Mirrors the sidecar's mini-og-root invariant from `sidecar/src/config.ts`:
/// every configured repo path must live under `mini_og_repo_root`. Without
/// this check the desktop's "Runtime Ready" can report green even though the
/// sidecar will hard-fail boot with `MiniOgRepoRootViolationError`.
fn repo_paths_under_miniog_root(settings: &AppSettings) -> bool {
    let root = Path::new(settings.mini_og_repo_root.trim());
    if !root.is_absolute() || !root.is_dir() {
        return false;
    }
    let canon_root = match root.canonicalize() {
        Ok(p) => p,
        Err(_) => return false,
    };
    let canon_under = |raw: &str| -> bool {
        let p = Path::new(raw.trim());
        match p.canonicalize() {
            Ok(canon) => canon.starts_with(&canon_root),
            Err(_) => false,
        }
    };
    canon_under(&settings.newton_web_path)
        && canon_under(&settings.newton_api_path)
        // Marketing repo is optional: blank disables it, so only enforce the
        // root invariant when a path is actually configured.
        && (settings.newton_marketing_web_path.trim().is_empty()
            || canon_under(&settings.newton_marketing_web_path))
}

fn is_settings_complete(settings: &AppSettings) -> bool {
    !settings.slack_bot_token.trim().is_empty()
        && !settings.slack_app_token.trim().is_empty()
        && !settings.bot_user_id.trim().is_empty()
        && has_owner_ids(&settings.owner_slack_user_ids)
        && is_absolute_directory(&settings.newton_web_path)
        && is_absolute_directory(&settings.newton_api_path)
        && repo_paths_under_miniog_root(settings)
}

fn settings_ready(db_path: &PathBuf) -> Result<bool, String> {
    let connection = Connection::open(db_path).map_err(|err| format!("db open failed: {err}"))?;
    let settings = read_app_settings(&connection)?;
    Ok(is_settings_complete(&settings))
}

fn setup_tray(app_handle: AppHandle) -> Result<(), String> {
    let loading = MenuItem::with_id(
        &app_handle,
        "stats_loading",
        "Loading Watchtower status...",
        false,
        None::<&str>,
    )
    .map_err(|err| format!("tray menu loading failed: {err}"))?;
    let separator = PredefinedMenuItem::separator(&app_handle)
        .map_err(|err| format!("tray menu separator failed: {err}"))?;
    let open = MenuItem::with_id(&app_handle, "open", "Open Watchtower", true, None::<&str>)
        .map_err(|err| format!("tray menu open failed: {err}"))?;
    let quit = MenuItem::with_id(&app_handle, "quit", "Quit", true, None::<&str>)
        .map_err(|err| format!("tray menu quit failed: {err}"))?;
    let menu = Menu::with_items(&app_handle, &[&loading, &separator, &open, &quit])
        .map_err(|err| format!("tray menu build failed: {err}"))?;

    TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .title("WT starting")
        .tooltip("Watchtower is starting")
        .icon_as_template(true)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "quit" => {
                shutdown_sidecar_for_exit(app);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                if let Some(window) = tray.app_handle().get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .build(&app_handle)
        .map_err(|err| format!("tray init failed: {err}"))?;

    Ok(())
}

async fn set_autostart_enabled(app: &AppHandle) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let autostart = app.autolaunch();
    if !autostart
        .is_enabled()
        .map_err(|err| format!("autostart status failed: {err}"))?
    {
        autostart
            .enable()
            .map_err(|err| format!("autostart enable failed: {err}"))?;
    }
    Ok(())
}

async fn start_sidecar_supervisor(
    app: AppHandle,
    db_path: PathBuf,
    status: SupervisorStatus,
    control: SupervisorControl,
) {
    let mut crash_window: VecDeque<Instant> = VecDeque::new();
    let mut restart_attempt = 0usize;

    loop {
        if control.is_shutdown_requested() {
            status.set("stopped (app shutdown)").await;
            break;
        }

        match settings_ready(&db_path) {
            Ok(true) => {}
            Ok(false) => {
                status
                    .set("waiting for settings (configure Watchtower > Settings)")
                    .await;
                if sleep_with_shutdown_check(&control, Duration::from_secs(5)).await {
                    status.set("stopped (app shutdown)").await;
                    break;
                }
                continue;
            }
            Err(err) => {
                status.set(format!("settings error ({err})")).await;
                if sleep_with_shutdown_check(&control, Duration::from_secs(5)).await {
                    status.set("stopped (app shutdown)").await;
                    break;
                }
                continue;
            }
        }

        let spawn_result = spawn_sidecar_once(&app, &db_path, &status, &control).await;
        if control.is_shutdown_requested() {
            status.set("stopped (app shutdown)").await;
            break;
        }
        match spawn_result {
            Ok(exit_code) => {
                status
                    .set(format!("stopped (exit code {})", exit_code.unwrap_or(-1)))
                    .await;
            }
            Err(err) => {
                status.set(format!("error ({err})")).await;
                emit_notification(
                    &app,
                    "Watchtower sidecar failed",
                    &format!("Sidecar process error: {err}"),
                    NotificationAudioTone::Failure,
                );
            }
        }

        // If this exit was an intentional restart (e.g. after a settings
        // save), skip crash-window accounting and backoff so the sidecar
        // comes back up immediately and legitimate settings saves are never
        // flagged as a crash loop.
        if control.consume_restart_request() {
            restart_attempt = 0;
            status.set("restarting to load new settings").await;
            continue;
        }

        let now = Instant::now();
        crash_window.push_back(now);
        while let Some(front) = crash_window.front() {
            if now.duration_since(*front) > Duration::from_secs(300) {
                let _ = crash_window.pop_front();
            } else {
                break;
            }
        }

        if crash_window.len() >= 5 {
            status.set("failed (crash loop)").await;
            emit_notification(
                &app,
                "Watchtower crash loop",
                "Sidecar exited repeatedly (5+ crashes in 5 minutes).",
                NotificationAudioTone::Failure,
            );
            if sleep_with_shutdown_check(&control, Duration::from_secs(60)).await {
                status.set("stopped (app shutdown)").await;
                break;
            }
        }

        restart_attempt += 1;
        let backoff_secs = match restart_attempt {
            0..=1 => 1,
            2 => 5,
            3 => 15,
            _ => 30,
        };
        status.set(format!("restarting in {}s", backoff_secs)).await;
        if sleep_with_shutdown_check(&control, Duration::from_secs(backoff_secs)).await {
            status.set("stopped (app shutdown)").await;
            break;
        }
    }
}

async fn spawn_sidecar_once(
    app: &AppHandle,
    db_path: &PathBuf,
    status: &SupervisorStatus,
    control: &SupervisorControl,
) -> Result<Option<i32>, String> {
    let sidecar_root = resolve_sidecar_root(app)?;
    let dist_entry = sidecar_root.join("dist/index.js");
    let src_entry = sidecar_root.join("src/index.ts");
    let node_bin = resolve_node_binary(&sidecar_root)?;
    let (entry, use_tsx) = if fs::metadata(&dist_entry).is_ok() {
        (dist_entry, false)
    } else {
        (src_entry, true)
    };

    status.set("starting").await;

    let mut command = Command::new(node_bin);
    if use_tsx {
        command.arg("--import").arg("tsx");
    }

    let mut child = command
        .arg(entry)
        .current_dir(sidecar_root)
        .env("WATCHTOWER_DB_PATH", db_path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("failed to spawn sidecar: {err}"))?;
    control.set_sidecar_pid(child.id());

    status.set("running").await;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    if let Some(stdout) = stdout {
        let app_clone = app.clone();
        spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                handle_sidecar_line(&app_clone, &line);
            }
        });
    }

    if let Some(stderr) = stderr {
        let app_clone = app.clone();
        spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = reader.next_line().await {
                handle_sidecar_line(&app_clone, &line);
            }
        });
    }

    let status_result = child.wait().await;
    control.clear_sidecar_pid();
    let status_result = status_result.map_err(|err| format!("failed waiting sidecar: {err}"))?;

    Ok(status_result.code())
}

fn shutdown_sidecar_for_exit(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        state.supervisor_control.request_shutdown();
        if let Err(err) = state.supervisor_control.terminate_sidecar() {
            eprintln!("failed to terminate sidecar during app exit: {err}");
        }
    }
}

async fn sleep_with_shutdown_check(control: &SupervisorControl, duration: Duration) -> bool {
    if duration.is_zero() {
        return control.is_shutdown_requested();
    }

    let mut remaining = duration;
    while remaining > Duration::from_secs(0) {
        if control.is_shutdown_requested() {
            return true;
        }

        let step = remaining.min(Duration::from_secs(1));
        tokio::time::sleep(step).await;
        remaining = remaining.saturating_sub(step);
    }
    control.is_shutdown_requested()
}

fn resolve_sidecar_root(app: &AppHandle) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("_up_").join("sidecar"));
        candidates.push(resource_dir.join("sidecar"));
    }

    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(contents_dir) = current_exe
            .parent()
            .and_then(|macos_dir| macos_dir.parent())
        {
            candidates.push(contents_dir.join("Resources").join("_up_").join("sidecar"));
            candidates.push(contents_dir.join("Resources").join("sidecar"));
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("..").join("sidecar"));
        candidates.push(cwd.join("sidecar"));
    }

    let manifest_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "failed to resolve cargo manifest parent".to_string())?;
    candidates.push(manifest_root.join("sidecar"));

    for candidate in candidates {
        if fs::metadata(candidate.join("dist/index.js")).is_ok()
            || fs::metadata(candidate.join("src/index.ts")).is_ok()
        {
            return Ok(candidate);
        }
    }

    Err("failed to resolve sidecar directory (checked bundled resources and local development paths)".to_string())
}

fn resolve_node_binary(sidecar_root: &Path) -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(override_node) = std::env::var("NODE_BIN") {
        let trimmed = override_node.trim();
        if !trimmed.is_empty() {
            let candidate = PathBuf::from(trimmed);
            if candidate.is_absolute() {
                candidates.push(candidate);
            } else if let Some(in_path) = find_in_path(trimmed) {
                candidates.push(in_path);
            }
        }
    }

    if let Some(in_path) = find_in_path("node") {
        candidates.push(in_path);
    }

    if let Ok(home) = std::env::var("HOME") {
        let nvm_root = PathBuf::from(home).join(".nvm/versions/node");
        candidates.extend(find_nvm_nodes_descending(&nvm_root));
    }

    let absolute_candidates = [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/opt/homebrew/opt/node/bin/node",
        "/usr/bin/node",
    ];
    for candidate in absolute_candidates {
        candidates.push(PathBuf::from(candidate));
    }

    let mut seen = std::collections::HashSet::new();
    let mut existing_candidates: Vec<PathBuf> = Vec::new();
    for candidate in candidates {
        if !seen.insert(candidate.clone()) {
            continue;
        }
        if fs::metadata(&candidate).is_ok() {
            existing_candidates.push(candidate);
        }
    }

    for candidate in &existing_candidates {
        if node_compatible_with_sidecar(candidate, sidecar_root) {
            return Ok(candidate.clone());
        }
    }

    if let Some(fallback) = existing_candidates.into_iter().next() {
        return Ok(fallback);
    }

    Err(
        "node runtime not found; install node or set NODE_BIN to an absolute node binary path"
            .to_string(),
    )
}

fn find_in_path(executable: &str) -> Option<PathBuf> {
    let path_env = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_env) {
        let full = dir.join(executable);
        if fs::metadata(&full).is_ok() {
            return Some(full);
        }
    }
    None
}

fn find_nvm_nodes_descending(root: &Path) -> Vec<PathBuf> {
    let mut versions: Vec<String> = match fs::read_dir(root) {
        Ok(entries) => entries
            .filter_map(|entry| entry.ok())
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| name.starts_with('v'))
            .collect(),
        Err(_) => return Vec::new(),
    };

    versions.sort();
    versions.reverse();

    let mut nodes = Vec::new();
    for version in versions {
        let candidate = root.join(version).join("bin/node");
        if fs::metadata(&candidate).is_ok() {
            nodes.push(candidate);
        }
    }

    nodes
}

fn node_compatible_with_sidecar(node_binary: &Path, sidecar_root: &Path) -> bool {
    let mut cmd = std::process::Command::new(node_binary);
    cmd.arg("-e").arg("try { const Database = require('better-sqlite3'); const db = new Database(':memory:'); db.prepare('select 1').get(); db.close(); process.exit(0); } catch (_) { process.exit(1); }");
    cmd.current_dir(sidecar_root)
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    cmd.status().map(|status| status.success()).unwrap_or(false)
}

fn handle_sidecar_line(app: &AppHandle, line: &str) {
    if let Some(payload) = line.strip_prefix("WATCHTOWER_NOTIFY::") {
        let parsed: serde_json::Value = serde_json::from_str(payload).unwrap_or_default();
        let title = parsed
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("Watchtower");
        let body = parsed
            .get("body")
            .and_then(|v| v.as_str())
            .unwrap_or("Event");
        let tone = match parsed.get("tone").and_then(|v| v.as_str()) {
            Some("success") => NotificationAudioTone::Success,
            _ => NotificationAudioTone::Failure,
        };
        emit_notification(app, title, body, tone);
        return;
    }

    let _ = app.emit("sidecar-log", line.to_string());
}

fn emit_notification(app: &AppHandle, title: &str, body: &str, tone: NotificationAudioTone) {
    emit_notification_with_settings(app, title, body, None, tone);
}

fn emit_notification_with_settings(
    app: &AppHandle,
    title: &str,
    body: &str,
    settings_override: Option<&AppSettings>,
    tone: NotificationAudioTone,
) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app.emit(
        "watchtower-notification",
        AppNotificationPayload {
            title: title.to_string(),
            body: body.to_string(),
            tone,
        },
    );
    let _ = app.notification().builder().title(title).body(body).show();
    play_notification_audio(app, settings_override, tone);
}

fn play_notification_audio(
    app: &AppHandle,
    settings_override: Option<&AppSettings>,
    tone: NotificationAudioTone,
) {
    let resolved_path = if let Some(settings) = settings_override {
        resolve_notification_audio_path(settings, tone)
    } else {
        load_notification_audio_settings(app)
            .ok()
            .and_then(|settings| resolve_notification_audio_path(&settings, tone))
    };
    let Some(path) = resolved_path else {
        return;
    };

    let _ = std::process::Command::new("afplay")
        .arg(path)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
}

fn load_notification_audio_settings(app: &AppHandle) -> Result<AppSettings, String> {
    let state = app.state::<AppState>();
    let connection =
        Connection::open(&*state.db_path).map_err(|err| format!("db open failed: {err}"))?;
    read_app_settings(&connection)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db_path() -> PathBuf {
        std::env::temp_dir().join(format!("watchtower-launchpad-{}.db", Uuid::new_v4()))
    }

    fn complete_settings() -> AppSettings {
        let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("repo root")
            .to_path_buf();

        AppSettings {
            slack_bot_token: "xoxb-test".to_string(),
            slack_app_token: "xapp-test".to_string(),
            owner_slack_user_ids: "UOWNER1,UOWNER2".to_string(),
            bot_user_id: "UBOT1".to_string(),
            bugs_and_updates_channel_id: "C01H25RNLJH".to_string(),
            newton_web_path: repo_root.to_string_lossy().into_owned(),
            newton_api_path: repo_root.to_string_lossy().into_owned(),
            ..AppSettings::default()
        }
    }

    #[test]
    fn submit_launchpad_task_rejects_blank_prompt() {
        let db_path = test_db_path();
        initialize_db(&db_path).expect("initialize db");
        let connection = Connection::open(&db_path).expect("open db");
        persist_app_settings(&connection, &complete_settings()).expect("persist settings");

        let err = submit_launchpad_task_inner(&connection, "miniog", "   ")
            .expect_err("blank prompt should fail");

        assert!(err.contains("must not be empty"));

        drop(connection);
        let _ = fs::remove_file(db_path);
    }

    #[test]
    fn submit_launchpad_task_rejects_incomplete_settings() {
        let db_path = test_db_path();
        initialize_db(&db_path).expect("initialize db");
        let connection = Connection::open(&db_path).expect("open db");

        let err = submit_launchpad_task_inner(&connection, "miniog", "Ship the task")
            .expect_err("incomplete settings should fail");

        assert!(err.contains("Runtime configuration is incomplete"));

        drop(connection);
        let _ = fs::remove_file(db_path);
    }

    #[test]
    fn submit_launchpad_task_inserts_pending_request_for_first_owner() {
        let db_path = test_db_path();
        initialize_db(&db_path).expect("initialize db");
        let connection = Connection::open(&db_path).expect("open db");
        persist_app_settings(&connection, &complete_settings()).expect("persist settings");

        let response = submit_launchpad_task_inner(&connection, "miniog", "Ship the feature")
            .expect("request should be created");

        let row = connection
            .query_row(
                "SELECT target, prompt, owner_user_id, status
                 FROM launchpad_requests
                 WHERE id = ?",
                params![response.request_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .expect("launchpad request row");

        assert_eq!(row.0, "miniog");
        assert_eq!(row.1, "Ship the feature");
        assert_eq!(row.2, "UOWNER1");
        assert_eq!(row.3, "PENDING");

        drop(connection);
        let _ = fs::remove_file(db_path);
    }

    #[test]
    fn app_settings_round_trip_access_control() {
        let db_path = test_db_path();
        initialize_db(&db_path).expect("initialize db");
        let connection = Connection::open(&db_path).expect("open db");

        let mut settings = complete_settings();
        settings.access_control.mode = "enforce".to_string();
        settings
            .access_control
            .groups
            .get_mut("viewer")
            .expect("viewer group")
            .allowed_channel_ids = "C-VIEW".to_string();
        settings
            .access_control
            .groups
            .get_mut("admin")
            .expect("admin group")
            .allow_im = true;
        settings
            .access_control
            .groups
            .get_mut("admin")
            .expect("admin group")
            .manual_user_ids = "UADMIN1,UADMIN2".to_string();

        persist_app_settings(&connection, &settings).expect("persist settings");
        let loaded = read_app_settings(&connection).expect("read settings");

        assert_eq!(loaded.access_control.mode, "enforce");
        assert_eq!(
            loaded
                .access_control
                .groups
                .get("viewer")
                .expect("viewer group")
                .allowed_channel_ids,
            "C-VIEW"
        );
        assert!(loaded
            .access_control
            .groups
            .get("admin")
            .expect("admin group")
            .allow_im);
        assert_eq!(
            loaded
                .access_control
                .groups
                .get("admin")
                .expect("admin group")
                .manual_user_ids,
            "UADMIN1,UADMIN2"
        );

        drop(connection);
        let _ = fs::remove_file(db_path);
    }

    #[test]
    fn initialize_db_creates_mini_og_repo_root_column_for_fresh_install() {
        // Regression for #279: read_app_settings selects mini_og_repo_root unconditionally,
        // so the column must exist before any caller reads app_settings on a fresh DB.
        let db_path = test_db_path();
        initialize_db(&db_path).expect("initialize db");
        let connection = Connection::open(&db_path).expect("open db");

        let settings = read_app_settings(&connection).expect("read settings");
        assert_eq!(settings.mini_og_repo_root, "/Users/dipesh/code/mini-og");

        drop(connection);
        let _ = fs::remove_file(db_path);
    }

    #[test]
    fn newton_marketing_web_path_fresh_install_and_persist_roundtrip() {
        // Same fresh-install hazard as mini_og_repo_root: read_app_settings selects the
        // column unconditionally, so it must exist before the first read. Also proves the
        // persist path carries the field (unlike watchtower_path, which Rust never saves).
        let db_path = test_db_path();
        initialize_db(&db_path).expect("initialize db");
        let connection = Connection::open(&db_path).expect("open db");

        let settings = read_app_settings(&connection).expect("read settings");
        assert_eq!(settings.newton_marketing_web_path, "");

        let mut updated = complete_settings();
        updated.newton_marketing_web_path =
            "/Users/dipesh/code/mini-og/newton-marketing-web".to_string();
        persist_app_settings(&connection, &updated).expect("persist settings");

        let reread = read_app_settings(&connection).expect("re-read settings");
        assert_eq!(
            reread.newton_marketing_web_path,
            "/Users/dipesh/code/mini-og/newton-marketing-web"
        );

        drop(connection);
        let _ = fs::remove_file(db_path);
    }

    #[test]
    fn initialize_db_seeds_access_control_from_legacy_fields() {
        let db_path = test_db_path();
        initialize_db(&db_path).expect("initialize db");
        let connection = Connection::open(&db_path).expect("open db");

        connection
            .execute(
                "UPDATE app_settings
                 SET bugs_and_updates_channel_id = ?,
                     core_dev_slack_user_ids = ?,
                     core_dev_slack_user_group = ?
                 WHERE id = 1",
                params!["C-BUGS,C-OPS", "UCOREDEV1", "core-dev"],
            )
            .expect("update legacy fields");
        connection
            .execute("DELETE FROM access_control_groups", [])
            .expect("clear access groups");

        ensure_access_control_seeded(&connection).expect("seed access control");
        let access = read_access_control_settings(&connection).expect("read access control");

        assert_eq!(access.mode, "audit");
        assert_eq!(
            access.groups.get("builder").expect("builder").allowed_channel_ids,
            "C-BUGS,C-OPS"
        );
        assert_eq!(
            access.groups.get("admin").expect("admin").slack_user_group_handle,
            "core-dev"
        );
        assert_eq!(
            access.groups.get("admin").expect("admin").manual_user_ids,
            "UCOREDEV1"
        );
        assert!(access.groups.get("admin").expect("admin").allow_im);

        drop(connection);
        let _ = fs::remove_file(db_path);
    }

    #[test]
    fn validate_notification_audio_settings_uses_success_and_failure_profiles() {
        let settings = AppSettings {
            success_notification_audio_mode: "default".to_string(),
            success_notification_audio_default_sound: "hero".to_string(),
            failure_notification_audio_mode: "default".to_string(),
            failure_notification_audio_default_sound: "submarine".to_string(),
            ..AppSettings::default()
        };

        validate_notification_audio_settings(&settings)
            .expect("tone-specific notification audio settings should validate");
    }

    #[test]
    fn resolve_notification_audio_path_reads_tone_specific_profile() {
        let settings = AppSettings {
            success_notification_audio_mode: "default".to_string(),
            success_notification_audio_default_sound: "hero".to_string(),
            failure_notification_audio_mode: "default".to_string(),
            failure_notification_audio_default_sound: "submarine".to_string(),
            ..AppSettings::default()
        };

        let success_path =
            resolve_notification_audio_path(&settings, NotificationAudioTone::Success)
                .expect("success audio path");
        let failure_path =
            resolve_notification_audio_path(&settings, NotificationAudioTone::Failure)
                .expect("failure audio path");

        assert!(success_path.ends_with("Hero.aiff"));
        assert!(failure_path.ends_with("Submarine.aiff"));
    }

    #[test]
    fn actionable_unknown_predicate_filters_social_chatter() {
        assert!(is_actionable_unknown_text("what did you learn"));
        assert!(is_actionable_unknown_text("don't you have access to github mcp"));
        assert!(!is_actionable_unknown_text("retire bro!! its ok"));
        assert!(!is_actionable_unknown_text("who is your master"));
    }

    #[test]
    fn recommendations_apply_intent_gap_threshold_on_actionable_unknowns() {
        let mut metrics = DashboardMetrics {
            runs_24h: 12,
            success_rate_24h: 91.6,
            failed_runs_24h: 0,
            avg_resolution_seconds_24h: 120,
            unknown_tasks_24h: 3,
            catchup_recovered_24h: 0,
            access_audit_would_deny_24h: 0,
            success_streak: 2,
            chaos_index: 6,
            cost_24h_usd: 0.0,
            tokens_input_24h: 0,
            tokens_output_24h: 0,
            cache_read_tokens_24h: 0,
            cache_hit_rate_24h: 0.0,
            avg_cost_per_run_usd: 0.0,
        };

        let below_threshold = build_recommendations(&metrics, &[]);
        assert!(!below_threshold.iter().any(|item| item.id == "intent-gap"));

        metrics.unknown_tasks_24h = 4;
        let at_threshold = build_recommendations(&metrics, &[]);
        assert!(at_threshold.iter().any(|item| item.id == "intent-gap"));
    }

    #[test]
    fn recommendations_choose_hotspot_by_failure_pressure_not_run_volume() {
        let metrics = DashboardMetrics {
            runs_24h: 30,
            success_rate_24h: 90.0,
            failed_runs_24h: 1,
            avg_resolution_seconds_24h: 140,
            unknown_tasks_24h: 0,
            catchup_recovered_24h: 0,
            access_audit_would_deny_24h: 0,
            success_streak: 1,
            chaos_index: 8,
            cost_24h_usd: 0.0,
            tokens_input_24h: 0,
            tokens_output_24h: 0,
            cache_read_tokens_24h: 0,
            cache_hit_rate_24h: 0.0,
            avg_cost_per_run_usd: 0.0,
        };
        let channel_heat = vec![
            ChannelHeat {
                channel_id: "C-HIGH-RUNS".to_string(),
                runs: 100,
                failures: 2,
            },
            ChannelHeat {
                channel_id: "C-HIGH-FAILURES".to_string(),
                runs: 24,
                failures: 7,
            },
        ];

        let recommendations = build_recommendations(&metrics, &channel_heat);
        let hotspot = recommendations
            .iter()
            .find(|item| item.id == "channel-hotspot")
            .expect("channel hotspot recommendation should exist");

        assert!(hotspot.detail.contains("C-HIGH-FAILURES"));
        assert!(hotspot.detail.contains("7 failures"));
    }

    #[test]
    fn recommendations_surface_access_audit_warning() {
        let metrics = DashboardMetrics {
            runs_24h: 8,
            success_rate_24h: 100.0,
            failed_runs_24h: 0,
            avg_resolution_seconds_24h: 80,
            unknown_tasks_24h: 0,
            catchup_recovered_24h: 0,
            access_audit_would_deny_24h: 3,
            success_streak: 4,
            chaos_index: 3,
            cost_24h_usd: 0.0,
            tokens_input_24h: 0,
            tokens_output_24h: 0,
            cache_read_tokens_24h: 0,
            cache_hit_rate_24h: 0.0,
            avg_cost_per_run_usd: 0.0,
        };

        let recommendations = build_recommendations(&metrics, &[]);
        let access_audit = recommendations
            .iter()
            .find(|item| item.id == "access-audit")
            .expect("access audit recommendation should exist");

        assert!(access_audit.detail.contains("3 request(s)"));
    }
}
