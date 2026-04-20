export type LocaleCode = "zh-CN" | "en-US";

export type PageId =
  | "overview"
  | "install"
  | "status"
  | "repair"
  | "models"
  | "channels"
  | "history"
  | "profiles"
  | "settings";

export type TaskStatus =
  | "queued"
  | "running"
  | "success"
  | "failed"
  | "partial_success";

export type StepStatus = "pending" | "running" | "success" | "failed" | "skipped";

export type HealthLevel = "ok" | "warning" | "error" | "info";
export type Severity = "low" | "medium" | "high";

export type PanelSettings = {
  language: LocaleCode;
  launchAtStartup: boolean;
  closeToTray: boolean;
};

export type OverviewSummary = {
  hermesInstalled: boolean;
  hermesVersion: string;
  gatewayHealthy: boolean;
  gatewaySummary: string;
  currentIdentity: string;
  currentModel: string;
  issueCount: number;
  repairableIssueCount: number;
  sessionCount: number;
  lastDiagnosisAt: string;
};

export type StatusCheck = {
  id: string;
  status: HealthLevel;
  detail: string;
};

export type IssueItem = {
  id: string;
  severity: Severity;
  repairable: boolean;
  repairAction: string;
  targetPage: PageId | null;
  detail: string;
};

export type ModelConfig = {
  id: string;
  name: string;
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  isActive: boolean;
  attachedProfiles: string[];
};

export type IdentitySummary = {
  name: string;
  current: boolean;
  path: string;
  linkedModelConfigId: string | null;
  linkedModelName: string;
};

export type SessionSummary = {
  id: string;
  source: string;
  title: string;
  model: string;
  preview: string;
  startedAt: string;
  endedAt: string;
  lastActive: string;
  messageCount: number;
  active: boolean;
  parentSessionId: string;
  storage: "db" | "json";
};

export type SessionMessage = {
  id: string;
  role: string;
  content: string;
  toolName: string;
  timestamp: string;
};

export type AboutInfo = {
  appVersion: string;
  platform: string;
  arch: string;
  hermesPath: string;
  hermesHome: string;
  panelHome: string;
  updaterStatus: string;
};

export type AppStateSnapshot = {
  generatedAt: string;
  settings: PanelSettings;
  overview: OverviewSummary;
  recentIssues: IssueItem[];
  about: AboutInfo;
};

export type StatusPageSnapshot = {
  generatedAt: string;
  checks: StatusCheck[];
};

export type RepairPageSnapshot = {
  generatedAt: string;
  issues: IssueItem[];
  repairableIssueCount: number;
  lastDiagnosisAt: string;
};

export type ModelsPageSnapshot = {
  generatedAt: string;
  modelConfigs: ModelConfig[];
};

export type ProfilesPageSnapshot = {
  generatedAt: string;
  identities: IdentitySummary[];
  modelConfigs: ModelConfig[];
};

export type MessagingSettings = {
  messagingCwd: string;
  groupSessionsPerUser: boolean;
  discordRequireMention: boolean;
  discordAutoThread: boolean;
  discordFreeResponseChannels: string[];
};

export type MessagingPageSnapshot = {
  generatedAt: string;
  settings: MessagingSettings;
};

export type HistoryPageSnapshot = {
  generatedAt: string;
  sessions: SessionSummary[];
};

export type TaskStep = {
  id: string;
  label: string;
  status: StepStatus;
  detail: string;
};

export type TaskProgress = {
  taskId: string;
  taskType: string;
  status: TaskStatus;
  percent: number;
  currentStep: string;
  summary: string;
  retryable: boolean;
  startedAt: string;
  finishedAt: string | null;
  steps: TaskStep[];
};

export type StartTaskRequest = {
  taskType: string;
  issueIds?: string[];
};

export type ModelConfigInput = {
  id?: string | null;
  name: string;
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
};

export type PanelSettingsInput = {
  language: LocaleCode;
  launchAtStartup: boolean;
};

export type MessagingSettingsInput = MessagingSettings;

export type OfficialUpdateSnapshot = {
  currentInstalled: boolean;
  currentVersion: string;
  currentReleaseDate: string;
  latestVersion: string;
  latestReleaseDate: string;
  releaseUrl: string;
  updateAvailable: boolean;
  checkedAt: string;
};
