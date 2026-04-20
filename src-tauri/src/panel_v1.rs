use chrono::Local;
use dirs::home_dir;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering as AtomicOrdering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Instant;
use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuEvent, SubmenuBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};

const EVENT_REFRESH_REQUESTED: &str = "panel://refresh-requested";
const TRAY_ID: &str = "main-tray";

#[derive(Clone, Default)]
pub struct PanelRuntime {
    inner: Arc<PanelRuntimeInner>,
}

#[derive(Default)]
struct PanelRuntimeInner {
    tasks: Mutex<BTreeMap<String, TaskProgress>>,
    counter: AtomicU64,
    exit_requested: AtomicBool,
}

impl PanelRuntime {
    fn next_task_id(&self) -> String {
        let next = self.inner.counter.fetch_add(1, AtomicOrdering::SeqCst) + 1;
        format!("task-{}-{next}", Local::now().format("%Y%m%d%H%M%S"))
    }

    fn set_task(&self, task: TaskProgress) {
        if let Ok(mut tasks) = self.inner.tasks.lock() {
            tasks.insert(task.task_id.clone(), task);
        }
    }

    fn get_task(&self, task_id: &str) -> Option<TaskProgress> {
        self.inner
            .tasks
            .lock()
            .ok()
            .and_then(|tasks| tasks.get(task_id).cloned())
    }

    fn set_exit_requested(&self, requested: bool) {
        self.inner
            .exit_requested
            .store(requested, AtomicOrdering::SeqCst);
    }

