import type { LocaleCode, PageId } from "./types";

type Copy = {
  appName: string;
  appSubtitle: string;
  nav: Record<PageId, string>;
  navSettings: string;
  overview: string;
  install: string;
  status: string;
  repair: string;
  models: string;
  history: string;
  profiles: string;
  settings: string;
  loading: string;
  refresh: string;
  quickInstall: string;
  checkUpdates: string;
  checkingUpdates: string;
  quickDiagnose: string;
  quickRepair: string;
  quickGateway: string;
  openHistory: string;
  currentTask: string;
  noTask: string;
  taskQueued: string;
  taskRunning: string;
  taskSuccess: string;
  taskFailed: string;
  taskPartial: string;
  save: string;
  cancel: string;
  create: string;
  delete: string;
  rename: string;
  import: string;
  export: string;
  switchTo: string;
  bindModel: string;
  launchAtStartup: string;
  language: string;
  about: string;
  autoUpdate: string;
  uninstall: string;
  uninstallHermes: string;
  uninstallHermesClean: string;
  uninstallPanel: string;
  lastDiagnosis: string;
  noIssues: string;
  runDiagnoseHint: string;
  active: string;
  inactive: string;
  currentIdentity: string;
  currentModel: string;
  hermesInstalled: string;
  gateway: string;
  sessionHistory: string;
  search: string;
  empty: string;
  applyNow: string;
  setActive: string;
  createIdentity: string;
  importIdentity: string;
  exportPath: string;
  archivePath: string;
  linkedModel: string;
  modelName: string;
  providerType: string;
  apiKey: string;
  baseUrl: string;
  versionInfo: string;
  updaterPlanning: string;
  rerunScan: string;
  issueList: string;
  problemCause: string;
  repairSuggestion: string;
  currentVersion: string;
  currentReleaseDate: string;
  latestVersion: string;
  releaseDate: string;
  checkedAt: string;
  updateAvailable: string;
  upToDate: string;
  updateTo: string;
  updateCheckDescription: string;
};

const zhCN: Copy = {
  appName: "Hermes Panel",
  appSubtitle: "Hermes Agent 桌面管理工具",
  nav: {
    overview: "概览",
    install: "安装初始化",
    status: "状态检测",
    repair: "异常修复",
    models: "模型配置",
    history: "会话历史",
    profiles: "配置身份",
    settings: "软件设置"
  },
  navSettings: "软件设置",
  overview: "概览",
  install: "安装初始化",
  status: "状态检测",
  repair: "异常修复",
  models: "模型配置",
  history: "会话历史",
  profiles: "配置身份",
  settings: "软件设置",
  loading: "正在读取 Hermes 环境…",
  refresh: "刷新",
  quickInstall: "官方安装 / 更新",
  checkUpdates: "检查更新",
  checkingUpdates: "正在检查更新",
  quickDiagnose: "一键体检",
  quickRepair: "一键修复",
  quickGateway: "重启网关",
  openHistory: "打开会话历史",
  currentTask: "当前任务",
  noTask: "暂无正在执行的后台任务",
  taskQueued: "排队中",
  taskRunning: "执行中",
  taskSuccess: "已完成",
  taskFailed: "失败",
  taskPartial: "部分成功",
  save: "保存",
  cancel: "取消",
  create: "新建",
  delete: "删除",
  rename: "重命名",
  import: "导入",
  export: "导出",
  switchTo: "切换",
  bindModel: "绑定模型",
  launchAtStartup: "开机自启动",
  language: "语言",
  about: "关于 / 版本信息",
  autoUpdate: "自动更新",
  uninstall: "卸载入口",
  uninstallHermes: "卸载 Hermes Agent",
  uninstallHermesClean: "卸载 Hermes Agent 并清理数据",
  uninstallPanel: "卸载 Hermes Panel",
  lastDiagnosis: "最近一次体检",
  noIssues: "未发现异常项",
  runDiagnoseHint: "运行一键体检后，这里会生成问题列表与修复入口。",
  active: "当前",
  inactive: "未激活",
  currentIdentity: "当前身份",
  currentModel: "当前模型",
  hermesInstalled: "Hermes 安装状态",
  gateway: "Gateway",
  sessionHistory: "会话历史",
  search: "搜索",
  empty: "暂无数据",
  applyNow: "立即应用",
  setActive: "设为当前",
  createIdentity: "新增身份",
  importIdentity: "导入身份",
  exportPath: "导出路径",
  archivePath: "归档路径",
  linkedModel: "绑定模型",
  modelName: "名称",
  providerType: "Provider 类型",
  apiKey: "API Key",
  baseUrl: "Base URL",
  versionInfo: "版本信息",
  updaterPlanning: "更新能力已预留，后续接入 Tauri Updater。",
  rerunScan: "重新扫描",
  issueList: "问题列表",
  problemCause: "问题原因",
  repairSuggestion: "修复建议",
  currentVersion: "当前版本",
  currentReleaseDate: "当前发布日期",
  latestVersion: "最新版本",
  releaseDate: "发布日期",
  checkedAt: "检查时间",
  updateAvailable: "发现新版本",
  upToDate: "当前已是最新版本",
  updateTo: "更新到",
  updateCheckDescription: "先检查 Hermes 官方最新版本和发布日期，再决定是否执行更新。"
};