    fn exit_requested(&self) -> bool {
        self.inner.exit_requested.load(AtomicOrdering::SeqCst)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartTaskRequest {
    pub task_type: String,
    pub issue_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStep {
    pub id: String,
    pub label: String,
    pub status: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskProgress {
    pub task_id: String,
    pub task_type: String,
    pub status: String,
    pub percent: u8,
    pub current_step: String,
    pub summary: String,
    pub retryable: bool,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub steps: Vec<TaskStep>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PanelStore {
    settings: PanelSettings,
    model_configs: Vec<ModelConfig>,
    active_model_config_id: Option<String>,
    profile_model_links: BTreeMap<String, String>,
    last_diagnosis: Option<DiagnosisSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelSettings {
    language: String,
    launch_at_startup: bool,
    close_to_tray: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelConfig {
    id: String,
    name: String,
    provider: String,
    model: String,
    api_key: String,
    base_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosisSnapshot {
    generated_at: String,
    issues: Vec<DetectedIssue>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStateSnapshot {
    generated_at: String,
    settings: PanelSettings,
    overview: OverviewSummary,
    recent_issues: Vec<DetectedIssue>,
    about: AboutInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OverviewSummary {
    hermes_installed: bool,
    hermes_version: String,
    gateway_healthy: bool,
    gateway_summary: String,
    current_identity: String,
    current_model: String,
    issue_count: usize,
    repairable_issue_count: usize,
    session_count: usize,
    last_diagnosis_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusPageSnapshot {
    generated_at: String,
    checks: Vec<StatusCheck>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairPageSnapshot {
    generated_at: String,
    issues: Vec<DetectedIssue>,
    repairable_issue_count: usize,
    last_diagnosis_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelsPageSnapshot {
    generated_at: String,
    model_configs: Vec<ModelConfigSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfilesPageSnapshot {
    generated_at: String,
    model_configs: Vec<ModelConfigSummary>,
    identities: Vec<IdentitySummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPageSnapshot {
    generated_at: String,
    sessions: Vec<super::SessionSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusCheck {
    id: String,
    status: String,
    detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedIssue {
    id: String,
    severity: String,
    repairable: bool,
    repair_action: String,
    target_page: Option<String>,
    detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelConfigSummary {
    id: String,
    name: String,
    provider: String,
    model: String,
    api_key: String,
    base_url: String,
    is_active: bool,
    attached_profiles: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdentitySummary {
    name: String,
    current: bool,
    path: String,
    linked_model_config_id: Option<String>,
    linked_model_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AboutInfo {
    app_version: String,
    platform: String,
    arch: String,
    hermes_path: String,
    hermes_home: String,
    panel_home: String,
    updater_status: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelConfigInput {
    id: Option<String>,
    name: String,
    provider: String,
    model: String,
    api_key: String,
    base_url: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PanelSettingsInput {
    language: String,
    launch_at_startup: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficialUpdateSnapshot {
    current_installed: bool,
    current_version: String,
    current_release_date: String,
    latest_version: String,
    latest_release_date: String,
    release_url: String,
    update_available: bool,
    checked_at: String,
}

#[derive(Debug, Clone, Default)]
struct InstalledVersionSnapshot {
    version: Option<String>,
    release_date: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GithubLatestRelease {
    tag_name: String,
    published_at: String,
    html_url: String,
}

struct TaskContext {
    app: AppHandle,
    runtime: PanelRuntime,
    task: TaskProgress,
}

impl TaskContext {
    fn new(app: AppHandle, runtime: PanelRuntime, task_id: String, task_type: String) -> Self {
        let task = TaskProgress {
            task_id,
            task_type,
            status: "queued".to_string(),
            percent: 0,
            current_step: String::new(),
            summary: String::new(),
            retryable: false,
            started_at: super::now_string(),
            finished_at: None,
            steps: Vec::new(),
        };

        let context = Self { app, runtime, task };
        context.publish();
        context
    }

    fn publish(&self) {
        self.runtime.set_task(self.task.clone());
    }

    fn begin_step(&mut self, id: &str, label: &str, percent: u8) {
        self.task.status = "running".to_string();
        self.task.current_step = label.to_string();
        self.task.percent = percent;
        self.task.steps.push(TaskStep {
            id: id.to_string(),
            label: label.to_string(),
            status: "running".to_string(),
            detail: String::new(),
        });
        self.publish();
    }

    fn finish_step(&mut self, detail: impl Into<String>) {
        if let Some(step) = self.task.steps.last_mut() {
            step.status = "success".to_string();
            step.detail = detail.into();
        }
        self.publish();
    }

    fn fail_step(&mut self, detail: impl Into<String>) {
        if let Some(step) = self.task.steps.last_mut() {
            step.status = "failed".to_string();
            step.detail = detail.into();
        }
        self.publish();
    }

    fn complete(&mut self, status: &str, summary: impl Into<String>, retryable: bool, percent: u8) {
        self.task.status = status.to_string();
        self.task.summary = summary.into();
        self.task.retryable = retryable;
        self.task.percent = percent;
        self.task.finished_at = Some(super::now_string());
        self.publish();
    }
}

#[tauri::command]
pub fn load_app_state(app: tauri::AppHandle) -> Result<AppStateSnapshot, String> {
    build_light_app_state_snapshot(&app)
}

#[tauri::command]
pub async fn hydrate_app_state(app: tauri::AppHandle) -> Result<AppStateSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let snapshot = build_app_state_snapshot(&app)?;
        let _ = refresh_tray_menu(&app);
        Ok(snapshot)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn load_status_page() -> Result<StatusPageSnapshot, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let dashboard = super::build_dashboard_quick()?;
        Ok(StatusPageSnapshot {
            generated_at: super::now_string(),
            checks: build_status_checks(&dashboard),
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn load_repair_page() -> Result<RepairPageSnapshot, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let store = load_panel_store_or_default();
        let diagnosis = store.last_diagnosis.as_ref();
        let issues = diagnosis
            .map(|snapshot| snapshot.issues.clone())
            .unwrap_or_default();

        Ok(RepairPageSnapshot {
            generated_at: super::now_string(),
            repairable_issue_count: issues.iter().filter(|issue| issue.repairable).count(),
            last_diagnosis_at: diagnosis
                .map(|snapshot| snapshot.generated_at.clone())
                .unwrap_or_default(),
            issues,
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn load_models_page() -> Result<ModelsPageSnapshot, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let dashboard = super::build_dashboard_light()?;
        let store = load_or_seed_store(&dashboard)?;
        Ok(ModelsPageSnapshot {
            generated_at: super::now_string(),
            model_configs: build_model_summaries(&store),
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn load_profiles_page() -> Result<ProfilesPageSnapshot, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let dashboard = super::build_dashboard_profile_aware()?;
        let store = load_or_seed_store(&dashboard)?;
        Ok(ProfilesPageSnapshot {
            generated_at: super::now_string(),
            model_configs: build_model_summaries(&store),
            identities: build_identity_summaries(&dashboard, &store),
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn load_history_page() -> Result<HistoryPageSnapshot, String> {
    tauri::async_runtime::spawn_blocking(|| {
        Ok(HistoryPageSnapshot {
            generated_at: super::now_string(),
            sessions: super::load_session_summaries(),
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn check_official_update() -> Result<OfficialUpdateSnapshot, String> {
    tauri::async_runtime::spawn_blocking(check_official_update_sync)
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn get_task_status(
    task_id: String,
    runtime: State<'_, PanelRuntime>,
) -> Result<TaskProgress, String> {
    runtime
        .get_task(task_id.trim())
        .ok_or_else(|| "未找到对应任务。".to_string())
}

#[tauri::command]
pub fn start_task(
    app: tauri::AppHandle,
    runtime: State<'_, PanelRuntime>,
    request: StartTaskRequest,
) -> Result<TaskProgress, String> {
    let runtime = runtime.inner().clone();
    let task = spawn_task(app, runtime, request)?;
    Ok(task)
}

#[tauri::command]
pub fn save_panel_settings(
    app: tauri::AppHandle,
    input: PanelSettingsInput,
) -> Result<AppStateSnapshot, String> {
    let mut store = load_panel_store().unwrap_or_else(|_| default_panel_store());
    store.settings.language = normalize_language(&input.language);
    store.settings.launch_at_startup = input.launch_at_startup;
    save_panel_store(&store)?;
    sync_autostart(&app, store.settings.launch_at_startup)?;
    refresh_tray_menu(&app)?;
    mutation_response(&app)
}

#[tauri::command]
pub fn save_model_config(
    app: tauri::AppHandle,
    input: ModelConfigInput,
) -> Result<AppStateSnapshot, String> {
    let mut store = load_panel_store().unwrap_or_else(|_| default_panel_store());
    let normalized = normalize_model_input(input)?;
    let mut updated_existing = false;

    if let Some(existing_id) = normalized.id.as_ref() {
        for model in &mut store.model_configs {
            if model.id == *existing_id {
                model.name = normalized.name.clone();
                model.provider = normalized.provider.clone();
                model.model = normalized.model.clone();
                model.api_key = normalized.api_key.clone();
                model.base_url = normalized.base_url.clone();
                updated_existing = true;
            }
        }
    }

    if !updated_existing {
        store.model_configs.push(ModelConfig {
            id: normalized
                .id
                .clone()
                .unwrap_or_else(|| unique_id("model-config")),
            name: normalized.name.clone(),
            provider: normalized.provider.clone(),
            model: normalized.model.clone(),
            api_key: normalized.api_key.clone(),
            base_url: normalized.base_url.clone(),
        });
    }

    if store.active_model_config_id.is_none() {
        store.active_model_config_id = store.model_configs.first().map(|model| model.id.clone());
    }

    store.last_diagnosis = None;
    save_panel_store(&store)?;
    refresh_tray_menu(&app)?;
    mutation_response(&app)
}

#[tauri::command]
pub fn activate_model_config(
    app: tauri::AppHandle,
    model_id: String,
) -> Result<AppStateSnapshot, String> {
    let dashboard = super::build_dashboard_profile_aware()?;
    let mut store = load_or_seed_store(&dashboard)?;
    let model_id = model_id.trim();
    let model = store
        .model_configs
        .iter()
        .find(|item| item.id == model_id)
        .cloned()
        .ok_or_else(|| "未找到指定模型配置。".to_string())?;

    apply_model_config_internal(&model)?;
    store.active_model_config_id = Some(model.id.clone());

    if let Some(current_profile) = dashboard.profiles.iter().find(|profile| profile.current) {
        store
            .profile_model_links
            .insert(current_profile.name.clone(), model.id.clone());
    }

    store.last_diagnosis = None;
    save_panel_store(&store)?;
    refresh_tray_menu(&app)?;
    mutation_response(&app)
}

#[tauri::command]
pub fn delete_model_config(
    app: tauri::AppHandle,
    model_id: String,
) -> Result<AppStateSnapshot, String> {
    let mut store = load_panel_store().unwrap_or_else(|_| default_panel_store());
    let model_id = model_id.trim();

    store.model_configs.retain(|model| model.id != model_id);
    store
        .profile_model_links
        .retain(|_, linked_id| linked_id != model_id);

    if store.active_model_config_id.as_deref() == Some(model_id) {
        store.active_model_config_id = store.model_configs.first().map(|item| item.id.clone());
    }

    if let Some(next_active) = store.active_model_config_id.clone() {
        if let Some(model) = store
            .model_configs
            .iter()
            .find(|item| item.id == next_active)
            .cloned()
        {
            apply_model_config_internal(&model)?;
        }
    }

    store.last_diagnosis = None;
    save_panel_store(&store)?;
    refresh_tray_menu(&app)?;
    mutation_response(&app)
}

#[tauri::command]
pub fn save_profile_model_binding(
    app: tauri::AppHandle,
    profile_name: String,
    model_config_id: Option<String>,
) -> Result<AppStateSnapshot, String> {
    let dashboard = super::build_dashboard_profile_aware()?;
    let mut store = load_or_seed_store(&dashboard)?;
    let profile_name = profile_name.trim();

    if profile_name.is_empty() {
        return Err("身份名称不能为空。".to_string());
    }

    if let Some(model_id) = model_config_id
        .as_deref()
        .and_then(trimmed_nonempty)
        .map(ToString::to_string)
    {
        let model = store
            .model_configs
            .iter()
            .find(|item| item.id == model_id)
            .cloned()
            .ok_or_else(|| "未找到要绑定的模型配置。".to_string())?;

        store
            .profile_model_links
            .insert(profile_name.to_string(), model.id.clone());

        if dashboard
            .profiles
            .iter()
            .any(|profile| profile.current && profile.name == profile_name)
        {
            apply_model_config_internal(&model)?;
            store.active_model_config_id = Some(model.id.clone());
        }
    } else {
        store.profile_model_links.remove(profile_name);
    }

    store.last_diagnosis = None;
    save_panel_store(&store)?;
    refresh_tray_menu(&app)?;
    mutation_response(&app)
}

#[tauri::command]
pub fn create_identity(
    app: tauri::AppHandle,
    name: String,
    linked_model_config_id: Option<String>,
) -> Result<AppStateSnapshot, String> {
    let trimmed = name.trim();
    if !super::is_profile_name(trimmed) {
        return Err("身份名称不合法，只允许字母、数字、- 和 _。".to_string());
    }

    let result = super::run_hermes_command(
        "创建身份",
        vec![
            "profile".to_string(),
            "create".to_string(),
            trimmed.to_string(),
        ],
        true,
    )?;
    ensure_result_success(&result)?;

    let dashboard = super::build_dashboard_profile_aware()?;
    let mut store = load_or_seed_store(&dashboard)?;
    if let Some(model_id) = linked_model_config_id
        .as_deref()
        .and_then(trimmed_nonempty)
        .map(ToString::to_string)
    {
        store
            .profile_model_links
            .insert(trimmed.to_string(), model_id);
    }

    store.last_diagnosis = None;
    save_panel_store(&store)?;
    refresh_tray_menu(&app)?;
    mutation_response(&app)
}

#[tauri::command]
pub fn switch_identity(app: tauri::AppHandle, name: String) -> Result<AppStateSnapshot, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("身份名称不能为空。".to_string());
    }

    let result = super::run_hermes_command(
        "切换身份",
        super::owned_args(&["profile", "use", trimmed]),
        true,
    )?;
    ensure_result_success(&result)?;

    let dashboard = super::build_dashboard_profile_aware()?;
    let mut store = load_or_seed_store(&dashboard)?;
    if let Some(model_id) = store.profile_model_links.get(trimmed).cloned() {
        if let Some(model) = store
            .model_configs
            .iter()
            .find(|item| item.id == model_id)
            .cloned()
        {
            apply_model_config_internal(&model)?;
            store.active_model_config_id = Some(model.id);
        }
    }

    store.last_diagnosis = None;
    save_panel_store(&store)?;
    refresh_tray_menu(&app)?;
    mutation_response(&app)
}

#[tauri::command]
pub fn rename_identity(
    app: tauri::AppHandle,
    old_name: String,
    new_name: String,
) -> Result<AppStateSnapshot, String> {
    let old_name = old_name.trim();
    let new_name = new_name.trim();
    if old_name.is_empty() || !super::is_profile_name(new_name) {
        return Err("身份名称不合法。".to_string());
    }

    let result = super::run_hermes_command(
        "重命名身份",
        super::owned_args(&["profile", "rename", old_name, new_name]),
        true,
    )?;
    ensure_result_success(&result)?;

    let dashboard = super::build_dashboard_profile_aware()?;
    let mut store = load_or_seed_store(&dashboard)?;
    if let Some(model_id) = store.profile_model_links.remove(old_name) {
        store
            .profile_model_links
            .insert(new_name.to_string(), model_id);
    }

    store.last_diagnosis = None;
    save_panel_store(&store)?;
    refresh_tray_menu(&app)?;
    mutation_response(&app)
}

#[tauri::command]
pub fn delete_identity(app: tauri::AppHandle, name: String) -> Result<AppStateSnapshot, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("身份名称不能为空。".to_string());
    }

    let result = super::run_hermes_command(
        "删除身份",
        super::owned_args(&["profile", "delete", trimmed, "--yes"]),
        true,
    )?;
    ensure_result_success(&result)?;

    let dashboard = super::build_dashboard_profile_aware()?;
    let mut store = load_or_seed_store(&dashboard)?;
    store.profile_model_links.remove(trimmed);
    store.last_diagnosis = None;
    save_panel_store(&store)?;
    refresh_tray_menu(&app)?;
    mutation_response(&app)
}

#[tauri::command]
pub fn import_identity(
    app: tauri::AppHandle,
    archive_path: String,
    profile_name: String,
    linked_model_config_id: Option<String>,
) -> Result<AppStateSnapshot, String> {
    let archive_path = archive_path.trim();
    if archive_path.is_empty() {
        return Err("归档路径不能为空。".to_string());
    }

    let mut args = vec![
        "profile".to_string(),
        "import".to_string(),
        archive_path.to_string(),
    ];
    if let Some(name) = trimmed_nonempty(&profile_name) {
        args.push("--name".to_string());
        args.push(name.to_string());
    }

    let result = super::run_hermes_command("导入身份", args, true)?;
    ensure_result_success(&result)?;

    let dashboard = super::build_dashboard_profile_aware()?;
    let mut store = load_or_seed_store(&dashboard)?;
    if let Some(imported_name) = trimmed_nonempty(&profile_name) {
        if let Some(model_id) = linked_model_config_id
            .as_deref()
            .and_then(trimmed_nonempty)
            .map(ToString::to_string)
        {
            store
                .profile_model_links
                .insert(imported_name.to_string(), model_id);
        }
    }

    store.last_diagnosis = None;
    save_panel_store(&store)?;
    refresh_tray_menu(&app)?;
    mutation_response(&app)
}

#[tauri::command]
pub fn export_identity(name: String, output_path: String) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("身份名称不能为空。".to_string());
    }

    let final_output = if output_path.trim().is_empty() {
        super::default_profile_export_path(name)
    } else {
        PathBuf::from(output_path.trim())
    };
    super::ensure_parent(&final_output)?;

    let args = vec![
        "profile".to_string(),
        "export".to_string(),
        name.to_string(),
        "-o".to_string(),
        final_output.to_string_lossy().to_string(),
    ];

    let result = super::run_hermes_command("导出身份", args, false)?;
    ensure_result_success(&result)?;
    Ok(final_output.to_string_lossy().to_string())
}

pub fn setup(app: &mut tauri::App) -> tauri::Result<()> {
    let store = load_panel_store().unwrap_or_else(|_| default_panel_store());
    let _ = sync_autostart(app.handle(), store.settings.launch_at_startup);
    let _ = refresh_tray_menu(app.handle());
    Ok(())
}

pub fn handle_run_event(app: &AppHandle, event: &RunEvent) {
    if let RunEvent::WindowEvent { label, event, .. } = event {
        if label == "main" {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let runtime = app.state::<PanelRuntime>();
                if !runtime.exit_requested() && close_to_tray_enabled() {
                    api.prevent_close();
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.hide();
                    }
                }
            }
        }
    }
}

fn build_app_state_snapshot(app: &AppHandle) -> Result<AppStateSnapshot, String> {
    let dashboard = super::build_dashboard_quick()?;
    build_app_state_snapshot_from_dashboard(app, dashboard)
}

fn build_light_app_state_snapshot(app: &AppHandle) -> Result<AppStateSnapshot, String> {
    let dashboard = super::build_dashboard_light()?;
    build_app_state_snapshot_from_dashboard(app, dashboard)
}

fn build_app_state_snapshot_from_dashboard(
    app: &AppHandle,
    dashboard: super::DashboardSnapshot,
) -> Result<AppStateSnapshot, String> {
    let store = load_or_seed_store(&dashboard)?;
    let issues = store
        .last_diagnosis
        .as_ref()
        .map(|diagnosis| diagnosis.issues.clone())
        .unwrap_or_default();
    let current_profile = dashboard
        .profiles
        .iter()
        .find(|profile| profile.current)
        .map(|profile| profile.name.clone())
        .unwrap_or_else(|| "-".to_string());
    let active_model = store
        .active_model_config_id
        .as_ref()
        .and_then(|active_id| {
            store
                .model_configs
                .iter()
                .find(|model| &model.id == active_id)
        })
        .map(|model| model.name.clone())
        .or_else(|| store.model_configs.first().map(|model| model.name.clone()))
        .unwrap_or_else(|| {
            if dashboard.files.basic.model.trim().is_empty() {
                "-".to_string()
            } else {
                dashboard.files.basic.model.clone()
            }
        });

    Ok(AppStateSnapshot {
        generated_at: super::now_string(),
        settings: store.settings.clone(),
        overview: OverviewSummary {
            hermes_installed: dashboard.hermes.installed,
            hermes_version: dashboard.hermes.version.clone(),
            gateway_healthy: super::gateway_available(&dashboard.hermes.gateway_summary),
            gateway_summary: super::first_nonempty_line(&dashboard.hermes.gateway_summary),
            current_identity: current_profile,
            current_model: active_model,
            issue_count: issues.len(),
            repairable_issue_count: issues.iter().filter(|issue| issue.repairable).count(),
            session_count: 0,
            last_diagnosis_at: store
                .last_diagnosis
                .as_ref()
                .map(|diagnosis| diagnosis.generated_at.clone())
                .unwrap_or_default(),
        },
        recent_issues: issues.into_iter().take(4).collect(),
        about: AboutInfo {
            app_version: app.package_info().version.to_string(),
            platform: dashboard.platform.clone(),
            arch: dashboard.arch.clone(),
            hermes_path: dashboard.hermes.path.clone(),
            hermes_home: dashboard.paths.hermes_home.clone(),
            panel_home: super::panel_home().to_string_lossy().to_string(),
            updater_status: localized(
                &store.settings.language,
                "已预留自动更新入口，待发布链路接入。",
                "Auto update entry is reserved and will be wired during release setup.",
            ),
        },
    })
}

fn mutation_response(app: &AppHandle) -> Result<AppStateSnapshot, String> {
    build_light_app_state_snapshot(app)
}

fn build_status_checks(dashboard: &super::DashboardSnapshot) -> Vec<StatusCheck> {
    let basic = &dashboard.files.basic;
    let current_profile = dashboard.profiles.iter().find(|profile| profile.current);
    let config_exists = Path::new(&dashboard.files.config_path).exists();
    let env_exists = Path::new(&dashboard.files.env_path).exists();
    let state_db = Path::new(&dashboard.paths.state_db).exists();
    let sessions_dir = Path::new(&dashboard.paths.sessions_dir).exists();
    let logs_dir = Path::new(&dashboard.paths.logs_dir).exists();

    vec![
        StatusCheck {
            id: "hermes_installed".to_string(),
            status: if dashboard.hermes.installed {
                "ok".to_string()
            } else {
                "error".to_string()
            },
            detail: if dashboard.hermes.installed {
                dashboard.hermes.path.clone()
            } else {
                dashboard.hermes.status_summary.clone()
            },
        },
        StatusCheck {
            id: "hermes_version".to_string(),
            status: if dashboard.hermes.installed {
                "ok".to_string()
            } else {
                "info".to_string()
            },
            detail: dashboard.hermes.version.clone(),
        },
        StatusCheck {
            id: "model_configured".to_string(),
            status: if basic.model.trim().is_empty() {
                "warning".to_string()
            } else {
                "ok".to_string()
            },
            detail: if basic.model.trim().is_empty() {
                "未配置默认模型。".to_string()
            } else {
                basic.model.clone()
            },
        },
        StatusCheck {
            id: "provider_key_configured".to_string(),
            status: if super::has_provider_key(basic) {
                "ok".to_string()
            } else {
                "warning".to_string()
            },
            detail: super::provider_detail(basic),
        },
        StatusCheck {
            id: "gateway_available".to_string(),
            status: if super::gateway_available(&dashboard.hermes.gateway_summary) {
                "ok".to_string()
            } else {
                "warning".to_string()
            },
            detail: super::first_nonempty_line(&dashboard.hermes.gateway_summary),
        },
        StatusCheck {
            id: "config_file".to_string(),
            status: if config_exists {
                "ok".to_string()
            } else {
                "warning".to_string()
            },
            detail: dashboard.files.config_path.clone(),
        },
        StatusCheck {
            id: "env_file".to_string(),
            status: if env_exists {
                "ok".to_string()
            } else {
                "warning".to_string()
            },
            detail: dashboard.files.env_path.clone(),
        },
        StatusCheck {
            id: "state_db".to_string(),
            status: if state_db {
                "ok".to_string()
            } else {
                "info".to_string()
            },
            detail: dashboard.paths.state_db.clone(),
        },
        StatusCheck {
            id: "sessions_dir".to_string(),
            status: if sessions_dir {
                "ok".to_string()
            } else {
                "info".to_string()
            },
            detail: dashboard.paths.sessions_dir.clone(),
        },
        StatusCheck {
            id: "logs_dir".to_string(),
            status: if logs_dir {
                "ok".to_string()
            } else {
                "info".to_string()
            },
            detail: dashboard.paths.logs_dir.clone(),
        },
        StatusCheck {
            id: "active_profile".to_string(),
            status: if current_profile.is_some() {
                "ok".to_string()
            } else {
                "warning".to_string()
            },
            detail: current_profile
                .map(|profile| profile.name.clone())
                .unwrap_or_else(|| "未识别到当前身份。".to_string()),
        },
    ]
}

fn build_model_summaries(store: &PanelStore) -> Vec<ModelConfigSummary> {
    let mut summaries = store
        .model_configs
        .iter()
        .map(|model| ModelConfigSummary {
            id: model.id.clone(),
            name: model.name.clone(),
            provider: model.provider.clone(),
            model: model.model.clone(),
            api_key: model.api_key.clone(),
            base_url: model.base_url.clone(),
            is_active: store.active_model_config_id.as_deref() == Some(model.id.as_str()),
            attached_profiles: store
                .profile_model_links
                .iter()
                .filter_map(|(profile, linked_id)| {
                    if linked_id == &model.id {
                        Some(profile.clone())
                    } else {
                        None
                    }
                })
                .collect(),
        })
        .collect::<Vec<_>>();

    summaries.sort_by(|left, right| {
        right
            .is_active
            .cmp(&left.is_active)
            .then(left.name.cmp(&right.name))
    });
    summaries
}

fn build_identity_summaries(
    dashboard: &super::DashboardSnapshot,
    store: &PanelStore,
) -> Vec<IdentitySummary> {
    let mut summaries = dashboard
        .profiles
        .iter()
        .map(|profile| {
            let linked_model_config_id = store.profile_model_links.get(&profile.name).cloned();
            let linked_model_name = linked_model_config_id
                .as_ref()
                .and_then(|model_id| store.model_configs.iter().find(|item| &item.id == model_id))
                .map(|model| model.name.clone())
                .unwrap_or_else(|| "-".to_string());

            IdentitySummary {
                name: profile.name.clone(),
                current: profile.current,
                path: profile.path.clone(),
                linked_model_config_id,
                linked_model_name,
            }
        })
        .collect::<Vec<_>>();

    summaries.sort_by(|left, right| {
        right
            .current
            .cmp(&left.current)
            .then(left.name.cmp(&right.name))
    });
    summaries
}

fn detect_issues(dashboard: &super::DashboardSnapshot) -> Vec<DetectedIssue> {
    let basic = &dashboard.files.basic;
    let mut issues = Vec::new();

    if !dashboard.hermes.installed {
        issues.push(DetectedIssue {
            id: "hermes_missing".to_string(),
            severity: "high".to_string(),
            repairable: true,
            repair_action: "install_official".to_string(),
            target_page: Some("install".to_string()),
            detail: dashboard.hermes.status_summary.clone(),
        });
    }

    if basic.model.trim().is_empty() {
        issues.push(DetectedIssue {
            id: "model_missing".to_string(),
            severity: "medium".to_string(),
            repairable: false,
            repair_action: String::new(),
            target_page: Some("models".to_string()),
            detail: "尚未配置默认模型。".to_string(),
        });
    }

    if !super::has_provider_key(basic) {
        issues.push(DetectedIssue {
            id: "provider_missing".to_string(),
            severity: "medium".to_string(),
            repairable: false,
            repair_action: String::new(),
            target_page: Some("models".to_string()),
            detail: "缺少 Provider Key。".to_string(),
        });
    }

    if dashboard.hermes.installed && !super::gateway_available(&dashboard.hermes.gateway_summary) {
        issues.push(DetectedIssue {
            id: "gateway_unavailable".to_string(),
            severity: "medium".to_string(),
            repairable: true,
            repair_action: "repair_gateway".to_string(),
            target_page: Some("repair".to_string()),
            detail: super::first_nonempty_line(&dashboard.hermes.gateway_summary),
        });
    }

    if !Path::new(&dashboard.files.config_path).exists() {
        issues.push(DetectedIssue {
            id: "config_missing".to_string(),
            severity: "medium".to_string(),
            repairable: true,
            repair_action: "repair_missing_files".to_string(),
            target_page: Some("repair".to_string()),
            detail: dashboard.files.config_path.clone(),
        });
    }

    if !Path::new(&dashboard.files.env_path).exists() {
        issues.push(DetectedIssue {
            id: "env_missing".to_string(),
            severity: "medium".to_string(),
            repairable: true,
            repair_action: "repair_missing_files".to_string(),
            target_page: Some("repair".to_string()),
            detail: dashboard.files.env_path.clone(),
        });
    }

    if dashboard.profiles.iter().all(|profile| !profile.current) {
        issues.push(DetectedIssue {
            id: "active_profile_missing".to_string(),
            severity: "medium".to_string(),
            repairable: false,
            repair_action: String::new(),
            target_page: Some("profiles".to_string()),
            detail: "未识别到当前活动身份。".to_string(),
        });
    }

    if !Path::new(&dashboard.paths.state_db).exists() {
        issues.push(DetectedIssue {
            id: "state_db_missing".to_string(),
            severity: "low".to_string(),
            repairable: false,
            repair_action: String::new(),
            target_page: Some("history".to_string()),
            detail: dashboard.paths.state_db.clone(),
        });
    }

    issues
}

fn load_or_seed_store(dashboard: &super::DashboardSnapshot) -> Result<PanelStore, String> {
    let mut store = load_panel_store().unwrap_or_else(|_| default_panel_store());
    let changed = synchronize_store(&mut store, dashboard);
    if changed {
        save_panel_store(&store)?;
    }
    Ok(store)
}

fn load_panel_store() -> Result<PanelStore, String> {
    let path = panel_store_path();
    if !path.exists() {
        return Ok(default_panel_store());
    }

    let text = fs::read_to_string(path).map_err(|error| error.to_string())?;
    if text.trim().is_empty() {
        return Ok(default_panel_store());
    }

    serde_json::from_str::<PanelStore>(&text).map_err(|error| error.to_string())
}

fn save_panel_store(store: &PanelStore) -> Result<(), String> {
    fs::create_dir_all(super::panel_home()).map_err(|error| error.to_string())?;
    let serialized = serde_json::to_string_pretty(store).map_err(|error| error.to_string())?;
    fs::write(panel_store_path(), serialized).map_err(|error| error.to_string())
}

fn load_panel_store_or_default() -> PanelStore {
    load_panel_store().unwrap_or_else(|_| default_panel_store())
}

fn default_panel_store() -> PanelStore {
    PanelStore {
        settings: PanelSettings {
            language: "zh-CN".to_string(),
            launch_at_startup: true,
            close_to_tray: true,
        },
        model_configs: Vec::new(),
        active_model_config_id: None,
        profile_model_links: BTreeMap::new(),
        last_diagnosis: None,
    }
}

fn synchronize_store(store: &mut PanelStore, dashboard: &super::DashboardSnapshot) -> bool {
    let mut changed = false;
    store.settings.language = normalize_language(&store.settings.language);

    let existing_ids = store
        .model_configs
        .iter()
        .map(|model| model.id.clone())
        .collect::<BTreeSet<_>>();

    if store.model_configs.is_empty() {
        if let Some(model) = model_from_basic(&dashboard.files.basic) {
            store.active_model_config_id = Some(model.id.clone());
            store.model_configs.push(model);
            changed = true;
        }
    } else if store.active_model_config_id.is_none() {
        store.active_model_config_id = store.model_configs.first().map(|model| model.id.clone());
        changed = true;
    }

    if let Some(current_profile) = dashboard.profiles.iter().find(|profile| profile.current) {
        if let Some(active_id) = store.active_model_config_id.clone() {
            store
                .profile_model_links
                .entry(current_profile.name.clone())
                .or_insert(active_id);
        }
    }

    let valid_profiles = dashboard
        .profiles
        .iter()
        .map(|profile| profile.name.clone())
        .collect::<BTreeSet<_>>();

    let before_links = store.profile_model_links.len();
    store.profile_model_links.retain(|profile_name, model_id| {
        valid_profiles.contains(profile_name) && existing_ids.contains(model_id)
    });
    changed |= before_links != store.profile_model_links.len();

    if let Some(active_id) = store.active_model_config_id.clone() {
        if !existing_ids.contains(&active_id) {
            store.active_model_config_id =
                store.model_configs.first().map(|model| model.id.clone());
            changed = true;
        }
    }

    changed
}

fn panel_store_path() -> PathBuf {
    super::panel_home().join("panel-store.json")
}

fn model_from_basic(basic: &super::HermesBasicSettings) -> Option<ModelConfig> {
    if basic.model.trim().is_empty()
        && basic.openrouter_api_key.trim().is_empty()
        && basic.openai_api_key.trim().is_empty()
        && basic.openai_base_url.trim().is_empty()
    {
        return None;
    }

    let provider = if !basic.openrouter_api_key.trim().is_empty() {
        "openrouter"
    } else if !basic.openai_api_key.trim().is_empty() {
        "openai"
    } else {
        "custom"
    };

    Some(ModelConfig {
        id: unique_id("seeded-model"),
        name: if basic.model.trim().is_empty() {
            format!("{provider} default")
        } else {
            format!("{provider} · {}", basic.model.trim())
        },
        provider: provider.to_string(),
        model: basic.model.clone(),
        api_key: if provider == "openrouter" {
            basic.openrouter_api_key.clone()
        } else {
            basic.openai_api_key.clone()
        },
        base_url: basic.openai_base_url.clone(),
    })
}

fn normalize_model_input(input: ModelConfigInput) -> Result<ModelConfigInput, String> {
    let name = input.name.trim().to_string();
    let provider = input.provider.trim().to_lowercase();
    let model = input.model.trim().to_string();
    let api_key = input.api_key.trim().to_string();
    let base_url = input.base_url.trim().to_string();

    if name.is_empty() {
        return Err("模型配置名称不能为空。".to_string());
    }
    if model.is_empty() {
        return Err("模型名称不能为空。".to_string());
    }

    Ok(ModelConfigInput {
        id: input
            .id
            .and_then(|id| trimmed_nonempty(&id).map(ToString::to_string)),
        name,
        provider: if provider.is_empty() {
            "custom".to_string()
        } else {
            provider
        },
        model,
        api_key,
        base_url,
    })
}

fn apply_model_config_internal(model: &ModelConfig) -> Result<(), String> {
    let config_path = super::hermes_home().join("config.yaml");
    let env_path = super::hermes_home().join(".env");
    let current_config_text =
        fs::read_to_string(&config_path).unwrap_or_else(|_| super::default_config_template());
    let current_env_text =
        fs::read_to_string(&env_path).unwrap_or_else(|_| super::default_env_template());
    let mut root = super::parse_yaml_or_mapping(&current_config_text)?;
    let mut env_map = super::parse_env_map(&current_env_text);

    super::update_yaml_string(&mut root, &["model"], &model.model);

    match model.provider.as_str() {
        "openrouter" => {
            super::upsert_env(&mut env_map, "OPENROUTER_API_KEY", &model.api_key);
            super::upsert_env(&mut env_map, "OPENAI_API_KEY", "");
        }
        "openai" => {
            super::upsert_env(&mut env_map, "OPENAI_API_KEY", &model.api_key);
            super::upsert_env(&mut env_map, "OPENROUTER_API_KEY", "");
        }
        _ => {
            super::upsert_env(&mut env_map, "OPENAI_API_KEY", &model.api_key);
            super::upsert_env(&mut env_map, "OPENROUTER_API_KEY", "");
        }
    }

    super::upsert_env(&mut env_map, "OPENAI_BASE_URL", &model.base_url);

    super::ensure_parent(&config_path)?;
    super::ensure_parent(&env_path)?;
    fs::write(&config_path, super::yaml_to_string(&root)?).map_err(|error| error.to_string())?;
    fs::write(&env_path, super::env_map_to_string(&env_map)).map_err(|error| error.to_string())?;
    super::invalidate_dashboard_cache();
    Ok(())
}

fn spawn_task(
    app: AppHandle,
    runtime: PanelRuntime,
    request: StartTaskRequest,
) -> Result<TaskProgress, String> {
    let task_id = runtime.next_task_id();
    let mut context = TaskContext::new(
        app.clone(),
        runtime.clone(),
        task_id,
        request.task_type.clone(),
    );
    let initial = context.task.clone();

    thread::spawn(move || {
        run_task(&mut context, request);
    });

    Ok(initial)
}

fn run_task(context: &mut TaskContext, request: StartTaskRequest) {
    let result = match request.task_type.as_str() {
        "diagnose" => task_diagnose(context),
        "install_official" => task_install_official(context),
        "official_update" => task_official_update(context),
        "repair_gateway" => task_repair_gateway(context),
        "repair_missing_files" => task_repair_missing_files(context),
        "repair_all" => task_repair_all(context, request.issue_ids.unwrap_or_default()),
        "restart_gateway" => task_restart_gateway(context),
        "uninstall_hermes" => task_uninstall_hermes(context, false),
        "uninstall_hermes_clean" => task_uninstall_hermes(context, true),
        "uninstall_panel" => task_uninstall_panel(context),
        other => Err(format!("不支持的任务类型：{other}")),
    };

    if let Err(error) = result {
        context.complete("failed", error, true, context.task.percent.max(10));
    }

    let _ = refresh_tray_menu(&context.app);
    emit_refresh(&context.app);
}

fn task_diagnose(context: &mut TaskContext) -> Result<(), String> {
    context.begin_step("read", "读取当前环境", 20);
    let dashboard = super::build_dashboard()?;
    context.finish_step("已读取 Hermes 当前状态。");

    context.begin_step("analyze", "分析异常项", 65);
    let mut store = load_or_seed_store(&dashboard)?;
    let issues = detect_issues(&dashboard);
    store.last_diagnosis = Some(DiagnosisSnapshot {
        generated_at: super::now_string(),
        issues: issues.clone(),
    });
    save_panel_store(&store)?;
    context.finish_step(format!("识别到 {} 个问题项。", issues.len()));

    context.begin_step("done", "同步界面", 92);
    context.finish_step("已更新问题列表与修复入口。");

    let summary = if issues.is_empty() {
        localized(
            &store.settings.language,
            "体检完成，未发现异常。",
            "Diagnosis completed with no issues.",
        )
    } else {
        localized(
            &store.settings.language,
            &format!("体检完成，共发现 {} 个问题。", issues.len()),
            &format!("Diagnosis completed with {} issue(s).", issues.len()),
        )
    };
    context.complete("success", summary, false, 100);
    Ok(())
}

fn task_install_official(context: &mut TaskContext) -> Result<(), String> {
    context.begin_step("prepare", "准备官方安装", 10);
    context.finish_step("已准备官方安装脚本。");

    context.begin_step("install", "执行安装脚本", 55);
    let result = run_official_install()?;
    ensure_result_success(&result)?;
    context.finish_step(super::first_nonempty_line(&result.combined));

    context.begin_step("rescan", "重新扫描状态", 90);
    clear_diagnosis()?;
    let dashboard = super::build_dashboard()?;
    context.finish_step(format!("当前状态：{}", dashboard.hermes.version));

    context.complete(
        "success",
        "官方安装执行完成，请按需再次体检。".to_string(),
        false,
        100,
    );
    Ok(())
}

fn task_official_update(context: &mut TaskContext) -> Result<(), String> {
    context.begin_step("update", "执行官方更新", 45);
    let result = run_official_install()?;
    ensure_result_success(&result)?;
    context.finish_step(super::first_nonempty_line(&result.combined));

    context.begin_step("rescan", "重新扫描状态", 90);
    clear_diagnosis()?;
    let dashboard = super::build_dashboard()?;
    context.finish_step(format!("当前版本：{}", dashboard.hermes.version));

    context.complete("success", "官方更新完成。".to_string(), false, 100);
    Ok(())
}

fn task_repair_gateway(context: &mut TaskContext) -> Result<(), String> {
    context.begin_step("gateway-restart", "重启 Gateway", 50);
    let restart = super::run_hermes_command(
        "重启 Gateway",
        super::owned_args(&["gateway", "restart"]),
        true,
    )?;

    if ensure_result_success(&restart).is_ok() {
        context.finish_step(super::first_nonempty_line(&restart.combined));
        context.complete("success", "Gateway 已重启。".to_string(), false, 100);
        return Ok(());
    }

    context.fail_step("直接重启失败，继续尝试重新安装服务。");

    context.begin_step("gateway-install", "重新安装 Gateway 服务", 78);
    let install = super::run_hermes_command(
        "安装 Gateway",
        super::owned_args(&["gateway", "install"]),
        true,
    )?;
    ensure_result_success(&install)?;
    context.finish_step(super::first_nonempty_line(&install.combined));

    context.begin_step("gateway-resume", "再次重启 Gateway", 94);
    let second_restart = super::run_hermes_command(
        "重启 Gateway",
        super::owned_args(&["gateway", "restart"]),
        true,
    )?;
    ensure_result_success(&second_restart)?;
    context.finish_step(super::first_nonempty_line(&second_restart.combined));

    update_diagnosis_after_repair()?;
    context.complete("success", "Gateway 修复完成。".to_string(), false, 100);
    Ok(())
}

fn task_repair_missing_files(context: &mut TaskContext) -> Result<(), String> {
    context.begin_step("repair-files", "创建默认配置文件", 65);
    ensure_default_files()?;
    context.finish_step("已补全默认 config.yaml 与 .env。");

    update_diagnosis_after_repair()?;
    context.complete("success", "配置文件修复完成。".to_string(), false, 100);
    Ok(())
}

fn task_repair_all(
    context: &mut TaskContext,
    requested_issue_ids: Vec<String>,
) -> Result<(), String> {
    let dashboard = super::build_dashboard()?;
    let store = load_or_seed_store(&dashboard)?;
    let diagnosis_issues = store
        .last_diagnosis
        .map(|diagnosis| diagnosis.issues)
        .unwrap_or_else(|| detect_issues(&dashboard));

    let repairable = diagnosis_issues
        .into_iter()
        .filter(|issue| issue.repairable)
        .filter(|issue| requested_issue_ids.is_empty() || requested_issue_ids.contains(&issue.id))
        .collect::<Vec<_>>();

    if repairable.is_empty() {
        context.complete(
            "success",
            "没有可执行的一键修复项，请先运行体检。".to_string(),
            false,
            100,
        );
        return Ok(());
    }

    let total = repairable.len();
    let mut failed = 0usize;

    for (index, issue) in repairable.iter().enumerate() {
        let percent = (((index as f32) / (total as f32)) * 78.0).round() as u8 + 12;
        context.begin_step(&issue.id, &format!("修复 {}", issue.id), percent);
        match issue.id.as_str() {
            "hermes_missing" => {
                let result = run_official_install()?;
                if let Err(error) = ensure_result_success(&result) {
                    failed += 1;
                    context.fail_step(error);
                } else {
                    context.finish_step(super::first_nonempty_line(&result.combined));
                }
            }
            "gateway_unavailable" => {
                let restart = super::run_hermes_command(
                    "重启 Gateway",
                    super::owned_args(&["gateway", "restart"]),
                    true,
                )?;
                if let Err(error) = ensure_result_success(&restart) {
                    failed += 1;
                    context.fail_step(error);
                } else {
                    context.finish_step(super::first_nonempty_line(&restart.combined));
                }
            }
            "config_missing" | "env_missing" => {
                if let Err(error) = ensure_default_files() {
                    failed += 1;
                    context.fail_step(error);
                } else {
                    context.finish_step("已创建默认配置文件。");
                }
            }
            _ => {
                context.finish_step("该问题无需批量修复。");
            }
        }
    }

    update_diagnosis_after_repair()?;

    if failed == 0 {
        context.complete("success", "一键修复完成。".to_string(), false, 100);
    } else {
        context.complete(
            "partial_success",
            format!("一键修复完成，但有 {failed} 个步骤失败。"),
            true,
            100,
        );
    }
    Ok(())
}

fn task_restart_gateway(context: &mut TaskContext) -> Result<(), String> {
    context.begin_step("gateway-restart", "重启 Gateway", 70);
    let result = super::run_hermes_command(
        "重启 Gateway",
        super::owned_args(&["gateway", "restart"]),
        true,
    )?;
    ensure_result_success(&result)?;
    context.finish_step(super::first_nonempty_line(&result.combined));
    context.complete("success", "Gateway 已重启。".to_string(), false, 100);
    Ok(())
}

fn task_uninstall_hermes(context: &mut TaskContext, remove_data: bool) -> Result<(), String> {
    context.begin_step("uninstall", "卸载 Hermes Agent", 55);
    let result = super::run_hermes_command(
        "卸载 Hermes Agent",
        super::owned_args(&["uninstall", "--yes"]),
        true,
    )?;
    ensure_result_success(&result)?;
    context.finish_step(super::first_nonempty_line(&result.combined));

    if remove_data {
        context.begin_step("cleanup", "清理 Hermes 数据", 82);
        remove_path_if_exists(&super::hermes_home())?;
        context.finish_step("已清理 Hermes 数据目录。");
    }

    context.begin_step("rescan", "重新扫描状态", 94);
    clear_diagnosis()?;
    context.finish_step("卸载流程已完成。");
    context.complete("success", "Hermes Agent 卸载完成。".to_string(), false, 100);
    Ok(())
}

fn task_uninstall_panel(context: &mut TaskContext) -> Result<(), String> {
    context.begin_step("schedule", "计划卸载 Hermes Panel", 82);
    schedule_panel_uninstall(false)?;
    context.finish_step("应用将在退出后执行卸载。");
    context.complete(
        "success",
        "Hermes Panel 将在退出后卸载。".to_string(),
        false,
        100,
    );

    let runtime = context.app.state::<PanelRuntime>();
    runtime.set_exit_requested(true);
    context.app.exit(0);
    Ok(())
}

fn update_diagnosis_after_repair() -> Result<(), String> {
    let dashboard = super::build_dashboard()?;
    let mut store = load_or_seed_store(&dashboard)?;
    let issues = detect_issues(&dashboard);
    store.last_diagnosis = Some(DiagnosisSnapshot {
        generated_at: super::now_string(),
        issues,
    });
    save_panel_store(&store)
}

fn clear_diagnosis() -> Result<(), String> {
    let dashboard = super::build_dashboard()?;
    let mut store = load_or_seed_store(&dashboard)?;
    store.last_diagnosis = None;
    save_panel_store(&store)
}

fn ensure_default_files() -> Result<(), String> {
    let config_path = super::hermes_home().join("config.yaml");
    let env_path = super::hermes_home().join(".env");
    super::ensure_parent(&config_path)?;
    super::ensure_parent(&env_path)?;

    if !config_path.exists() {
        fs::write(&config_path, super::default_config_template())
            .map_err(|error| error.to_string())?;
    }
    if !env_path.exists() {
        fs::write(&env_path, super::default_env_template()).map_err(|error| error.to_string())?;
    }
    super::invalidate_dashboard_cache();
    Ok(())
}

fn run_official_install() -> Result<super::CommandResult, String> {
    #[cfg(target_os = "windows")]
    {
        let powershell =
            super::locate_command("powershell").ok_or_else(|| "未找到 powershell。".to_string())?;
        return run_program_capture(
            "官方安装",
            &powershell,
            vec![
                "-NoProfile".to_string(),
                "-ExecutionPolicy".to_string(),
                "Bypass".to_string(),
                "-Command".to_string(),
                "irm https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.ps1 | iex".to_string(),
            ],
            true,
        );
    }

    #[cfg(not(target_os = "windows"))]
    {
        let shell = super::locate_command("bash").unwrap_or_else(|| PathBuf::from("/bin/bash"));
        run_program_capture(
            "官方安装",
            &shell,
            vec!["-lc".to_string(), super::OFFICIAL_INSTALL_UNIX.to_string()],
            true,
        )
    }
}

fn check_official_update_sync() -> Result<OfficialUpdateSnapshot, String> {
    let dashboard = super::build_dashboard_quick()?;
    let latest = fetch_latest_official_release()?;
    let current = parse_installed_version_snapshot(&dashboard.hermes.version);
    let latest_version = normalize_version_token(&latest.tag_name).unwrap_or(latest.tag_name);
    let latest_release_date = format_release_date(&latest.published_at).unwrap_or_default();
    let current_version = current.version.unwrap_or_else(|| {
        if dashboard.hermes.installed {
            dashboard.hermes.version.clone()
        } else {
            String::new()
        }
    });
    let current_release_date = current.release_date.unwrap_or_default();

    Ok(OfficialUpdateSnapshot {
        current_installed: dashboard.hermes.installed,
        update_available: compute_update_available(
            dashboard.hermes.installed,
            &current_version,
            &current_release_date,
            &latest_version,
            &latest_release_date,
        ),
        current_version,
        current_release_date,
        latest_version,
        latest_release_date,
        release_url: latest.html_url,
        checked_at: super::now_string(),
    })
}

fn fetch_latest_official_release() -> Result<GithubLatestRelease, String> {
    let output = Command::new("curl")
        .args([
            "-fsSL",
            "--connect-timeout",
            "4",
            "--max-time",
            "8",
            "-H",
            "Accept: application/vnd.github+json",
            "-H",
            "User-Agent: Hermes-Panel/0.1.1",
            "https://api.github.com/repos/NousResearch/hermes-agent/releases/latest",
        ])
        .output()
        .map_err(|error| format!("检查官方更新失败：{}", error))?;

    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            "检查官方更新失败。".to_string()
        } else {
            format!("检查官方更新失败：{detail}")
        });
    }

    serde_json::from_slice::<GithubLatestRelease>(&output.stdout)
        .map_err(|error| format!("解析官方更新信息失败：{}", error))
}

fn parse_installed_version_snapshot(value: &str) -> InstalledVersionSnapshot {
    let normalized = value.trim();
    if normalized.is_empty() {
        return InstalledVersionSnapshot::default();
    }

    let version = normalized
        .split_whitespace()
        .find_map(normalize_version_token);

    let release_date = normalized
        .rsplit_once('(')
        .and_then(|(_, tail)| tail.split_once(')'))
        .and_then(|(candidate, _)| normalize_compact_date(candidate))
        .or_else(|| normalized.split_whitespace().find_map(normalize_compact_date));

    InstalledVersionSnapshot {
        version,
        release_date,
    }
}

fn normalize_version_token(token: &str) -> Option<String> {
    let trimmed = token.trim_matches(|char: char| matches!(char, ',' | ';' | '(' | ')' | '[' | ']'));
    let normalized = trimmed.strip_prefix('v').or_else(|| trimmed.strip_prefix('V'))?;
    if normalized.chars().next().is_some_and(|char| char.is_ascii_digit()) {
        Some(format!("v{normalized}"))
    } else {
        None
    }
}

fn normalize_compact_date(value: &str) -> Option<String> {
    let trimmed = value.trim().trim_matches(|char: char| matches!(char, ',' | ';' | '(' | ')'));
    if trimmed.is_empty() {
        return None;
    }

    let separator = if trimmed.contains('.') {
        '.'
    } else if trimmed.contains('-') {
        '-'
    } else {
        return None;
    };

    let parts = trimmed.split(separator).collect::<Vec<_>>();
    if parts.len() != 3 || parts.iter().any(|part| part.is_empty()) {
        return None;
    }

    let year = parts[0].parse::<u32>().ok()?;
    let month = parts[1].parse::<u32>().ok()?;
    let day = parts[2].parse::<u32>().ok()?;
    Some(format!("{year}.{month}.{day}"))
}

fn format_release_date(value: &str) -> Option<String> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|date| date.format("%Y.%-m.%-d").to_string())
}

fn compute_update_available(
    current_installed: bool,
    current_version: &str,
    current_release_date: &str,
    latest_version: &str,
    latest_release_date: &str,
) -> bool {
    if !current_installed {
        return false;
    }

    if let Some(ordering) = compare_version_tags(latest_version, current_version) {
        if ordering != Ordering::Equal {
            return ordering == Ordering::Greater;
        }
    }

    match compare_version_tags(latest_release_date, current_release_date) {
        Some(Ordering::Greater) => true,
        Some(_) => false,
        None => !latest_version.is_empty() && latest_version != current_version,
    }
}

fn compare_version_tags(left: &str, right: &str) -> Option<Ordering> {
    let left_parts = numeric_segments(left);
    let right_parts = numeric_segments(right);
    if left_parts.is_empty() || right_parts.is_empty() {
        return None;
    }

    let max_len = left_parts.len().max(right_parts.len());
    for index in 0..max_len {
        let left_part = *left_parts.get(index).unwrap_or(&0);
        let right_part = *right_parts.get(index).unwrap_or(&0);
        let ordering = left_part.cmp(&right_part);
        if ordering != Ordering::Equal {
            return Some(ordering);
        }
    }

    Some(Ordering::Equal)
}

fn numeric_segments(value: &str) -> Vec<u32> {
    let mut segments = Vec::new();
    let mut current = String::new();

    for char in value.chars() {
        if char.is_ascii_digit() {
            current.push(char);
            continue;
        }

        if !current.is_empty() {
            if let Ok(number) = current.parse::<u32>() {
                segments.push(number);
            }
            current.clear();
        }
    }

    if !current.is_empty() {
        if let Ok(number) = current.parse::<u32>() {
            segments.push(number);
        }
    }

    segments
}

fn run_program_capture(
    title: &str,
    program: &Path,
    args: Vec<String>,
    refresh_snapshot: bool,
) -> Result<super::CommandResult, String> {
    let started_at = super::now_string();
    let started = Instant::now();
    let capture = super::run_direct(program, &args)?;
    let result = super::CommandResult {
        title: title.to_string(),
        command: capture.command,
        status: if capture.code == 0 {
            "success".to_string()
        } else {
            "error".to_string()
        },
        code: capture.code,
        stdout: capture.stdout,
        stderr: capture.stderr,
        combined: capture.combined,
        started_at,
        finished_at: super::now_string(),
        duration_ms: started.elapsed().as_millis() as u64,
        refresh_snapshot,
    };

    let _ = super::record_history(&result);
    if refresh_snapshot {
        super::invalidate_dashboard_cache();
    }
    Ok(result)
}

fn ensure_result_success(result: &super::CommandResult) -> Result<(), String> {
    if result.status == "success" {
        return Ok(());
    }

    if !result.combined.trim().is_empty() {
        return Err(result.combined.clone());
    }

    Err(format!("{} 执行失败。", result.title))
}

fn refresh_tray_menu(app: &AppHandle) -> Result<(), String> {
    let store = load_panel_store_or_default();
    let locale = normalize_language(&store.settings.language);

    let mut model_submenu =
        SubmenuBuilder::new(app, localized(&locale, "快捷切换模型", "Switch Model"));
    if store.model_configs.is_empty() {
        model_submenu = model_submenu.text(
            "tray-model-empty",
            localized(&locale, "暂无模型配置", "No model configs"),
        );
    } else {
        for model in &store.model_configs {
            let item = CheckMenuItemBuilder::with_id(
                format!("tray-model:{}", model.id),
                model.name.as_str(),
            )
            .checked(store.active_model_config_id.as_deref() == Some(model.id.as_str()))
            .build(app)
            .map_err(|error| error.to_string())?;
            model_submenu = model_submenu.item(&item);
        }
    }

    let submenu = model_submenu.build().map_err(|error| error.to_string())?;
    let menu = MenuBuilder::new(app)
        .text(
            "tray-show",
            localized(&locale, "显示主界面", "Show Main Window"),
        )
        .item(&submenu)
        .text(
            "tray-gateway-restart",
            localized(&locale, "重启网关", "Restart Gateway"),
        )
        .separator()
        .text("tray-quit", localized(&locale, "退出", "Quit"))
        .build()
        .map_err(|error| error.to_string())?;

    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_menu(Some(menu))
            .map_err(|error| error.to_string())?;
        return Ok(());
    }

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| "未找到应用图标。".to_string())?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip(localized(&locale, "Hermes Panel", "Hermes Panel"))
        .show_menu_on_left_click(false)
        .menu(&menu)
        .on_menu_event(|app: &AppHandle, event: MenuEvent| {
            let _ = handle_tray_menu_event(app, event.id().0.as_str());
        })
        .on_tray_icon_event(|tray, event: TrayIconEvent| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let _ = show_main_window(&tray.app_handle());
            }
        })
        .build(app)
        .map_err(|error| error.to_string())?;

    Ok(())
}

fn handle_tray_menu_event(app: &AppHandle, id: &str) -> Result<(), String> {
    match id {
        "tray-show" => show_main_window(app),
        "tray-gateway-restart" => {
            let runtime = app.state::<PanelRuntime>().inner().clone();
            let request = StartTaskRequest {
                task_type: "restart_gateway".to_string(),
                issue_ids: None,
            };
            spawn_task(app.clone(), runtime, request).map(|_| ())
        }
        "tray-quit" => {
            let runtime = app.state::<PanelRuntime>();
            runtime.set_exit_requested(true);
            app.exit(0);
            Ok(())
        }
        other => {
            if let Some(model_id) = other.strip_prefix("tray-model:") {
                activate_model_from_tray(app, model_id)
            } else {
                Ok(())
            }
        }
    }
}

fn activate_model_from_tray(app: &AppHandle, model_id: &str) -> Result<(), String> {
    let dashboard = super::build_dashboard_profile_aware()?;
    let mut store = load_or_seed_store(&dashboard)?;
    let model = store
        .model_configs
        .iter()
        .find(|item| item.id == model_id)
        .cloned()
        .ok_or_else(|| "未找到模型配置。".to_string())?;
    apply_model_config_internal(&model)?;
    store.active_model_config_id = Some(model.id.clone());
    if let Some(current_profile) = dashboard.profiles.iter().find(|profile| profile.current) {
        store
            .profile_model_links
            .insert(current_profile.name.clone(), model.id.clone());
    }
    store.last_diagnosis = None;
    save_panel_store(&store)?;
    refresh_tray_menu(app)?;
    emit_refresh(app);
    Ok(())
}

fn show_main_window(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "未找到主窗口。".to_string())?;
    let _ = window.show();
    let _ = window.unminimize();
    window.set_focus().map_err(|error| error.to_string())
}

fn emit_refresh(app: &AppHandle) {
    let _ = app.emit(EVENT_REFRESH_REQUESTED, ());
}

fn close_to_tray_enabled() -> bool {
    load_panel_store()
        .map(|store| store.settings.close_to_tray)
        .unwrap_or(true)
}

fn sync_autostart(_app: &AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let launch_agents = home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("Library")
            .join("LaunchAgents");
        let plist_path = launch_agents.join("cool.qt.hermespanel.plist");

        if !enabled {
            if plist_path.exists() {
                fs::remove_file(plist_path).map_err(|error| error.to_string())?;
            }
            return Ok(());
        }

        fs::create_dir_all(&launch_agents).map_err(|error| error.to_string())?;
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        let plist = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple Computer//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>cool.qt.hermespanel</string>
  <key>ProgramArguments</key>
  <array>
    <string>{}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
</dict>
</plist>"#,
            xml_escape(&executable.to_string_lossy())
        );

        fs::write(plist_path, plist).map_err(|error| error.to_string())?;
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = enabled;
    }

    Ok(())
}

fn schedule_panel_uninstall(remove_panel_data: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let current_exe = std::env::current_exe().map_err(|error| error.to_string())?;
        let mut bundle_path = None;

        for ancestor in current_exe.ancestors() {
            if ancestor
                .extension()
                .and_then(|extension| extension.to_str())
                == Some("app")
            {
                bundle_path = Some(ancestor.to_path_buf());
                break;
            }
        }

        let bundle_path = bundle_path.ok_or_else(|| "仅支持打包后的应用自卸载。".to_string())?;
        let script_path =
            std::env::temp_dir().join(format!("hermes-panel-uninstall-{}.sh", unique_id("script")));
        let mut lines = vec![
            "#!/bin/sh".to_string(),
            "sleep 2".to_string(),
            format!(
                "rm -rf {}",
                super::shell_quote(bundle_path.to_string_lossy().as_ref())
            ),
        ];

        if remove_panel_data {
            lines.push(format!(
                "rm -rf {}",
                super::shell_quote(super::panel_home().to_string_lossy().as_ref())
            ));
        }

        fs::write(&script_path, format!("{}\n", lines.join("\n")))
            .map_err(|error| error.to_string())?;
        let shell = super::locate_command("sh").unwrap_or_else(|| PathBuf::from("/bin/sh"));
        Command::new(shell)
            .arg(script_path)
            .spawn()
            .map_err(|error| error.to_string())?;
        return Ok(());
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = remove_panel_data;
        Err("当前平台暂未接入本软件自卸载。".to_string())
    }
}

fn remove_path_if_exists(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }

    if path.is_dir() {
        fs::remove_dir_all(path).map_err(|error| error.to_string())
    } else {
        fs::remove_file(path).map_err(|error| error.to_string())
    }
}

fn normalize_language(value: &str) -> String {
    match value {
        "en-US" => "en-US".to_string(),
        _ => "zh-CN".to_string(),
    }
}

fn unique_id(prefix: &str) -> String {
    format!("{prefix}-{}", Local::now().format("%Y%m%d%H%M%S%3f"))
}

fn trimmed_nonempty(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

fn localized(language: &str, zh: &str, en: &str) -> String {
    if normalize_language(language) == "en-US" {
        en.to_string()
    } else {
        zh.to_string()
    }
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cmp::Ordering;

    #[test]
    fn extracts_version_and_release_date_from_hermes_version_output() {
        let parsed = parse_installed_version_snapshot("Hermes Agent v0.9.0 (2026.4.13)");
        assert_eq!(parsed.version.as_deref(), Some("v0.9.0"));
        assert_eq!(parsed.release_date.as_deref(), Some("2026.4.13"));
    }

    #[test]
    fn formats_github_release_date_with_dot_separators() {
        assert_eq!(
            format_release_date("2026-04-17T08:30:00Z"),
            Some("2026.4.17".to_string())
        );
    }

    #[test]
    fn compares_semver_like_tags_by_numeric_segments() {
        assert_eq!(
            compare_version_tags("v0.9.1", "v0.9.0"),
            Some(Ordering::Greater)
        );
        assert_eq!(
            compare_version_tags("v0.9.0", "v0.9.0"),
            Some(Ordering::Equal)
        );
        assert_eq!(
            compare_version_tags("v0.8.9", "v0.9.0"),
            Some(Ordering::Less)
        );
    }
}