const enUS: Copy = {
  appName: "Hermes Panel",
  appSubtitle: "Desktop manager for Hermes Agent",
  nav: {
    overview: "Overview",
    install: "Install",
    status: "Health",
    repair: "Repair",
    models: "Models",
    history: "History",
    profiles: "Profiles",
    settings: "Settings"
  },
  navSettings: "Settings",
  overview: "Overview",
  install: "Install",
  status: "Health",
  repair: "Repair",
  models: "Models",
  history: "History",
  profiles: "Profiles",
  settings: "Settings",
  loading: "Loading Hermes environment…",
  refresh: "Refresh",
  quickInstall: "Official Install / Update",
  checkUpdates: "Check Updates",
  checkingUpdates: "Checking Updates",
  quickDiagnose: "Diagnose",
  quickRepair: "Repair All",
  quickGateway: "Restart Gateway",
  openHistory: "Open History",
  currentTask: "Current Task",
  noTask: "No background task is running",
  taskQueued: "Queued",
  taskRunning: "Running",
  taskSuccess: "Completed",
  taskFailed: "Failed",
  taskPartial: "Partial Success",
  save: "Save",
  cancel: "Cancel",
  create: "Create",
  delete: "Delete",
  rename: "Rename",
  import: "Import",
  export: "Export",
  switchTo: "Switch",
  bindModel: "Bind Model",
  launchAtStartup: "Launch at Startup",
  language: "Language",
  about: "About / Version",
  autoUpdate: "Auto Update",
  uninstall: "Uninstall",
  uninstallHermes: "Uninstall Hermes Agent",
  uninstallHermesClean: "Uninstall Hermes Agent + Data",
  uninstallPanel: "Uninstall Hermes Panel",
  lastDiagnosis: "Last Diagnosis",
  noIssues: "No issues found",
  runDiagnoseHint: "Run diagnose once to populate the issue list and repair entry.",
  active: "Active",
  inactive: "Inactive",
  currentIdentity: "Current Identity",
  currentModel: "Current Model",
  hermesInstalled: "Hermes Installed",
  gateway: "Gateway",
  sessionHistory: "Session History",
  search: "Search",
  empty: "No data",
  applyNow: "Apply Now",
  setActive: "Set Active",
  createIdentity: "Create Identity",
  importIdentity: "Import Identity",
  exportPath: "Export Path",
  archivePath: "Archive Path",
  linkedModel: "Linked Model",
  modelName: "Name",
  providerType: "Provider",
  apiKey: "API Key",
  baseUrl: "Base URL",
  versionInfo: "Version",
  updaterPlanning: "Updater entry is reserved and will be wired to Tauri Updater later.",
  rerunScan: "Rescan",
  issueList: "Issues",
  problemCause: "Cause",
  repairSuggestion: "Suggested Fix",
  currentVersion: "Current Version",
  currentReleaseDate: "Current Release Date",
  latestVersion: "Latest Version",
  releaseDate: "Release Date",
  checkedAt: "Checked At",
  updateAvailable: "New version available",
  upToDate: "Already up to date",
  updateTo: "Update to",
  updateCheckDescription:
    "Check the latest official Hermes release and publish date before running the update."
};

export function getCopy(locale: LocaleCode): Copy {
  return locale === "en-US" ? enUS : zhCN;
}
