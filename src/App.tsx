import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState
} from "react";
import { getCopy } from "./i18n";
import {
  overviewDiagnosisLabel,
  PRIMARY_PAGE_ORDER,
  resolveStartupGate,
  startupPageForTarget,
  type StartupGateDecision,
  type StartupPageId
} from "./shell";
import { filterSessionsByQuery } from "./state/sessionFilter";
import { mergeShellSnapshotData } from "./state/shellSnapshot";
import panelIcon from "../src-tauri/icons/icon.svg";
import type {
  AppStateSnapshot,
  HistoryPageSnapshot,
  IdentitySummary,
  IssueItem,
  LocaleCode,
  MessagingPageSnapshot,
  MessagingSettingsInput,
  ModelConfig,
  ModelConfigInput,
  OfficialUpdateSnapshot,
  ModelsPageSnapshot,
  PageId,
  PanelSettingsInput,
  ProfilesPageSnapshot,
  RepairPageSnapshot,
  SessionMessage,
  SessionSummary,
  StartTaskRequest,
  StatusPageSnapshot,
  StatusCheck,
  TaskProgress,
  TaskStatus
} from "./types";

const DEFAULT_LOCALE: LocaleCode = "zh-CN";
const POLL_INTERVAL_MS = 900;

type LazyPageId = "status" | "repair" | "models" | "channels" | "history" | "profiles";

const EMPTY_SNAPSHOT: AppStateSnapshot = {
  generatedAt: "",
  settings: {
    language: DEFAULT_LOCALE,
    launchAtStartup: true,
    closeToTray: true
  },
  overview: {
    hermesInstalled: false,
    hermesVersion: "Not installed",
    gatewayHealthy: false,
    gatewaySummary: "",
    currentIdentity: "-",
    currentModel: "-",
    issueCount: 0,
    repairableIssueCount: 0,
    sessionCount: 0,
    lastDiagnosisAt: ""
  },
  recentIssues: [],
  about: {
    appVersion: "0.1.1",
    platform: "",
    arch: "",
    hermesPath: "",
    hermesHome: "",
    panelHome: "",
    updaterStatus: ""
  }
};

const BLANK_MODEL: ModelConfigInput = {
  id: null,
  name: "",
  provider: "openrouter",
  model: "",
  apiKey: "",
  baseUrl: ""
};

const EMPTY_MESSAGING_SETTINGS: MessagingSettingsInput = {
  messagingCwd: "",
  groupSessionsPerUser: false,
  discordRequireMention: false,
  discordAutoThread: false,
  discordFreeResponseChannels: []
};

const EMPTY_MODEL_CONFIGS: ModelConfig[] = [];
const EMPTY_IDENTITIES: IdentitySummary[] = [];
const EMPTY_SESSIONS: SessionSummary[] = [];
const EMPTY_STATUS_CHECKS: StatusCheck[] = [];
const EMPTY_ISSUES: IssueItem[] = [];

const FINAL_TASK_STATES: TaskStatus[] = ["success", "failed", "partial_success"];
const PAGE_TIMEOUT_MS: Record<LazyPageId, number> = {
  status: 2600,
  repair: 2600,
  models: 1800,
  channels: 1800,
  history: 3000,
  profiles: 2600
};

function isLazyPage(page: PageId): page is LazyPageId {
  return (
    page === "status" ||
    page === "repair" ||
    page === "models" ||
    page === "channels" ||
    page === "history" ||
    page === "profiles"
  );
}

function App() {
  const [snapshot, setSnapshot] = useState<AppStateSnapshot | null>(null);
  const [activePage, setActivePage] = useState<PageId>("overview");
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [busyKey, setBusyKey] = useState("");
  const [task, setTask] = useState<TaskProgress | null>(null);
  const [taskDetailsOpen, setTaskDetailsOpen] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const shellRefreshPromiseRef = useRef<Promise<void> | null>(null);
  const pageLoadPromiseRef = useRef<Partial<Record<LazyPageId, Promise<void>>>>({});
  const sessionMessagesCacheRef = useRef<Record<string, SessionMessage[]>>({});
  const sessionMessagesPromiseRef = useRef<Partial<Record<string, Promise<SessionMessage[] | void>>>>({});

  const [statusPage, setStatusPage] = useState<StatusPageSnapshot | null>(null);
  const [repairPage, setRepairPage] = useState<RepairPageSnapshot | null>(null);
  const [modelsPage, setModelsPage] = useState<ModelsPageSnapshot | null>(null);
  const [messagingPage, setMessagingPage] = useState<MessagingPageSnapshot | null>(null);
  const [historyPage, setHistoryPage] = useState<HistoryPageSnapshot | null>(null);
  const [profilesPage, setProfilesPage] = useState<ProfilesPageSnapshot | null>(null);
  const [officialUpdate, setOfficialUpdate] = useState<OfficialUpdateSnapshot | null>(null);
  const [pageLoading, setPageLoading] = useState<Partial<Record<PageId, boolean>>>({});
  const [pageErrors, setPageErrors] = useState<Partial<Record<PageId, string>>>({});
  const [checkingOfficialUpdate, setCheckingOfficialUpdate] = useState(false);
  const [startupReady, setStartupReady] = useState(false);
  const [startupChecking, setStartupChecking] = useState(true);
  const [startupPage, setStartupPage] = useState<StartupPageId>("status");
  const startupBootstrappedRef = useRef(false);
  const startupPageAutoModeRef = useRef(true);

  const [selectedModelId, setSelectedModelId] = useState("");
  const [modelDraft, setModelDraft] = useState<ModelConfigInput>(BLANK_MODEL);
  const [revealApiKey, setRevealApiKey] = useState(false);
  const [messagingDraft, setMessagingDraft] = useState<MessagingSettingsInput>(
    EMPTY_MESSAGING_SETTINGS
  );
  const [messagingChannelsText, setMessagingChannelsText] = useState("");

  const [selectedIdentity, setSelectedIdentity] = useState("");
  const [newIdentityName, setNewIdentityName] = useState("");
  const [newIdentityModelId, setNewIdentityModelId] = useState("");
  const [renameIdentityTo, setRenameIdentityTo] = useState("");
  const [identityArchivePath, setIdentityArchivePath] = useState("");
  const [identityImportName, setIdentityImportName] = useState("");
  const [identityImportModelId, setIdentityImportModelId] = useState("");
  const [identityExportPath, setIdentityExportPath] = useState("");

  const [sessionQuery, setSessionQuery] = useState("");
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [sessionMessages, setSessionMessages] = useState<SessionMessage[]>([]);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [sessionError, setSessionError] = useState("");

  const [settingsDraft, setSettingsDraft] = useState<PanelSettingsInput>({
    language: DEFAULT_LOCALE,
    launchAtStartup: true
  });

  const view = snapshot ?? EMPTY_SNAPSHOT;
  const locale = view.settings.language ?? DEFAULT_LOCALE;
  const copy = getCopy(locale);
  const modelConfigs = modelsPage?.modelConfigs ?? EMPTY_MODEL_CONFIGS;
  const identities = profilesPage?.identities ?? EMPTY_IDENTITIES;
  const profileModelConfigs = profilesPage?.modelConfigs ?? modelConfigs;
  const historySessions = historyPage?.sessions ?? EMPTY_SESSIONS;
  const deferredSessionQuery = useDeferredValue(sessionQuery);

  const visibleSessions = useMemo(
    () => filterSessionsByQuery(historySessions, deferredSessionQuery),
    [deferredSessionQuery, historySessions]
  );

  const selectedSession =
    visibleSessions.find((session) => session.id === selectedSessionId) ??
    visibleSessions[0] ??
    null;

  const currentIdentity = identities.find((identity) => identity.current) ?? identities[0] ?? null;

  const selectedIdentityMeta =
    identities.find((identity) => identity.name === selectedIdentity) ??
    currentIdentity ??
    null;

  const applySnapshot = useEffectEvent((next: AppStateSnapshot) => {
    setSnapshot(next);
  });

  const mergeShellSnapshot = useEffectEvent((next: AppStateSnapshot) => {
    applySnapshot(
      mergeShellSnapshotData(next, {
        repairPage,
        historyPage,
        modelsPage,
        profilesPage
      })
    );
  });

  const patchSnapshot = useEffectEvent((updater: (current: AppStateSnapshot) => AppStateSnapshot) => {
    setSnapshot((current) => updater(current ?? EMPTY_SNAPSHOT));
  });

  const setPageLoadingState = useEffectEvent((page: PageId, nextValue: boolean) => {
    setPageLoading((current) => {
      const alreadyLoading = Boolean(current[page]);
      if (alreadyLoading === nextValue) {
        return current;
      }

      const next = { ...current };
      if (nextValue) {
        next[page] = true;
      } else {
        delete next[page];
      }
      return next;
    });
  });

  const setPageErrorState = useEffectEvent((page: PageId, message: string) => {
    setPageErrors((current) => {
      const existing = current[page] ?? "";
      if (existing === message) {
        return current;
      }

      const next = { ...current };
      if (message) {
        next[page] = message;
      } else {
        delete next[page];
      }
      return next;
    });
  });

  const loadInitialState = useEffectEvent(async () => {
    setError("");

    try {
      const next = await invokeWithTimeout<AppStateSnapshot>(
        "load_app_state",
        {},
        1400,
        DEFAULT_LOCALE === "en-US"
          ? "Initial state loading timed out."
          : "基础状态加载超时，请稍后重试。"
      );
      mergeShellSnapshot(next);
    } catch (nextError) {
      setError(normalizeError(nextError));
    }
  });

  const refreshShellState = useEffectEvent(async (showIndicator = false) => {
    if (shellRefreshPromiseRef.current) {
      return shellRefreshPromiseRef.current;
    }

    if (showIndicator) {
      setLoading(true);
      setError("");
    } else {
      setSyncing(true);
    }

    const pending = (async () => {
      try {
        const next = await invokeWithTimeout<AppStateSnapshot>(
          "hydrate_app_state",
          {},
          3600,
          locale === "en-US"
            ? "State synchronization timed out. Please try again."
            : "状态同步超时，请稍后重试。"
        );
        mergeShellSnapshot(next);
      } catch (nextError) {
        if (showIndicator) {
          setError(normalizeError(nextError));
        }
      } finally {
        shellRefreshPromiseRef.current = null;
        if (showIndicator) {
          setLoading(false);
        } else {
          setSyncing(false);
        }
      }
    })();

    shellRefreshPromiseRef.current = pending;
    return pending;
  });

  const loadPageData = useEffectEvent(async (page: PageId, force = false) => {
    if (!isLazyPage(page)) {
      return;
    }

    const hasData =
      (page === "status" && statusPage !== null) ||
      (page === "repair" && repairPage !== null) ||
      (page === "models" && modelsPage !== null) ||
      (page === "channels" && messagingPage !== null) ||
      (page === "history" && historyPage !== null) ||
      (page === "profiles" && profilesPage !== null);

    if (!force && hasData) {
      return;
    }

    const pendingExisting = pageLoadPromiseRef.current[page];
    if (pendingExisting) {
      return pendingExisting;
    }

    setPageLoadingState(page, true);
    setPageErrorState(page, "");

    const pending = (async () => {
      try {
        switch (page) {
          case "status": {
            const next = await invokeWithTimeout<StatusPageSnapshot>(
              "load_status_page",
              {},
              PAGE_TIMEOUT_MS.status,
              locale === "en-US" ? "Status checks timed out." : "状态检查加载超时。"
            );
            setStatusPage(next);
            break;
          }
          case "repair": {
            const next = await invokeWithTimeout<RepairPageSnapshot>(
              "load_repair_page",
              {},
              PAGE_TIMEOUT_MS.repair,
              locale === "en-US" ? "Issue list loading timed out." : "问题列表加载超时。"
            );
            setRepairPage(next);
            patchSnapshot((current) => ({
              ...current,
              overview: {
                ...current.overview,
                issueCount: next.issues.length,
                repairableIssueCount: next.repairableIssueCount,
                lastDiagnosisAt: next.lastDiagnosisAt
              },
              recentIssues: next.issues.slice(0, 4)
            }));
            break;
          }
          case "models": {
            const next = await invokeWithTimeout<ModelsPageSnapshot>(
              "load_models_page",
              {},
              PAGE_TIMEOUT_MS.models,
              locale === "en-US" ? "Model configuration loading timed out." : "模型配置加载超时。"
            );
            setModelsPage(next);
            const activeModel = next.modelConfigs.find((model) => model.isActive);
            if (activeModel) {
              patchSnapshot((current) => ({
                ...current,
                overview: {
                  ...current.overview,
                  currentModel: activeModel.name || current.overview.currentModel
                }
              }));
            }
            break;
          }
          case "channels": {
            const next = await invokeWithTimeout<MessagingPageSnapshot>(
              "load_messaging_page",
              {},
              PAGE_TIMEOUT_MS.channels,
              locale === "en-US" ? "Messaging settings loading timed out." : "消息渠道配置加载超时。"
            );
            setMessagingPage(next);
            break;
          }
          case "history": {
            const next = await invokeWithTimeout<HistoryPageSnapshot>(
              "load_history_page",
              {},
              PAGE_TIMEOUT_MS.history,
              locale === "en-US" ? "Session history loading timed out." : "会话历史加载超时。"
            );
            setHistoryPage(next);
            patchSnapshot((current) => ({
              ...current,
              overview: {
                ...current.overview,
                sessionCount: next.sessions.length
              }
            }));
            break;
          }
          case "profiles": {
            const next = await invokeWithTimeout<ProfilesPageSnapshot>(
              "load_profiles_page",
              {},
              PAGE_TIMEOUT_MS.profiles,
              locale === "en-US" ? "Identity data loading timed out." : "身份数据加载超时。"
            );
            setProfilesPage(next);
            const activeIdentity = next.identities.find((identity) => identity.current);
            if (activeIdentity) {
              patchSnapshot((current) => ({
                ...current,
                overview: {
                  ...current.overview,
                  currentIdentity: activeIdentity.name || current.overview.currentIdentity
                }
              }));
            }
            break;
          }
        }
      } catch (nextError) {
        setPageErrorState(page, normalizeError(nextError));
      } finally {
        delete pageLoadPromiseRef.current[page];
        setPageLoadingState(page, false);
      }
    })();

    pageLoadPromiseRef.current[page] = pending;
    return pending;
  });

  const refreshCurrentView = useEffectEvent(async (showIndicator = false) => {
    await refreshShellState(showIndicator);
    await loadPageData(activePage, true);
    if (activePage === "history" && selectedSessionId) {
      await loadMessages(selectedSessionId, true);
    }
  });

  const pollTask = useEffectEvent(async (taskId: string) => {
    for (;;) {
      await sleep(POLL_INTERVAL_MS);
      const next = await invoke<TaskProgress>("get_task_status", { taskId });
      setTask(next);

      if (FINAL_TASK_STATES.includes(next.status)) {
        await refreshCurrentView(false);
        return next;
      }
    }
  });

  const executeTask = useEffectEvent(async (request: StartTaskRequest) => {
    setBusyKey(request.taskType);
    setError("");

    if (request.taskType === "official_update" || request.taskType === "install_official") {
      setOfficialUpdate(null);
    }

    try {
      const started = await invoke<TaskProgress>("start_task", { request });
      setTask(started);
      const finished = await pollTask(started.taskId);

      if (finished.status === "failed") {
        setError(finished.summary || "Task failed");
        return finished;
      }

      if (finished.summary) {
        setToast(finished.summary);
      }
      return finished;
    } catch (nextError) {
      setError(normalizeError(nextError));
      return null;
    } finally {
      setBusyKey("");
    }
  });

  const runTask = useEffectEvent(async (request: StartTaskRequest) => {
    const finished = await executeTask(request);
    if (!startupReady && finished && request.taskType !== "diagnose") {
      await runStartupAudit(true);
    }
  });

  const runSnapshotMutation = useEffectEvent(
    async (busyId: string, command: string, args: Record<string, unknown>, successText = "") => {
      setBusyKey(busyId);
      setError("");

      try {
        const next = await invoke<AppStateSnapshot>(command, args);
        mergeShellSnapshot(next);
        await loadPageData(activePage, true);
        if (!startupReady) {
          await runStartupAudit(true);
        }

        if (successText) {
          setToast(successText);
        }
      } catch (nextError) {
        setError(normalizeError(nextError));
      } finally {
        setBusyKey("");
      }
    }
  );

  const checkOfficialUpdate = useEffectEvent(async () => {
    setCheckingOfficialUpdate(true);
    setError("");

    try {
      const next = await invokeWithoutArgsWithTimeout<OfficialUpdateSnapshot>(
        "check_official_update",
        6500,
        locale === "en-US" ? "Checking for updates timed out." : "检查更新超时，请稍后重试。"
      );
      setOfficialUpdate(next);
    } catch (nextError) {
      setOfficialUpdate(null);
      setError(normalizeError(nextError));
    } finally {
      setCheckingOfficialUpdate(false);
    }
  });

  const runTextMutation = useEffectEvent(
    async (busyId: string, command: string, args: Record<string, unknown>, successText = "") => {
      setBusyKey(busyId);
      setError("");

      try {
        const next = await invoke<string>(command, args);
        setToast(successText || next);
        await refreshCurrentView(false);
        if (!startupReady) {
          await runStartupAudit(true);
        }
      } catch (nextError) {
        setError(normalizeError(nextError));
      } finally {
        setBusyKey("");
      }
    }
  );

  const runStartupAudit = useEffectEvent(async (force = false) => {
    setStartupChecking(true);
    setError("");

    try {
      const checks = await invokeWithTimeout<StatusPageSnapshot>(
        "load_status_page",
        {},
        PAGE_TIMEOUT_MS.status,
        locale === "en-US" ? "Status checks timed out." : "状态检查加载超时。"
      );
      setStatusPage(checks);

      const diagnosis = await executeTask({ taskType: "diagnose" });
      if (diagnosis?.status === "failed") {
        setStartupReady(false);
        return;
      }

      const nextRepair = await invokeWithTimeout<RepairPageSnapshot>(
        "load_repair_page",
        {},
        PAGE_TIMEOUT_MS.repair,
        locale === "en-US" ? "Issue list loading timed out." : "问题列表加载超时。"
      );
      setRepairPage(nextRepair);
      patchSnapshot((current) => ({
        ...current,
        overview: {
          ...current.overview,
          issueCount: nextRepair.issues.length,
          repairableIssueCount: nextRepair.repairableIssueCount,
          lastDiagnosisAt: nextRepair.lastDiagnosisAt
        },
        recentIssues: nextRepair.issues.slice(0, 4)
      }));

      if (force || !messagingPage) {
        const nextMessaging = await invokeWithTimeout<MessagingPageSnapshot>(
          "load_messaging_page",
          {},
          PAGE_TIMEOUT_MS.channels,
          locale === "en-US" ? "Messaging settings loading timed out." : "消息渠道配置加载超时。"
        );
        setMessagingPage(nextMessaging);
      }

      const nextSnapshot = await invokeWithTimeout<AppStateSnapshot>(
        "hydrate_app_state",
        {},
        3600,
        locale === "en-US"
          ? "State synchronization timed out. Please try again."
          : "状态同步超时，请稍后重试。"
      );
      mergeShellSnapshot(nextSnapshot);

      const gate = resolveStartupGate(nextSnapshot, nextRepair.issues);
      setStartupReady(gate.ready);
      if (!gate.ready) {
        setStartupPage((current) => {
          if (!startupPageAutoModeRef.current) {
            return current;
          }
          return gate.page;
        });
      } else {
        startupPageAutoModeRef.current = true;
      }
    } catch (nextError) {
      setStartupReady(false);
      setError(normalizeError(nextError));
    } finally {
      setStartupChecking(false);
    }
  });

  const loadMessages = useEffectEvent(async (sessionId: string, force = false) => {
    if (!sessionId) {
      setSessionMessages((current) => (current.length ? [] : current));
      return;
    }

    if (!force) {
      const cachedMessages = sessionMessagesCacheRef.current[sessionId];
      if (cachedMessages) {
        setSessionError("");
        setSessionLoading(false);
        setSessionMessages((current) => (current === cachedMessages ? current : cachedMessages));
        return cachedMessages;
      }

      const pendingExisting = sessionMessagesPromiseRef.current[sessionId];
      if (pendingExisting) {
        return pendingExisting;
      }
    } else {
      delete sessionMessagesCacheRef.current[sessionId];
    }

    setSessionLoading(true);
    setSessionError("");

    const pending = (async () => {
      try {
        const messages = await invokeWithTimeout<SessionMessage[]>(
          "load_session_messages",
          { sessionId },
          2600,
          locale === "en-US" ? "Session messages loading timed out." : "会话消息加载超时。"
        );
        sessionMessagesCacheRef.current[sessionId] = messages;
        setSessionMessages(messages);
        return messages;
      } catch (nextError) {
        setSessionError(normalizeError(nextError));
      } finally {
        delete sessionMessagesPromiseRef.current[sessionId];
        setSessionLoading(false);
      }
    })();

    sessionMessagesPromiseRef.current[sessionId] = pending;
    return pending;
  });

  const openSurfacePage = useEffectEvent(async (page: PageId | StartupPageId) => {
    if (!startupReady) {
      startupPageAutoModeRef.current = false;
      switch (page) {
        case "models":
        case "channels":
        case "profiles":
        case "settings":
          setStartupPage(page);
          await loadPageData(page);
          return;
        case "install":
        case "status":
        case "repair":
          setStartupPage(page);
          return;
        default:
          return;
      }
    }

    switch (page) {
      case "overview":
      case "models":
      case "channels":
      case "history":
      case "profiles":
      case "settings":
        setActivePage(page);
        await loadPageData(page);
        return;
      default:
        return;
    }
  });

  const handleStartupPageChange = useEffectEvent((page: StartupPageId) => {
    startupPageAutoModeRef.current = false;
    setStartupPage(page);
  });

  useEffect(() => {
    void loadInitialState();
  }, []);

  useEffect(() => {
    if (!snapshot || startupBootstrappedRef.current) {
      return;
    }

    startupBootstrappedRef.current = true;
    void runStartupAudit(true);
  }, [runStartupAudit, snapshot]);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;

    void listen("panel://refresh-requested", () => {
      void refreshCurrentView(false);
    }).then((dispose) => {
      if (active) {
        unlisten = dispose;
      }
    });

    return () => {
      active = false;
      if (unlisten) {
        void unlisten();
      }
    };
  }, []);

  useEffect(() => {
    void loadPageData(activePage);
  }, [activePage]);

  useEffect(() => {
    if (!startupReady) {
      void loadPageData(startupPage);
    }
  }, [startupPage, startupReady]);

  useEffect(() => {
    if (!toast) {
      return;
    }

    const timeout = window.setTimeout(() => setToast(""), 3200);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    setTaskDetailsOpen(false);
  }, [task?.taskId]);

  useEffect(() => {
    setSettingsDraft({
      language: view.settings.language,
      launchAtStartup: view.settings.launchAtStartup
    });
  }, [view.settings.language, view.settings.launchAtStartup]);

  useEffect(() => {
    if (!modelConfigs.length) {
      setSelectedModelId("");
      setModelDraft(BLANK_MODEL);
      return;
    }

    const nextModel = modelConfigs.find((config) => config.id === selectedModelId)
      ? modelConfigs.find((config) => config.id === selectedModelId)
      : modelConfigs.find((config) => config.isActive) ?? modelConfigs[0];

    if (!nextModel) {
      return;
    }

    setSelectedModelId(nextModel.id);
    setModelDraft(modelToDraft(nextModel));
  }, [modelConfigs, selectedModelId]);

  useEffect(() => {
    if (!messagingPage) {
      setMessagingDraft(EMPTY_MESSAGING_SETTINGS);
      setMessagingChannelsText("");
      return;
    }

    setMessagingDraft(messagingPage.settings);
    setMessagingChannelsText(messagingPage.settings.discordFreeResponseChannels.join("\n"));
  }, [messagingPage]);

  useEffect(() => {
    if (!identities.length) {
      setSelectedIdentity("");
      setRenameIdentityTo("");
      return;
    }

    const nextIdentity = identities.find((identity) => identity.name === selectedIdentity)
      ? identities.find((identity) => identity.name === selectedIdentity)
      : currentIdentity;

    if (!nextIdentity) {
      return;
    }

    setSelectedIdentity(nextIdentity.name);
    setRenameIdentityTo(nextIdentity.name);
    setNewIdentityModelId((current) => current || nextIdentity.linkedModelConfigId || "");
    setIdentityImportModelId(
      (current) => current || nextIdentity.linkedModelConfigId || newIdentityModelId || ""
    );
  }, [currentIdentity, identities, newIdentityModelId, selectedIdentity]);

  useEffect(() => {
    if (!visibleSessions.length) {
      setSelectedSessionId((current) => (current ? "" : current));
      setSessionMessages((current) => (current.length ? [] : current));
      return;
    }

    const nextId = visibleSessions.find((session) => session.id === selectedSessionId)?.id
      ? selectedSessionId
      : visibleSessions[0].id;

    setSelectedSessionId(nextId);
  }, [selectedSessionId, visibleSessions]);

  useEffect(() => {
    if (activePage === "history" && selectedSessionId) {
      void loadMessages(selectedSessionId);
    }
  }, [activePage, selectedSessionId]);

  const handleSaveModel = async () => {
    const input = normalizeModelDraft(modelDraft);
    if (!input.name || !input.model) {
      setError(locale === "en-US" ? "Name and model are required." : "名称和模型不能为空。");
      return;
    }

    await runSnapshotMutation("save-model", "save_model_config", { input }, copy.save);
  };

  const handleActivateModel = async (modelId: string) => {
    await runSnapshotMutation(
      `activate-model:${modelId}`,
      "activate_model_config",
      { modelId },
      copy.applyNow
    );
  };

  const handleDeleteModel = async (model: ModelConfig) => {
    if (
      !window.confirm(
        locale === "en-US"
          ? `Delete model config "${model.name}"?`
          : `确认删除模型配置“${model.name}”吗？`
      )
    ) {
      return;
    }

    await runSnapshotMutation(
      `delete-model:${model.id}`,
      "delete_model_config",
      { modelId: model.id },
      copy.delete
    );
  };

  const handleSaveSettings = async () => {
    const input = settingsDraft;
    setBusyKey("save-settings");
    setError("");

    try {
      const next = await invoke<AppStateSnapshot>("save_panel_settings", { input });
      mergeShellSnapshot(next);
      patchSnapshot((current) => ({
        ...current,
        settings: {
          ...current.settings,
          language: input.language,
          launchAtStartup: input.launchAtStartup
        }
      }));
      if (!startupReady) {
        await runStartupAudit(true);
      }
      setToast(copy.save);
    } catch (nextError) {
      setError(normalizeError(nextError));
    } finally {
      setBusyKey("");
    }
  };

  const handleCreateIdentity = async () => {
    if (!newIdentityName.trim()) {
      setError(locale === "en-US" ? "Identity name is required." : "身份名称不能为空。");
      return;
    }

    await runSnapshotMutation(
      "create-identity",
      "create_identity",
      {
        name: newIdentityName.trim(),
        linkedModelConfigId: newIdentityModelId || null
      },
      copy.create
    );
    setNewIdentityName("");
  };

  const handleSaveMessaging = async () => {
    const input: MessagingSettingsInput = {
      ...messagingDraft,
      messagingCwd: messagingDraft.messagingCwd.trim(),
      discordFreeResponseChannels: messagingChannelsText
        .split(/\r?\n|,/)
        .map((value) => value.trim())
        .filter(Boolean)
    };

    setBusyKey("save-messaging");
    setError("");

    try {
      const next = await invoke<AppStateSnapshot>("save_messaging_settings", { input });
      mergeShellSnapshot(next);
      const nextMessaging = await invokeWithTimeout<MessagingPageSnapshot>(
        "load_messaging_page",
        {},
        PAGE_TIMEOUT_MS.channels,
        locale === "en-US" ? "Messaging settings loading timed out." : "消息渠道配置加载超时。"
      );
      setMessagingPage(nextMessaging);
      if (!startupReady) {
        await runStartupAudit(true);
      } else {
        await loadPageData("channels", true);
      }
      setToast(copy.save);
    } catch (nextError) {
      setError(normalizeError(nextError));
    } finally {
      setBusyKey("");
    }
  };

  const handleSwitchIdentity = async (identityName: string) => {
    await runSnapshotMutation(
      `switch-identity:${identityName}`,
      "switch_identity",
      { name: identityName },
      copy.switchTo
    );
  };

  const handleRenameIdentity = async () => {
    if (!selectedIdentityMeta || !renameIdentityTo.trim()) {
      return;
    }

    await runSnapshotMutation(
      `rename-identity:${selectedIdentityMeta.name}`,
      "rename_identity",
      {
        oldName: selectedIdentityMeta.name,
        newName: renameIdentityTo.trim()
      },
      copy.rename
    );
  };

  const handleDeleteIdentity = async () => {
    if (!selectedIdentityMeta) {
      return;
    }

    if (
      !window.confirm(
        locale === "en-US"
          ? `Delete identity "${selectedIdentityMeta.name}"?`
          : `确认删除身份“${selectedIdentityMeta.name}”吗？`
      )
    ) {
      return;
    }

    await runSnapshotMutation(
      `delete-identity:${selectedIdentityMeta.name}`,
      "delete_identity",
      { name: selectedIdentityMeta.name },
      copy.delete
    );
  };

  const handleImportIdentity = async () => {
    if (!identityArchivePath.trim()) {
      setError(locale === "en-US" ? "Archive path is required." : "归档路径不能为空。");
      return;
    }

    await runSnapshotMutation(
      "import-identity",
      "import_identity",
      {
        archivePath: identityArchivePath.trim(),
        profileName: identityImportName.trim(),
        linkedModelConfigId: identityImportModelId || null
      },
      copy.import
    );
  };

  const handleExportIdentity = async () => {
    if (!selectedIdentityMeta) {
      return;
    }

    await runTextMutation(
      `export-identity:${selectedIdentityMeta.name}`,
      "export_identity",
      {
        name: selectedIdentityMeta.name,
        outputPath: identityExportPath.trim()
      },
      copy.export
    );
  };

  const handleBindIdentityModel = async (identity: IdentitySummary, modelId: string) => {
    await runSnapshotMutation(
      `bind-identity:${identity.name}`,
      "save_profile_model_binding",
      {
        profileName: identity.name,
        modelConfigId: modelId || null
      },
      copy.bindModel
    );
  };

  const handleCheckAction = (check: StatusCheck) => {
    switch (check.id) {
      case "hermes_installed":
        void runTask({ taskType: "install_official" });
        break;
      case "model_configured":
      case "provider_key_configured":
        void openSurfacePage("models");
        break;
      case "gateway_available":
        void runTask({ taskType: "restart_gateway" });
        break;
      default:
        void runTask({ taskType: "diagnose" });
        break;
    }
  };

  const handleIssueAction = (issue: IssueItem) => {
    if (issue.repairable) {
      void runTask({ taskType: issue.repairAction, issueIds: [issue.id] });
      return;
    }

    if (issue.targetPage) {
      void openSurfacePage(issue.targetPage);
    }
  };

  if (!startupReady) {
    return (
      <StartupGateScreen
        activePage={startupPage}
        archivePath={identityArchivePath}
        busyKey={busyKey}
        checkingOfficialUpdate={checkingOfficialUpdate}
        checks={statusPage?.checks ?? EMPTY_STATUS_CHECKS}
        channelsText={messagingChannelsText}
        copy={copy}
        error={error}
        exportPath={identityExportPath}
        historySessions={visibleSessions}
        identities={identities}
        importModelId={identityImportModelId}
        importName={identityImportName}
        issues={repairPage?.issues ?? EMPTY_ISSUES}
        loading={startupChecking}
        locale={locale}
        messagingError={pageErrors.channels ?? ""}
        messagingLoading={Boolean(pageLoading.channels)}
        messagingSettings={messagingDraft}
        modelConfigs={modelConfigs}
        modelDraft={modelDraft}
        newIdentityModelId={newIdentityModelId}
        newIdentityName={newIdentityName}
        officialUpdate={officialUpdate}
        onActivateModel={handleActivateModel}
        onBindIdentityModel={handleBindIdentityModel}
        onChannelsTextChange={setMessagingChannelsText}
        onCheckAction={handleCheckAction}
        onCheckUpdate={() => void checkOfficialUpdate()}
        onCreateIdentity={() => void handleCreateIdentity()}
        onDeleteIdentity={() => void handleDeleteIdentity()}
        onDeleteModel={handleDeleteModel}
        onDiagnose={() => void runStartupAudit(true)}
        onDraftChange={setModelDraft}
        onExportIdentity={() => void handleExportIdentity()}
        onGoToPage={handleStartupPageChange}
        onImportIdentity={() => void handleImportIdentity()}
        onIssueAction={handleIssueAction}
        onNewModel={() => {
          setSelectedModelId("");
          setModelDraft(BLANK_MODEL);
        }}
        onRefresh={() => void runStartupAudit(true)}
        onRenameIdentity={() => void handleRenameIdentity()}
        onRunTask={runTask}
        onSaveMessaging={() => void handleSaveMessaging()}
        onSaveModel={() => void handleSaveModel()}
        onSaveSettings={() => void handleSaveSettings()}
        onSettingsChange={setMessagingDraft}
        onSwitchIdentity={handleSwitchIdentity}
        profileModelConfigs={profileModelConfigs}
        revealApiKey={revealApiKey}
        renameTo={renameIdentityTo}
        selectedIdentity={selectedIdentity}
        selectedIdentityMeta={selectedIdentityMeta}
        selectedModelId={selectedModelId}
        sessionError={sessionError}
        sessionLoading={sessionLoading}
        sessionMessages={sessionMessages}
        setArchivePath={setIdentityArchivePath}
        setExportPath={setIdentityExportPath}
        setIdentityImportModelId={setIdentityImportModelId}
        setIdentityImportName={setIdentityImportName}
        setNewIdentityModelId={setNewIdentityModelId}
        setNewIdentityName={setNewIdentityName}
        setRenameTo={setRenameIdentityTo}
        setRevealApiKey={setRevealApiKey}
        setSelectedIdentity={setSelectedIdentity}
        setSelectedModelId={setSelectedModelId}
        setSettingsDraft={setSettingsDraft}
        settingsDraft={settingsDraft}
        snapshot={view}
        task={task}
        taskDetailsOpen={taskDetailsOpen}
        toggleTaskDetails={() => setTaskDetailsOpen((current) => !current)}
      />
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-card">
          <BrandMark />
          <div className="brand-copy">
            <strong>{copy.appName}</strong>
            <span>{copy.appSubtitle}</span>
          </div>
        </div>

        <nav className="nav-list" aria-label="Primary">
          {PRIMARY_PAGE_ORDER.filter((page) => page !== "settings").map((page) => (
            <button
              key={page}
              className={page === activePage ? "nav-item active" : "nav-item"}
              onClick={() => setActivePage(page)}
              type="button"
            >
              <span>{copy.nav[page]}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-foot">
          <button
            className={activePage === "settings" ? "nav-item active" : "nav-item"}
            onClick={() => setActivePage("settings")}
            type="button"
          >
            <span>{copy.nav.settings}</span>
          </button>

          <div className="sidebar-mini">
            <small>{copy.currentIdentity}</small>
            <strong>{view.overview.currentIdentity || "-"}</strong>
          </div>
          <div className="sidebar-mini">
            <small>{copy.currentModel}</small>
            <strong>{view.overview.currentModel || "-"}</strong>
          </div>
        </div>
      </aside>

      <main className="workspace">
        <header className="workspace-head">
          <div>
            <h2>{copy.nav[activePage]}</h2>
            <p>{describePage(activePage, locale)}</p>
          </div>

          <div className="head-actions">
            <button
              className="ghost-button"
              disabled={loading || syncing}
              onClick={() => void refreshCurrentView(true)}
              type="button"
            >
              {copy.refresh}
            </button>
          </div>
        </header>

        {error ? <div className="banner banner-error">{error}</div> : null}
        {loading ? (
          <div className="banner banner-info">
            {locale === "en-US" ? "Refreshing latest state..." : "正在同步最新状态…"}
          </div>
        ) : null}
        {toast ? <div className="banner banner-toast">{toast}</div> : null}

        <TaskPanel
          copy={copy}
          locale={locale}
          task={task}
          taskDetailsOpen={taskDetailsOpen}
          toggleTaskDetails={() => setTaskDetailsOpen((current) => !current)}
        />

        <section className="workspace-scroll">
          {activePage === "overview" ? (
            <OverviewPage
              busyKey={busyKey}
              copy={copy}
              locale={locale}
              onOpenHistory={() => setActivePage("history")}
              onRunTask={runTask}
              onGoRepair={() => setActivePage("repair")}
              snapshot={view}
            />
          ) : null}

          {activePage === "models" ? (
            <ModelsPage
              busyKey={busyKey}
              copy={copy}
              draft={modelDraft}
              error={pageErrors.models ?? ""}
              loading={Boolean(pageLoading.models)}
              locale={locale}
              models={modelConfigs}
              onActivate={handleActivateModel}
              onDelete={handleDeleteModel}
              onDraftChange={setModelDraft}
              onNew={() => {
                setSelectedModelId("");
                setModelDraft(BLANK_MODEL);
              }}
              onSave={() => void handleSaveModel()}
              revealApiKey={revealApiKey}
              selectedModelId={selectedModelId}
              setRevealApiKey={setRevealApiKey}
              setSelectedModelId={setSelectedModelId}
            />
          ) : null}

          {activePage === "channels" ? (
            <MessagingPage
              busyKey={busyKey}
              channelsText={messagingChannelsText}
              copy={copy}
              error={pageErrors.channels ?? ""}
              loading={Boolean(pageLoading.channels)}
              locale={locale}
              onChannelsTextChange={setMessagingChannelsText}
              onSave={() => void handleSaveMessaging()}
              onSettingsChange={setMessagingDraft}
              settings={messagingDraft}
            />
          ) : null}

          {activePage === "history" ? (
            <HistoryPage
              copy={copy}
              error={pageErrors.history ?? ""}
              loading={Boolean(pageLoading.history)}
              locale={locale}
              onSearchChange={setSessionQuery}
              query={sessionQuery}
              selectedSession={selectedSession}
              selectedSessionId={selectedSessionId}
              setSelectedSessionId={setSelectedSessionId}
              sessionError={sessionError}
              sessionLoading={sessionLoading}
              sessionMessages={sessionMessages}
              sessions={visibleSessions}
            />
          ) : null}

          {activePage === "profiles" ? (
            <ProfilesPage
              archivePath={identityArchivePath}
              busyKey={busyKey}
              copy={copy}
              currentIdentity={currentIdentity}
              error={pageErrors.profiles ?? ""}
              exportPath={identityExportPath}
              identities={identities}
              importModelId={identityImportModelId}
              importName={identityImportName}
              loading={Boolean(pageLoading.profiles)}
              locale={locale}
              modelConfigs={profileModelConfigs}
              newIdentityModelId={newIdentityModelId}
              newIdentityName={newIdentityName}
              onBindModel={handleBindIdentityModel}
              onCreate={handleCreateIdentity}
              onDelete={handleDeleteIdentity}
              onExport={handleExportIdentity}
              onImport={handleImportIdentity}
              onRename={handleRenameIdentity}
              onSwitch={handleSwitchIdentity}
              renameTo={renameIdentityTo}
              selectedIdentity={selectedIdentity}
              selectedIdentityMeta={selectedIdentityMeta}
              setArchivePath={setIdentityArchivePath}
              setExportPath={setIdentityExportPath}
              setIdentityImportModelId={setIdentityImportModelId}
              setIdentityImportName={setIdentityImportName}
              setNewIdentityModelId={setNewIdentityModelId}
              setNewIdentityName={setNewIdentityName}
              setRenameTo={setRenameIdentityTo}
              setSelectedIdentity={setSelectedIdentity}
            />
          ) : null}

          {activePage === "settings" ? (
            <SettingsPage
              busyKey={busyKey}
              copy={copy}
              locale={locale}
              onRunTask={runTask}
              onSaveSettings={() => void handleSaveSettings()}
              setSettingsDraft={setSettingsDraft}
              settingsDraft={settingsDraft}
              snapshot={view}
            />
          ) : null}
        </section>
      </main>
    </div>
  );
}

function OverviewPage({
  busyKey,
  copy,
  locale,
  onRunTask,
  onOpenHistory,
  onGoRepair,
  snapshot
}: {
  busyKey: string;
  copy: ReturnType<typeof getCopy>;
  locale: LocaleCode;
  onRunTask: (request: StartTaskRequest) => void;
  onOpenHistory: () => void;
  onGoRepair: () => void;
  snapshot: AppStateSnapshot;
}) {
  const overviewStats = [
    {
      label: copy.hermesInstalled,
      value: snapshot.overview.hermesInstalled ? copy.active : copy.inactive,
      tone: snapshot.overview.hermesInstalled ? "ok" : "error"
    },
    {
      label: copy.gateway,
      value: snapshot.overview.gatewayHealthy ? copy.active : copy.inactive,
      tone: snapshot.overview.gatewayHealthy ? "ok" : "warning"
    },
    {
      label: copy.currentIdentity,
      value: snapshot.overview.currentIdentity || "-",
      tone: "info"
    },
    {
      label: copy.currentModel,
      value: snapshot.overview.currentModel || "-",
      tone: "info"
    }
  ];

  return (
    <div className="page-stack">
      <section className="glass-panel overview-panel">
        <div className="section-head section-head-wrap">
          <div className="hero-copy compact-hero-copy">
            <small>{copy.overview}</small>
            <h3>{renderOverviewHermesVersion(snapshot, locale)}</h3>
            <p>{renderOverviewGatewaySummary(snapshot, locale)}</p>
          </div>
          <div className="toolbar-actions">
            <button
              className="ghost-button"
              disabled={busyKey === "restart_gateway"}
              onClick={() => onRunTask({ taskType: "restart_gateway" })}
              type="button"
            >
              {copy.quickGateway}
            </button>
            <button className="ghost-button" onClick={onOpenHistory} type="button">
              {copy.openHistory}
            </button>
          </div>
        </div>

        <div className="stats-grid compact-stats-grid">
          {overviewStats.map((item) => (
            <article key={item.label} className="glass-panel stat-card compact-stat-card">
              <span>{item.label}</span>
              <strong className={`tone-${item.tone}`}>{item.value}</strong>
            </article>
          ))}
        </div>
      </section>

      <section className="overview-grid">
        <article className="glass-panel">
          <div className="section-head">
            <h3>{copy.lastDiagnosis}</h3>
            {overviewDiagnosisLabel(snapshot.overview.lastDiagnosisAt) ? (
              <span className="pill info">{overviewDiagnosisLabel(snapshot.overview.lastDiagnosisAt)}</span>
            ) : null}
          </div>

          {snapshot.recentIssues.length ? (
            <div className="compact-list">
              {snapshot.recentIssues.map((issue) => {
                const meta = describeIssue(issue.id, locale);
                return (
                  <button
                    key={issue.id}
                    className="list-row issue-row"
                    onClick={onGoRepair}
                    type="button"
                  >
                    <div>
                      <strong>{meta.title}</strong>
                      <p>{renderIssueDetail(issue, locale)}</p>
                    </div>
                    <span className={`pill ${severityClass(issue.severity)}`}>
                      {renderSeverity(issue.severity, locale)}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="empty-note">{copy.runDiagnoseHint}</p>
          )}
        </article>

        <article className="glass-panel">
          <div className="section-head">
            <h3>{copy.sessionHistory}</h3>
            <span className="pill info">{snapshot.overview.sessionCount}</span>
          </div>
          <p className="section-description">
            {locale === "en-US"
              ? "Session history is loaded on demand to keep the shell responsive."
              : "会话历史按需加载，避免启动和切页时拖慢整个界面。"}
          </p>
          <div className="form-actions">
            <button className="ghost-button" onClick={onOpenHistory} type="button">
              {copy.openHistory}
            </button>
          </div>
        </article>
      </section>
    </div>
  );
}

function TaskPanel({
  copy,
  locale,
  task,
  taskDetailsOpen,
  toggleTaskDetails
}: {
  copy: ReturnType<typeof getCopy>;
  locale: LocaleCode;
  task: TaskProgress | null;
  taskDetailsOpen: boolean;
  toggleTaskDetails: () => void;
}) {
  return (
    <section className={task ? "task-panel" : "task-panel task-panel-idle"}>
      <div className="section-head">
        <h3>{copy.currentTask}</h3>
        <div className="inline-actions">
          {task ? (
            <button className="ghost-button task-toggle-button" onClick={toggleTaskDetails} type="button">
              {taskDetailsOpen
                ? locale === "en-US"
                  ? "Hide Steps"
                  : "隐藏步骤"
                : locale === "en-US"
                  ? `Steps ${task.steps.filter((step) => step.status !== "pending").length}/${task.steps.length}`
                  : "查看步骤"}
            </button>
          ) : null}
          <span className={`pill ${task ? taskStatusClass(task.status) : "info"}`}>
            {task ? renderTaskStatus(task.status, locale) : copy.noTask}
          </span>
        </div>
      </div>

      {task ? (
        <div className="task-body">
          <div className="task-meta">
            <strong>{renderTaskHeadline(task, locale)}</strong>
            <span>{Math.max(0, Math.min(100, task.percent))}%</span>
          </div>
          <div className="progress-track">
            <span style={{ width: `${Math.max(6, task.percent)}%` }} />
          </div>
          <small className="task-caption">
            {task.finishedAt
              ? `${locale === "en-US" ? "Finished" : "完成于"} ${formatDate(task.finishedAt)}`
              : `${locale === "en-US" ? "Started" : "开始于"} ${formatDate(task.startedAt)}`}
          </small>
          {taskDetailsOpen ? (
            <div className="task-steps">
              {task.steps.map((step) => (
                <div key={step.id} className="task-step">
                  <span className={`step-dot ${step.status}`} />
                  <div>
                    <strong>{renderTaskStepLabel(task.taskType, step.id, step.label, locale)}</strong>
                    {step.detail ? <p>{renderTaskStepDetail(step.detail, locale)}</p> : null}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <p className="empty-note">{copy.noTask}</p>
      )}
    </section>
  );
}

function StartupGateScreen({
  activePage,
  archivePath,
  busyKey,
  checkingOfficialUpdate,
  checks,
  channelsText,
  copy,
  error,
  exportPath,
  historySessions,
  identities,
  importModelId,
  importName,
  issues,
  loading,
  locale,
  messagingError,
  messagingLoading,
  messagingSettings,
  modelConfigs,
  modelDraft,
  newIdentityModelId,
  newIdentityName,
  officialUpdate,
  onActivateModel,
  onBindIdentityModel,
  onChannelsTextChange,
  onCheckAction,
  onCheckUpdate,
  onCreateIdentity,
  onDeleteIdentity,
  onDeleteModel,
  onDiagnose,
  onDraftChange,
  onExportIdentity,
  onGoToPage,
  onImportIdentity,
  onIssueAction,
  onNewModel,
  onRefresh,
  onRenameIdentity,
  onRunTask,
  onSaveMessaging,
  onSaveModel,
  onSaveSettings,
  onSettingsChange,
  onSwitchIdentity,
  profileModelConfigs,
  revealApiKey,
  renameTo,
  selectedIdentity,
  selectedIdentityMeta,
  selectedModelId,
  sessionError,
  sessionLoading,
  sessionMessages,
  setArchivePath,
  setExportPath,
  setIdentityImportModelId,
  setIdentityImportName,
  setNewIdentityModelId,
  setNewIdentityName,
  setRenameTo,
  setRevealApiKey,
  setSelectedIdentity,
  setSelectedModelId,
  setSettingsDraft,
  settingsDraft,
  snapshot,
  task,
  taskDetailsOpen,
  toggleTaskDetails
}: {
  activePage: StartupPageId;
  archivePath: string;
  busyKey: string;
  checkingOfficialUpdate: boolean;
  checks: StatusCheck[];
  channelsText: string;
  copy: ReturnType<typeof getCopy>;
  error: string;
  exportPath: string;
  historySessions: SessionSummary[];
  identities: IdentitySummary[];
  importModelId: string;
  importName: string;
  issues: IssueItem[];
  loading: boolean;
  locale: LocaleCode;
  messagingError: string;
  messagingLoading: boolean;
  messagingSettings: MessagingSettingsInput;
  modelConfigs: ModelConfig[];
  modelDraft: ModelConfigInput;
  newIdentityModelId: string;
  newIdentityName: string;
  officialUpdate: OfficialUpdateSnapshot | null;
  onActivateModel: (modelId: string) => void;
  onBindIdentityModel: (identity: IdentitySummary, modelId: string) => void;
  onChannelsTextChange: (value: string) => void;
  onCheckAction: (check: StatusCheck) => void;
  onCheckUpdate: () => void;
  onCreateIdentity: () => void;
  onDeleteIdentity: () => void;
  onDeleteModel: (model: ModelConfig) => void;
  onDiagnose: () => void;
  onDraftChange: (value: ModelConfigInput) => void;
  onExportIdentity: () => void;
  onGoToPage: (page: StartupPageId) => void;
  onImportIdentity: () => void;
  onIssueAction: (issue: IssueItem) => void;
  onNewModel: () => void;
  onRefresh: () => void;
  onRenameIdentity: () => void;
  onRunTask: (request: StartTaskRequest) => void;
  onSaveMessaging: () => void;
  onSaveModel: () => void;
  onSaveSettings: () => void;
  onSettingsChange: (value: MessagingSettingsInput) => void;
  onSwitchIdentity: (identityName: string) => void;
  profileModelConfigs: ModelConfig[];
  revealApiKey: boolean;
  renameTo: string;
  selectedIdentity: string;
  selectedIdentityMeta: IdentitySummary | null;
  selectedModelId: string;
  sessionError: string;
  sessionLoading: boolean;
  sessionMessages: SessionMessage[];
  setArchivePath: (value: string) => void;
  setExportPath: (value: string) => void;
  setIdentityImportModelId: (value: string) => void;
  setIdentityImportName: (value: string) => void;
  setNewIdentityModelId: (value: string) => void;
  setNewIdentityName: (value: string) => void;
  setRenameTo: (value: string) => void;
  setRevealApiKey: (value: boolean) => void;
  setSelectedIdentity: (value: string) => void;
  setSelectedModelId: (value: string) => void;
  setSettingsDraft: (value: PanelSettingsInput) => void;
  settingsDraft: PanelSettingsInput;
  snapshot: AppStateSnapshot;
  task: TaskProgress | null;
  taskDetailsOpen: boolean;
  toggleTaskDetails: () => void;
}) {
  const bootPages: StartupPageId[] = [
    "install",
    "status",
    "repair",
    "models",
    "channels",
    "profiles",
    "settings"
  ];

  const selectedSession = historySessions[0] ?? null;

  return (
    <div className="startup-shell">
      <section className="startup-hero glass-panel">
        <div className="section-head section-head-wrap">
          <div className="hero-copy startup-hero-copy">
            <small>{locale === "en-US" ? "Startup Check" : "启动检查"}</small>
            <h1>
              {snapshot.overview.hermesInstalled
                ? locale === "en-US"
                  ? "Hermes needs to pass checks before entering the workspace"
                  : "Hermes 通过启动检查后才能进入主界面"
                : locale === "en-US"
                  ? "Complete Hermes initialization before entering the workspace"
                  : "请先完成 Hermes 安装初始化，再进入主界面"}
            </h1>
            <p>
              {locale === "en-US"
                ? "Install, diagnose and repair now. The main workspace unlocks only after Hermes is installed and no blocking issue remains."
                : "安装初始化、状态检查和异常修复统一前置到启动阶段。只有 Hermes 已安装且无阻断问题时，才会进入软件主界面。"}
            </p>
          </div>
          <div className="toolbar-actions">
            <button className="ghost-button" disabled={loading} onClick={onRefresh} type="button">
              {loading ? copy.loading : copy.refresh}
            </button>
          </div>
        </div>
      </section>

      {error ? <div className="banner banner-error">{error}</div> : null}

      <TaskPanel
        copy={copy}
        locale={locale}
        task={task}
        taskDetailsOpen={taskDetailsOpen}
        toggleTaskDetails={toggleTaskDetails}
      />

      <div className="startup-layout">
        <aside className="sidebar startup-sidebar">
          <nav className="nav-list" aria-label="Startup">
            {bootPages.map((page) => (
              <button
                key={page}
                className={page === activePage ? "nav-item active" : "nav-item"}
                onClick={() => onGoToPage(page)}
                type="button"
              >
                <span>{copy.nav[page]}</span>
              </button>
            ))}
          </nav>

          <div className="startup-summary">
            <div className="sidebar-mini">
              <small>{copy.hermesInstalled}</small>
              <strong className={snapshot.overview.hermesInstalled ? "tone-ok" : "tone-error"}>
                {snapshot.overview.hermesInstalled ? copy.active : copy.inactive}
              </strong>
            </div>
            <div className="sidebar-mini">
              <small>{locale === "en-US" ? "Blocking Issues" : "阻断问题"}</small>
              <strong>{issues.length}</strong>
            </div>
          </div>
        </aside>

        <main className="workspace startup-workspace">
          <header className="workspace-head">
            <div>
              <h2>{copy.nav[activePage]}</h2>
              <p>{describeStartupPage(activePage, locale)}</p>
            </div>
          </header>

          <section className="workspace-scroll">
            {activePage === "install" ? (
              <InstallPage
                busyKey={busyKey}
                checkingOfficialUpdate={checkingOfficialUpdate}
                copy={copy}
                locale={locale}
                officialUpdate={officialUpdate}
                onCheckUpdate={onCheckUpdate}
                onRunTask={onRunTask}
                snapshot={snapshot}
              />
            ) : null}

            {activePage === "status" ? (
              <StatusPage
                checks={checks}
                copy={copy}
                error=""
                loading={loading}
                locale={locale}
                onCheckAction={onCheckAction}
                onDiagnose={onDiagnose}
              />
            ) : null}

            {activePage === "repair" ? (
              <RepairPage
                busyKey={busyKey}
                copy={copy}
                error=""
                issues={issues}
                loading={loading}
                locale={locale}
                onDiagnose={onDiagnose}
                onIssueAction={(issue) => {
                  if (!issue.repairable && issue.targetPage) {
                    onGoToPage(startupPageForTarget(issue.targetPage));
                    return;
                  }
                  onIssueAction(issue);
                }}
                onRepairAll={() => onRunTask({ taskType: "repair_all" })}
                repairAllEnabled={issues.some((issue) => issue.repairable)}
              />
            ) : null}

            {activePage === "models" ? (
              <ModelsPage
                busyKey={busyKey}
                copy={copy}
                draft={modelDraft}
                error=""
                loading={false}
                locale={locale}
                models={modelConfigs}
                onActivate={onActivateModel}
                onDelete={onDeleteModel}
                onDraftChange={onDraftChange}
                onNew={onNewModel}
                onSave={onSaveModel}
                revealApiKey={revealApiKey}
                selectedModelId={selectedModelId}
                setRevealApiKey={setRevealApiKey}
                setSelectedModelId={setSelectedModelId}
              />
            ) : null}

            {activePage === "channels" ? (
              <MessagingPage
                busyKey={busyKey}
                channelsText={channelsText}
                copy={copy}
                error={messagingError}
                loading={messagingLoading}
                locale={locale}
                onChannelsTextChange={onChannelsTextChange}
                onSave={onSaveMessaging}
                onSettingsChange={onSettingsChange}
                settings={messagingSettings}
              />
            ) : null}

            {activePage === "profiles" ? (
              <ProfilesPage
                archivePath={archivePath}
                busyKey={busyKey}
                copy={copy}
                currentIdentity={identities.find((identity) => identity.current) ?? null}
                error=""
                exportPath={exportPath}
                identities={identities}
                importModelId={importModelId}
                importName={importName}
                loading={false}
                locale={locale}
                modelConfigs={profileModelConfigs}
                newIdentityModelId={newIdentityModelId}
                newIdentityName={newIdentityName}
                onBindModel={onBindIdentityModel}
                onCreate={onCreateIdentity}
                onDelete={onDeleteIdentity}
                onExport={onExportIdentity}
                onImport={onImportIdentity}
                onRename={onRenameIdentity}
                onSwitch={onSwitchIdentity}
                renameTo={renameTo}
                selectedIdentity={selectedIdentity}
                selectedIdentityMeta={selectedIdentityMeta}
                setArchivePath={setArchivePath}
                setExportPath={setExportPath}
                setIdentityImportModelId={setIdentityImportModelId}
                setIdentityImportName={setIdentityImportName}
                setNewIdentityModelId={setNewIdentityModelId}
                setNewIdentityName={setNewIdentityName}
                setRenameTo={setRenameTo}
                setSelectedIdentity={setSelectedIdentity}
              />
            ) : null}

            {activePage === "settings" ? (
              <SettingsPage
                busyKey={busyKey}
                copy={copy}
                locale={locale}
                onRunTask={onRunTask}
                onSaveSettings={onSaveSettings}
                setSettingsDraft={setSettingsDraft}
                settingsDraft={settingsDraft}
                snapshot={snapshot}
              />
            ) : null}

            {activePage === "status" && selectedSession ? (
              <section className="glass-panel startup-history-note">
                <div className="section-head">
                  <h3>{copy.sessionHistory}</h3>
                  <span className="pill info">{historySessions.length}</span>
                </div>
                {sessionError ? <div className="banner banner-error">{sessionError}</div> : null}
                <p className="section-description">
                  {locale === "en-US"
                    ? "History is available after startup finishes. The latest session preview is kept here for quick context."
                    : "会话历史会在启动完成后进入主界面，这里保留最近会话的快速预览。"}
                </p>
                <div className="meta-list">
                  <MetaRow label={locale === "en-US" ? "Latest Session" : "最近会话"} value={selectedSession.title || selectedSession.id} />
                  <MetaRow label={locale === "en-US" ? "Last Active" : "最近活跃"} value={formatDate(selectedSession.lastActive || selectedSession.startedAt)} />
                  <MetaRow
                    label={locale === "en-US" ? "Messages" : "消息数"}
                    value={sessionLoading ? copy.loading : String(selectedSession.messageCount)}
                  />
                  <MetaRow
                    label={locale === "en-US" ? "Preview" : "预览"}
                    value={sessionMessages[0]?.content || selectedSession.preview || "-"}
                  />
                </div>
              </section>
            ) : null}
          </section>
        </main>
      </div>
    </div>
  );
}

function InstallPage({
  busyKey,
  checkingOfficialUpdate,
  copy,
  locale,
  officialUpdate,
  onCheckUpdate,
  onRunTask,
  snapshot
}: {
  busyKey: string;
  checkingOfficialUpdate: boolean;
  copy: ReturnType<typeof getCopy>;
  locale: LocaleCode;
  officialUpdate: OfficialUpdateSnapshot | null;
  onCheckUpdate: () => void;
  onRunTask: (request: StartTaskRequest) => void;
  snapshot: AppStateSnapshot;
}) {
  return (
    <div className="page-stack">
      <section className="glass-panel">
        <div className="section-head">
          <h3>{copy.install}</h3>
          <span className={`pill ${snapshot.overview.hermesInstalled ? "ok" : "error"}`}>
            {snapshot.overview.hermesInstalled ? copy.active : copy.inactive}
          </span>
        </div>
        <p className="section-description">
          {snapshot.overview.hermesInstalled
            ? snapshot.overview.hermesVersion
            : locale === "en-US"
              ? "Hermes is not installed yet."
              : "当前尚未检测到 Hermes。"}
        </p>

        <div className="action-list">
          <ActionRow
            busy={busyKey === "install_official"}
            description={
              locale === "en-US"
                ? "Run the official install script silently in the backend."
                : "在后端静默执行 Hermes 官方安装脚本。"
            }
            onClick={() => onRunTask({ taskType: "install_official" })}
            title={copy.quickInstall}
          />
          <ActionRow
            busy={checkingOfficialUpdate}
            description={
              locale === "en-US"
                ? "Check the latest Hermes release metadata before deciding whether to update."
                : copy.updateCheckDescription
            }
            onClick={onCheckUpdate}
            title={checkingOfficialUpdate ? copy.checkingUpdates : copy.checkUpdates}
          />
          <ActionRow
            busy={busyKey === "diagnose"}
            description={
              locale === "en-US"
                ? "Read the current environment and build a structured health report."
                : "读取当前环境并生成结构化体检结果。"
            }
            onClick={() => onRunTask({ taskType: "diagnose" })}
            title={copy.quickDiagnose}
          />
        </div>

        {officialUpdate ? (
          <article className="update-result-card">
            <div className="section-head compact">
              <strong>
                {officialUpdate.updateAvailable
                  ? `${copy.updateAvailable} ${officialUpdate.latestVersion}`
                  : copy.upToDate}
              </strong>
              <span className={`pill ${officialUpdate.updateAvailable ? "warning" : "ok"}`}>
                {officialUpdate.updateAvailable ? copy.checkUpdates : copy.active}
              </span>
            </div>
            <div className="update-result-list">
              <p>{`${copy.currentVersion} ${officialUpdate.currentVersion || snapshot.overview.hermesVersion}`}</p>
              {officialUpdate.currentReleaseDate ? (
                <p>{`${copy.currentReleaseDate} ${officialUpdate.currentReleaseDate}`}</p>
              ) : null}
              <p>{`${copy.latestVersion} ${officialUpdate.latestVersion}`}</p>
              <p>{`${copy.releaseDate} ${officialUpdate.latestReleaseDate}`}</p>
              <p>{`${copy.checkedAt} ${officialUpdate.checkedAt}`}</p>
            </div>
            {officialUpdate.updateAvailable ? (
              <div className="form-actions">
                <button
                  className="primary-button"
                  disabled={busyKey === "official_update"}
                  onClick={() => onRunTask({ taskType: "official_update" })}
                  type="button"
                >
                  {`${copy.updateTo} ${officialUpdate.latestVersion}`}
                </button>
              </div>
            ) : null}
          </article>
        ) : null}
      </section>
    </div>
  );
}

function StatusPage({
  checks,
  copy,
  error,
  loading,
  locale,
  onCheckAction,
  onDiagnose
}: {
  checks: StatusCheck[];
  copy: ReturnType<typeof getCopy>;
  error: string;
  loading: boolean;
  locale: LocaleCode;
  onCheckAction: (check: StatusCheck) => void;
  onDiagnose: () => void;
}) {
  const counts = {
    ok: checks.filter((check) => check.status === "ok").length,
    warning: checks.filter((check) => check.status === "warning").length,
    error: checks.filter((check) => check.status === "error").length
  };

  return (
    <div className="page-stack">
      <section className="glass-panel">
        <div className="section-head">
          <h3>{copy.status}</h3>
          <button className="ghost-button" onClick={onDiagnose} type="button">
            {copy.rerunScan}
          </button>
        </div>
        <div className="status-pills">
          <span className="pill ok">
            {renderHealthLevel("ok", locale)} {counts.ok}
          </span>
          <span className="pill warning">
            {renderHealthLevel("warning", locale)} {counts.warning}
          </span>
          <span className="pill error">
            {renderHealthLevel("error", locale)} {counts.error}
          </span>
        </div>
      </section>

      <section className="glass-panel">
        {error ? <div className="banner banner-error">{error}</div> : null}
        {!checks.length ? (
          <p className="empty-note">{loading ? copy.loading : copy.empty}</p>
        ) : null}
        <div className="check-list">
          {checks.map((check) => {
            const meta = describeCheck(check.id, locale);
            return (
              <article key={check.id} className="check-item compact-check-item">
                <div className="check-main">
                  <div className="check-copy">
                    <strong>{meta.title}</strong>
                    <p>{renderCheckDetail(check, locale)}</p>
                  </div>
                  <div className="check-actions compact-check-actions">
                    <span className={`pill ${statusClass(check.status)}`}>
                      {renderHealthLevel(check.status, locale)}
                    </span>
                    <button className="ghost-button" onClick={() => onCheckAction(check)} type="button">
                      {meta.actionLabel}
                    </button>
                  </div>
                </div>
                <small className="check-hint">{meta.actionHint}</small>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function RepairPage({
  busyKey,
  copy,
  error,
  issues,
  loading,
  locale,
  onDiagnose,
  onIssueAction,
  onRepairAll,
  repairAllEnabled
}: {
  busyKey: string;
  copy: ReturnType<typeof getCopy>;
  error: string;
  issues: IssueItem[];
  loading: boolean;
  locale: LocaleCode;
  onDiagnose: () => void;
  onIssueAction: (issue: IssueItem) => void;
  onRepairAll: () => void;
  repairAllEnabled: boolean;
}) {
  const repairableCount = issues.filter((issue) => issue.repairable).length;

  return (
    <div className="page-stack">
      <section className="glass-panel">
        <div className="section-head">
          <h3>{copy.issueList}</h3>
          <div className="inline-actions">
            <button className="ghost-button" onClick={onDiagnose} type="button">
              {copy.quickDiagnose}
            </button>
            <button
              className="primary-button"
              disabled={!repairAllEnabled || busyKey === "repair_all"}
              onClick={onRepairAll}
              type="button"
            >
              {copy.quickRepair}
            </button>
          </div>
        </div>
        <div className="status-pills">
          <span className="pill info">{issues.length}</span>
          <span className={`pill ${repairableCount ? "warning" : "ok"}`}>
            {locale === "en-US" ? `Repairable ${repairableCount}` : `可修复 ${repairableCount}`}
          </span>
        </div>
      </section>

      {issues.length ? (
        <section className="dense-stack">
          {error ? <div className="banner banner-error">{error}</div> : null}
          {issues.map((issue) => {
            const meta = describeIssue(issue.id, locale);
            return (
              <article key={issue.id} className="glass-panel issue-card compact-issue-card issue-row-card">
                <div className="issue-row-main">
                  <div className="issue-copy compact-issue-copy">
                    <div className="section-head issue-row-head">
                      <h3>{meta.title}</h3>
                      <span className={`pill ${severityClass(issue.severity)}`}>
                        {renderSeverity(issue.severity, locale)}
                      </span>
                    </div>
                    <p>
                      <strong>{copy.problemCause}:</strong> {renderIssueDetail(issue, locale)}
                    </p>
                    <p>
                      <strong>{copy.repairSuggestion}:</strong> {meta.recommendation}
                    </p>
                  </div>
                  <button
                    className={issue.repairable ? "primary-button" : "ghost-button"}
                    onClick={() => onIssueAction(issue)}
                    type="button"
                  >
                    {issue.repairable
                      ? locale === "en-US"
                        ? "Repair"
                        : "修复"
                      : locale === "en-US"
                        ? "Open"
                        : "前往处理"}
                  </button>
                </div>
              </article>
            );
          })}
        </section>
      ) : (
        <section className="glass-panel">
          {error ? <div className="banner banner-error">{error}</div> : null}
          <p className="empty-note">{loading ? copy.loading : copy.runDiagnoseHint}</p>
        </section>
      )}
    </div>
  );
}

function ModelsPage({
  busyKey,
  copy,
  draft,
  error,
  loading,
  locale,
  models,
  onActivate,
  onDelete,
  onDraftChange,
  onNew,
  onSave,
  revealApiKey,
  selectedModelId,
  setRevealApiKey,
  setSelectedModelId
}: {
  busyKey: string;
  copy: ReturnType<typeof getCopy>;
  draft: ModelConfigInput;
  error: string;
  loading: boolean;
  locale: LocaleCode;
  models: ModelConfig[];
  onActivate: (modelId: string) => void;
  onDelete: (model: ModelConfig) => void;
  onDraftChange: (value: ModelConfigInput) => void;
  onNew: () => void;
  onSave: () => void;
  revealApiKey: boolean;
  selectedModelId: string;
  setRevealApiKey: (value: boolean) => void;
  setSelectedModelId: (value: string) => void;
}) {
  return (
    <div className="tool-split models-layout">
      <section className="glass-panel side-panel">
        <div className="section-head">
          <h3>{copy.models}</h3>
          <button className="ghost-button" onClick={onNew} type="button">
            {copy.create}
          </button>
        </div>

        {error ? <div className="banner banner-error">{error}</div> : null}
        <div className="compact-list">
          {models.length ? (
            models.map((model) => (
              <button
                key={model.id}
                className={selectedModelId === model.id ? "list-row active-row" : "list-row"}
                onClick={() => {
                  setSelectedModelId(model.id);
                  onDraftChange(modelToDraft(model));
                }}
                type="button"
              >
                <div>
                  <strong>{model.name}</strong>
                  <p>
                    {model.provider} · {model.model}
                  </p>
                </div>
                <span className={`pill ${model.isActive ? "ok" : "info"}`}>
                  {model.isActive ? copy.active : copy.inactive}
                </span>
              </button>
            ))
          ) : (
            <p className="empty-note">{loading ? copy.loading : copy.empty}</p>
          )}
        </div>
      </section>

      <section className="glass-panel content-panel form-panel">
        <div className="section-head">
          <h3>{selectedModelId ? copy.models : copy.create}</h3>
          {selectedModelId ? (
            <button className="ghost-button" onClick={onNew} type="button">
              {copy.create}
            </button>
          ) : null}
        </div>

        {selectedModelId ? (
          <div className="meta-strip">
            <span
              className={`pill ${models.find((model) => model.id === selectedModelId)?.isActive ? "ok" : "info"}`}
            >
              {models.find((model) => model.id === selectedModelId)?.isActive
                ? copy.active
                : copy.inactive}
            </span>
            <small>
              {draft.provider} · {draft.model || "-"}
            </small>
          </div>
        ) : null}

        <div className="form-grid compact-form-grid">
          <label className="field">
            <span>{copy.modelName}</span>
            <input
              onChange={(event) => onDraftChange({ ...draft, name: event.target.value })}
              value={draft.name}
            />
          </label>

          <label className="field">
            <span>{copy.providerType}</span>
            <select
              onChange={(event) => onDraftChange({ ...draft, provider: event.target.value })}
              value={draft.provider}
            >
              <option value="openrouter">OpenRouter</option>
              <option value="openai">OpenAI</option>
              <option value="custom">Custom</option>
            </select>
          </label>

          <label className="field">
            <span>Model</span>
            <input
              onChange={(event) => onDraftChange({ ...draft, model: event.target.value })}
              value={draft.model}
            />
          </label>

          <label className="field field-wide">
            <span>{copy.apiKey}</span>
            <div className="secret-input">
              <input
                onChange={(event) => onDraftChange({ ...draft, apiKey: event.target.value })}
                type={revealApiKey ? "text" : "password"}
                value={draft.apiKey}
              />
              <button
                className="ghost-button"
                onClick={() => setRevealApiKey(!revealApiKey)}
                type="button"
              >
                {revealApiKey ? "Hide" : "Show"}
              </button>
            </div>
          </label>

          <label className="field field-wide">
            <span>{copy.baseUrl}</span>
            <input
              onChange={(event) => onDraftChange({ ...draft, baseUrl: event.target.value })}
              value={draft.baseUrl}
            />
          </label>
        </div>

        <div className="form-actions">
          <button className="primary-button" disabled={busyKey === "save-model"} onClick={onSave} type="button">
            {copy.save}
          </button>
          {selectedModelId ? (
            <>
              <button
                className="ghost-button"
                disabled={busyKey === `activate-model:${selectedModelId}`}
                onClick={() => onActivate(selectedModelId)}
                type="button"
              >
                {copy.setActive}
              </button>
              <button
                className="danger-button"
                disabled={busyKey === `delete-model:${selectedModelId}`}
                onClick={() => {
                  const model = models.find((item) => item.id === selectedModelId);
                  if (model) {
                    onDelete(model);
                  }
                }}
                type="button"
              >
                {copy.delete}
              </button>
            </>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function MessagingPage({
  busyKey,
  channelsText,
  copy,
  error,
  loading,
  locale,
  onChannelsTextChange,
  onSave,
  onSettingsChange,
  settings
}: {
  busyKey: string;
  channelsText: string;
  copy: ReturnType<typeof getCopy>;
  error: string;
  loading: boolean;
  locale: LocaleCode;
  onChannelsTextChange: (value: string) => void;
  onSave: () => void;
  onSettingsChange: (value: MessagingSettingsInput) => void;
  settings: MessagingSettingsInput;
}) {
  return (
    <div className="page-stack">
      <section className="glass-panel settings-grid messaging-grid">
        <article className="glass-panel settings-panel">
          <div className="section-head">
            <h3>{copy.channels}</h3>
          </div>
          <p className="section-description">
            {locale === "en-US"
              ? "Manage Hermes IM working directory and Discord channel behavior from one place."
              : "集中管理 Hermes IM 工作目录，以及 Discord 消息渠道的响应行为。"}
          </p>

          {error ? <div className="banner banner-error">{error}</div> : null}
          {!error && loading ? <p className="empty-note">{copy.loading}</p> : null}

          <div className="form-grid messaging-form-grid">
            <label className="field field-wide">
              <span>{copy.messagingWorkingDir}</span>
              <input
                onChange={(event) =>
                  onSettingsChange({ ...settings, messagingCwd: event.target.value })
                }
                placeholder={
                  locale === "en-US" ? "Optional working directory for messaging runtime" : "可选：消息运行时工作目录"
                }
                value={settings.messagingCwd}
              />
            </label>

            <label className="field checkbox-field">
              <div className="setting-copy">
                <strong>{copy.groupSessionsPerUser}</strong>
                <small>
                  {locale === "en-US"
                    ? "Split group conversations by user to avoid mixing contexts."
                    : "群聊里按用户拆分会话，避免上下文混在一起。"}
                </small>
              </div>
              <input
                checked={settings.groupSessionsPerUser}
                onChange={(event) =>
                  onSettingsChange({
                    ...settings,
                    groupSessionsPerUser: event.target.checked
                  })
                }
                type="checkbox"
              />
            </label>

            <label className="field checkbox-field">
              <div className="setting-copy">
                <strong>{copy.discordRequireMention}</strong>
                <small>
                  {locale === "en-US"
                    ? "Only respond in Discord when Hermes is explicitly mentioned."
                    : "Discord 中仅在明确提及 Hermes 时响应。"}
                </small>
              </div>
              <input
                checked={settings.discordRequireMention}
                onChange={(event) =>
                  onSettingsChange({
                    ...settings,
                    discordRequireMention: event.target.checked
                  })
                }
                type="checkbox"
              />
            </label>

            <label className="field checkbox-field">
              <div className="setting-copy">
                <strong>{copy.discordAutoThread}</strong>
                <small>
                  {locale === "en-US"
                    ? "Create or continue Discord threads automatically for responses."
                    : "在 Discord 中自动创建或续用线程回复。"}
                </small>
              </div>
              <input
                checked={settings.discordAutoThread}
                onChange={(event) =>
                  onSettingsChange({
                    ...settings,
                    discordAutoThread: event.target.checked
                  })
                }
                type="checkbox"
              />
            </label>

            <label className="field field-wide">
              <span>{copy.discordFreeResponseChannels}</span>
              <textarea
                className="channels-textarea"
                onChange={(event) => onChannelsTextChange(event.target.value)}
                placeholder={
                  locale === "en-US"
                    ? "One Discord channel per line, for example:\ngeneral\nops-room"
                    : "每行一个 Discord 频道，例如：\ngeneral\nops-room"
                }
                value={channelsText}
              />
            </label>
          </div>

          <div className="form-actions">
            <button className="primary-button" disabled={busyKey === "save-messaging"} onClick={onSave} type="button">
              {copy.save}
            </button>
          </div>
        </article>

        <article className="glass-panel">
          <div className="section-head">
            <h3>{locale === "en-US" ? "Current Preview" : "当前配置预览"}</h3>
          </div>
          <div className="meta-list">
            <MetaRow label={copy.messagingWorkingDir} value={settings.messagingCwd || "-"} />
            <MetaRow
              label={copy.groupSessionsPerUser}
              value={settings.groupSessionsPerUser ? copy.active : copy.inactive}
            />
            <MetaRow
              label={copy.discordRequireMention}
              value={settings.discordRequireMention ? copy.active : copy.inactive}
            />
            <MetaRow
              label={copy.discordAutoThread}
              value={settings.discordAutoThread ? copy.active : copy.inactive}
            />
            <MetaRow
              label={copy.discordFreeResponseChannels}
              value={channelsText.trim() || "-"}
            />
          </div>
        </article>
      </section>
    </div>
  );
}

function HistoryPage({
  copy,
  error,
  loading,
  locale,
  onSearchChange,
  query,
  selectedSession,
  selectedSessionId,
  setSelectedSessionId,
  sessionError,
  sessionLoading,
  sessionMessages,
  sessions
}: {
  copy: ReturnType<typeof getCopy>;
  error: string;
  loading: boolean;
  locale: LocaleCode;
  onSearchChange: (value: string) => void;
  query: string;
  selectedSession: SessionSummary | null;
  selectedSessionId: string;
  setSelectedSessionId: (value: string) => void;
  sessionError: string;
  sessionLoading: boolean;
  sessionMessages: SessionMessage[];
  sessions: SessionSummary[];
}) {
  return (
    <div className="tool-split history-layout">
      <section className="glass-panel side-panel">
        <div className="section-head">
          <h3>{copy.sessionHistory}</h3>
          <span className="pill info">{sessions.length}</span>
        </div>

        <label className="field">
          <span>{copy.search}</span>
          <input onChange={(event) => onSearchChange(event.target.value)} value={query} />
        </label>

        {error ? <div className="banner banner-error">{error}</div> : null}
        <div className="session-list">
          {sessions.length ? (
            sessions.map((session) => (
              <button
                key={session.id}
                className={selectedSessionId === session.id ? "session-item active-row" : "session-item"}
                onClick={() => setSelectedSessionId(session.id)}
                type="button"
              >
                <div>
                  <strong>{session.title || session.id}</strong>
                  <p>{session.preview || session.model}</p>
                </div>
                <small>{formatDate(session.lastActive || session.startedAt)}</small>
              </button>
            ))
          ) : (
            <p className="empty-note">{loading ? copy.loading : copy.empty}</p>
          )}
        </div>
      </section>

      <section className="glass-panel content-panel transcript-panel">
        {selectedSession ? (
          <>
            <div className="section-head">
              <h3>{selectedSession.title || selectedSession.id}</h3>
              <span className="pill info">{selectedSession.messageCount}</span>
            </div>
            <p className="section-description">
              {selectedSession.model} · {formatDate(selectedSession.lastActive || selectedSession.startedAt)}
            </p>

            {sessionError ? <div className="banner banner-error">{sessionError}</div> : null}
            {sessionLoading ? (
              <p className="empty-note">{copy.loading}</p>
            ) : (
              <div className="message-stream">
                {sessionMessages.length ? (
                  sessionMessages.map((message) => (
                    <article key={message.id} className="message-card">
                      <div className="message-head">
                        <strong>{message.role || "unknown"}</strong>
                        <small>{formatDate(message.timestamp)}</small>
                      </div>
                      <pre>{message.content || (locale === "en-US" ? "(empty)" : "（空内容）")}</pre>
                    </article>
                  ))
                ) : (
                  <p className="empty-note">{copy.empty}</p>
                )}
              </div>
            )}
          </>
        ) : (
          <p className="empty-note">{copy.empty}</p>
        )}
      </section>
    </div>
  );
}

function ProfilesPage({
  archivePath,
  busyKey,
  copy,
  currentIdentity,
  error,
  exportPath,
  identities,
  importModelId,
  importName,
  loading,
  locale,
  modelConfigs,
  newIdentityModelId,
  newIdentityName,
  onBindModel,
  onCreate,
  onDelete,
  onExport,
  onImport,
  onRename,
  onSwitch,
  renameTo,
  selectedIdentity,
  selectedIdentityMeta,
  setArchivePath,
  setExportPath,
  setIdentityImportModelId,
  setIdentityImportName,
  setNewIdentityModelId,
  setNewIdentityName,
  setRenameTo,
  setSelectedIdentity
}: {
  archivePath: string;
  busyKey: string;
  copy: ReturnType<typeof getCopy>;
  currentIdentity: IdentitySummary | null;
  error: string;
  exportPath: string;
  identities: IdentitySummary[];
  importModelId: string;
  importName: string;
  loading: boolean;
  locale: LocaleCode;
  modelConfigs: ModelConfig[];
  newIdentityModelId: string;
  newIdentityName: string;
  onBindModel: (identity: IdentitySummary, modelId: string) => void;
  onCreate: () => void;
  onDelete: () => void;
  onExport: () => void;
  onImport: () => void;
  onRename: () => void;
  onSwitch: (identityName: string) => void;
  renameTo: string;
  selectedIdentity: string;
  selectedIdentityMeta: IdentitySummary | null;
  setArchivePath: (value: string) => void;
  setExportPath: (value: string) => void;
  setIdentityImportModelId: (value: string) => void;
  setIdentityImportName: (value: string) => void;
  setNewIdentityModelId: (value: string) => void;
  setNewIdentityName: (value: string) => void;
  setRenameTo: (value: string) => void;
  setSelectedIdentity: (value: string) => void;
}) {
  return (
    <div className="tool-split profile-layout">
      <section className="glass-panel side-panel">
        <div className="section-head">
          <h3>{copy.profiles}</h3>
          <span className="pill info">{identities.length}</span>
        </div>

        {currentIdentity ? (
          <div className="meta-strip profile-list-meta">
            <span className="pill ok">{copy.active}</span>
            <small>{currentIdentity.name}</small>
          </div>
        ) : null}

        {error ? <div className="banner banner-error">{error}</div> : null}
        <div className="compact-list">
          {identities.length ? (
            identities.map((identity) => (
              <button
                key={identity.name}
                className={selectedIdentity === identity.name ? "list-row active-row" : "list-row"}
                onClick={() => setSelectedIdentity(identity.name)}
                type="button"
              >
                <div>
                  <strong>{identity.name}</strong>
                  <p>{identity.linkedModelName || "-"}</p>
                </div>
                <span className={`pill ${identity.current ? "ok" : "info"}`}>
                  {identity.current ? copy.active : copy.inactive}
                </span>
              </button>
            ))
          ) : (
            <p className="empty-note">{loading ? copy.loading : copy.empty}</p>
          )}
        </div>
      </section>

      <section className="glass-panel content-panel profile-content-panel">
        <div className="section-head">
          <h3>{selectedIdentityMeta ? selectedIdentityMeta.name : copy.profiles}</h3>
          {selectedIdentityMeta ? (
            <div className="inline-actions">
              <button
                className="ghost-button"
                disabled={busyKey === `switch-identity:${selectedIdentityMeta.name}`}
                onClick={() => onSwitch(selectedIdentityMeta.name)}
                type="button"
              >
                {copy.switchTo}
              </button>
              <button
                className="danger-button"
                disabled={busyKey.startsWith("delete-identity")}
                onClick={onDelete}
                type="button"
              >
                {copy.delete}
              </button>
            </div>
          ) : null}
        </div>

        {selectedIdentityMeta ? (
          <>
            <div className="meta-strip">
              <span className={`pill ${selectedIdentityMeta.current ? "ok" : "info"}`}>
                {selectedIdentityMeta.current ? copy.active : copy.inactive}
              </span>
              <small>{selectedIdentityMeta.linkedModelName || "-"}</small>
            </div>

            <div className="form-grid compact-form-grid">
              <label className="field">
                <span>{copy.rename}</span>
                <input onChange={(event) => setRenameTo(event.target.value)} value={renameTo} />
              </label>
              <label className="field">
                <span>{copy.linkedModel}</span>
                <select
                  onChange={(event) => onBindModel(selectedIdentityMeta, event.target.value)}
                  value={selectedIdentityMeta.linkedModelConfigId || ""}
                >
                  <option value="">-</option>
                  {modelConfigs.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>{copy.exportPath}</span>
                <input onChange={(event) => setExportPath(event.target.value)} value={exportPath} />
              </label>
            </div>

            <div className="form-actions compact-actions">
              <button
                className="ghost-button"
                disabled={busyKey.startsWith("rename-identity")}
                onClick={onRename}
                type="button"
              >
                {copy.rename}
              </button>
              <button
                className="ghost-button"
                disabled={busyKey.startsWith("export-identity")}
                onClick={onExport}
                type="button"
              >
                {copy.export}
              </button>
            </div>
          </>
        ) : (
          <p className="empty-note">{copy.empty}</p>
        )}

        <div className="panel-divider" />

        <div className="profile-tools-grid">
          <div className="subpanel">
            <div className="section-head">
              <h3>{copy.createIdentity}</h3>
            </div>

            <div className="form-grid compact-form-grid">
              <label className="field">
                <span>{copy.modelName}</span>
                <input
                  onChange={(event) => setNewIdentityName(event.target.value)}
                  value={newIdentityName}
                />
              </label>
              <label className="field">
                <span>{copy.linkedModel}</span>
                <select
                  onChange={(event) => setNewIdentityModelId(event.target.value)}
                  value={newIdentityModelId}
                >
                  <option value="">-</option>
                  {modelConfigs.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="form-actions compact-actions">
              <button
                className="primary-button"
                disabled={busyKey === "create-identity"}
                onClick={onCreate}
                type="button"
              >
                {copy.create}
              </button>
            </div>
          </div>

          <div className="subpanel">
            <div className="section-head">
              <h3>{copy.importIdentity}</h3>
            </div>

            <div className="form-grid compact-form-grid">
              <label className="field">
                <span>{copy.archivePath}</span>
                <input onChange={(event) => setArchivePath(event.target.value)} value={archivePath} />
              </label>
              <label className="field">
                <span>{copy.modelName}</span>
                <input onChange={(event) => setIdentityImportName(event.target.value)} value={importName} />
              </label>
              <label className="field">
                <span>{copy.linkedModel}</span>
                <select
                  onChange={(event) => setIdentityImportModelId(event.target.value)}
                  value={importModelId}
                >
                  <option value="">-</option>
                  {modelConfigs.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="form-actions compact-actions">
              <button
                className="primary-button"
                disabled={busyKey === "import-identity"}
                onClick={onImport}
                type="button"
              >
                {copy.import}
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function SettingsPage({
  busyKey,
  copy,
  locale,
  onRunTask,
  onSaveSettings,
  setSettingsDraft,
  settingsDraft,
  snapshot
}: {
  busyKey: string;
  copy: ReturnType<typeof getCopy>;
  locale: LocaleCode;
  onRunTask: (request: StartTaskRequest) => void;
  onSaveSettings: () => void;
  setSettingsDraft: (value: PanelSettingsInput) => void;
  settingsDraft: PanelSettingsInput;
  snapshot: AppStateSnapshot;
}) {
  return (
    <div className="page-stack">
      <section className="settings-grid">
        <article className="glass-panel settings-panel">
          <div className="section-head">
            <h3>{copy.settings}</h3>
          </div>

          <div className="settings-stack">
            <label className="field checkbox-field">
              <div className="setting-copy">
                <strong>{copy.launchAtStartup}</strong>
                <small>
                  {locale === "en-US"
                    ? "Enabled after installation and can be changed here."
                    : "安装后默认启用，可在这里随时修改。"}
                </small>
              </div>
              <input
                checked={settingsDraft.launchAtStartup}
                onChange={(event) =>
                  setSettingsDraft({
                    ...settingsDraft,
                    launchAtStartup: event.target.checked
                  })
                }
                type="checkbox"
              />
            </label>

            <div className="setting-row">
              <div className="setting-copy">
                <strong>{copy.language}</strong>
                <small>
                  {locale === "en-US"
                    ? "Switch application language without touching config files."
                    : "直接切换界面语言，无需编辑配置文件。"}
                </small>
              </div>
              <div className="setting-control">
                <select
                  onChange={(event) =>
                    setSettingsDraft({
                      ...settingsDraft,
                      language: event.target.value as LocaleCode
                    })
                  }
                  value={settingsDraft.language}
                >
                  <option value="zh-CN">{renderLanguageOptionLabel("zh-CN", locale)}</option>
                  <option value="en-US">{renderLanguageOptionLabel("en-US", locale)}</option>
                </select>
              </div>
            </div>
          </div>

          <div className="form-actions">
            <button className="primary-button" disabled={busyKey === "save-settings"} onClick={onSaveSettings} type="button">
              {copy.save}
            </button>
          </div>
        </article>

        <article className="glass-panel">
          <div className="section-head">
            <h3>{copy.about}</h3>
          </div>

          <div className="meta-list">
            <MetaRow label={copy.versionInfo} value={snapshot.about.appVersion} />
            <MetaRow label="Platform" value={`${snapshot.about.platform} / ${snapshot.about.arch}`} />
            <MetaRow label="Hermes" value={snapshot.about.hermesPath || "-"} />
            <MetaRow label="Hermes Home" value={snapshot.about.hermesHome || "-"} />
            <MetaRow label="Panel Home" value={snapshot.about.panelHome || "-"} />
            <MetaRow label={copy.autoUpdate} value={snapshot.about.updaterStatus || copy.updaterPlanning} />
          </div>
        </article>
      </section>

      <section className="glass-panel">
        <div className="section-head">
          <h3>{copy.uninstall}</h3>
        </div>
        <div className="action-list">
          <ActionRow
            busy={busyKey === "uninstall_hermes"}
            description={
              locale === "en-US"
                ? "Try a silent Hermes CLI uninstall."
                : "尝试静默卸载 Hermes Agent。"
            }
            onClick={() => {
              if (
                window.confirm(
                  locale === "en-US"
                    ? "Uninstall Hermes Agent?"
                    : "确认卸载 Hermes Agent 吗？"
                )
              ) {
                onRunTask({ taskType: "uninstall_hermes" });
              }
            }}
            title={copy.uninstallHermes}
          />
          <ActionRow
            busy={busyKey === "uninstall_hermes_clean"}
            description={
              locale === "en-US"
                ? "Uninstall Hermes Agent and remove Hermes data."
                : "卸载 Hermes Agent，并清理 Hermes 数据目录。"
            }
            onClick={() => {
              if (
                window.confirm(
                  locale === "en-US"
                    ? "Uninstall Hermes Agent and remove data?"
                    : "确认卸载 Hermes Agent 并清理数据吗？"
                )
              ) {
                onRunTask({ taskType: "uninstall_hermes_clean" });
              }
            }}
            tone="danger"
            title={copy.uninstallHermesClean}
          />
          <ActionRow
            busy={busyKey === "uninstall_panel"}
            description={
              locale === "en-US"
                ? "Schedule app self-uninstall after exit."
                : "应用退出后计划卸载 Hermes Panel。"
            }
            onClick={() => {
              if (
                window.confirm(
                  locale === "en-US"
                    ? "Uninstall Hermes Panel after exit?"
                    : "确认在退出后卸载 Hermes Panel 吗？"
                )
              ) {
                onRunTask({ taskType: "uninstall_panel" });
              }
            }}
            tone="danger"
            title={copy.uninstallPanel}
          />
        </div>
      </section>
    </div>
  );
}

function ActionRow({
  busy,
  description,
  onClick,
  title,
  tone = "primary"
}: {
  busy: boolean;
  description: string;
  onClick: () => void;
  title: string;
  tone?: "primary" | "danger" | "ghost";
}) {
  const buttonClass =
    tone === "danger" ? "danger-button" : tone === "ghost" ? "ghost-button" : "primary-button";

  return (
    <article className="action-row">
      <div className="action-row-copy">
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
      <button className={buttonClass} disabled={busy} onClick={onClick} type="button">
        {title}
      </button>
    </article>
  );
}

function BrandMark() {
  return <img className="brand-mark" src={panelIcon} alt="" aria-hidden="true" />;
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="meta-row">
      <small>{label}</small>
      <span>{value || "-"}</span>
    </div>
  );
}

function modelToDraft(model: ModelConfig): ModelConfigInput {
  return {
    id: model.id,
    name: model.name,
    provider: model.provider,
    model: model.model,
    apiKey: model.apiKey,
    baseUrl: model.baseUrl
  };
}

function normalizeModelDraft(draft: ModelConfigInput): ModelConfigInput {
  return {
    id: draft.id || null,
    name: draft.name.trim(),
    provider: draft.provider.trim(),
    model: draft.model.trim(),
    apiKey: draft.apiKey.trim(),
    baseUrl: draft.baseUrl.trim()
  };
}

function statusClass(status: StatusCheck["status"]) {
  switch (status) {
    case "ok":
      return "ok";
    case "error":
      return "error";
    case "warning":
      return "warning";
    default:
      return "info";
  }
}

function severityClass(severity: IssueItem["severity"]) {
  switch (severity) {
    case "high":
      return "error";
    case "medium":
      return "warning";
    default:
      return "info";
  }
}

function taskStatusClass(status: TaskStatus) {
  switch (status) {
    case "success":
      return "ok";
    case "failed":
      return "error";
    case "partial_success":
      return "warning";
    default:
      return "info";
  }
}

function renderTaskStatus(status: TaskStatus, locale: LocaleCode) {
  const copy = getCopy(locale);
  switch (status) {
    case "queued":
      return copy.taskQueued;
    case "running":
      return copy.taskRunning;
    case "success":
      return copy.taskSuccess;
    case "failed":
      return copy.taskFailed;
    case "partial_success":
      return copy.taskPartial;
  }
}

function renderHealthLevel(status: StatusCheck["status"], locale: LocaleCode) {
  const zh = {
    ok: "正常",
    warning: "关注",
    error: "异常",
    info: "信息"
  };
  const en = {
    ok: "Healthy",
    warning: "Warning",
    error: "Error",
    info: "Info"
  };
  return locale === "en-US" ? en[status] : zh[status];
}

function renderSeverity(severity: IssueItem["severity"], locale: LocaleCode) {
  const zh = {
    low: "低风险",
    medium: "中风险",
    high: "高风险"
  };
  const en = {
    low: "Low",
    medium: "Medium",
    high: "High"
  };
  return locale === "en-US" ? en[severity] : zh[severity];
}

function describePage(page: PageId, locale: LocaleCode) {
  const zh: Record<PageId, string> = {
    overview: "汇总当前安装状态、身份、模型、网关与最近体检结果。",
    install: "只保留 Hermes 官方安装与更新入口，全部后端静默执行。",
    status: "将 Hermes 核心运行条件拆成可检查、可重扫的问题项。",
    repair: "集中展示异常列表、建议与一键批量修复入口。",
    models: "通过表单管理 Provider、模型、Key 和 URL，不暴露配置文件。",
    channels: "管理 Hermes IM 工作目录和 Discord 消息渠道行为。",
    history: "只读查看 Hermes 已有会话历史和消息内容。",
    profiles: "管理身份、切换当前身份并绑定对应模型配置。",
    settings: "管理自启动、语言、版本信息和卸载入口。"
  };

  const en: Record<PageId, string> = {
    overview: "Summarize install state, identity, model, gateway and recent diagnosis.",
    install: "Official Hermes install and update only, always handled silently in backend.",
    status: "Break Hermes runtime prerequisites into explicit checks and rescans.",
    repair: "Show issue list, suggestions and batch repair entry in one place.",
    models: "Manage provider, model, key and URL from forms instead of raw files.",
    channels: "Manage Hermes IM working directory and Discord channel behavior.",
    history: "Read existing Hermes sessions and transcript history in read-only mode.",
    profiles: "Manage identities, switch active identity and bind model configs.",
    settings: "Manage startup, language, version info and uninstall entries."
  };

  return locale === "en-US" ? en[page] : zh[page];
}

function describeStartupPage(page: StartupPageId, locale: LocaleCode) {
  return describePage(page, locale);
}

function describeCheck(id: string, locale: LocaleCode) {
  const zh: Record<string, { title: string; detail: string; actionLabel: string; actionHint: string }> = {
    hermes_installed: {
      title: "Hermes 已安装",
      detail: "确认本机可执行文件是否存在。",
      actionLabel: "官方安装",
      actionHint: "缺失时可直接执行官方安装。"
    },
    hermes_version: {
      title: "Hermes 版本",
      detail: "读取当前 Hermes CLI 版本。",
      actionLabel: "重新扫描",
      actionHint: "异常时建议重跑体检。"
    },
    model_configured: {
      title: "模型已配置",
      detail: "是否存在当前可用的默认模型。",
      actionLabel: "前往模型配置",
      actionHint: "缺失时需补充模型配置。"
    },
    provider_key_configured: {
      title: "Provider Key 已配置",
      detail: "检查 API Key 是否已录入。",
      actionLabel: "前往模型配置",
      actionHint: "缺失时请补录 Key。"
    },
    gateway_available: {
      title: "Gateway 可用",
      detail: "检查 Gateway 服务是否可达。",
      actionLabel: "重启网关",
      actionHint: "异常时可尝试重启。"
    },
    config_file: {
      title: "config.yaml 可读",
      detail: "确认 Hermes 主配置文件存在。",
      actionLabel: "重新扫描",
      actionHint: "缺失时可在修复页创建默认文件。"
    },
    env_file: {
      title: ".env 可读",
      detail: "确认 Hermes 环境变量文件存在。",
      actionLabel: "重新扫描",
      actionHint: "缺失时可在修复页创建默认文件。"
    },
    state_db: {
      title: "state.db 存在",
      detail: "确认 Hermes 数据库存在。",
      actionLabel: "重新扫描",
      actionHint: "缺失时历史会回退读取 JSON。"
    },
    sessions_dir: {
      title: "sessions 目录",
      detail: "确认 Hermes 会话目录存在。",
      actionLabel: "重新扫描",
      actionHint: "会影响历史读取能力。"
    },
    logs_dir: {
      title: "logs 目录",
      detail: "确认 Hermes 日志目录存在。",
      actionLabel: "重新扫描",
      actionHint: "缺失时仅影响日志来源。"
    },
    active_profile: {
      title: "活动身份有效",
      detail: "确认当前身份可被识别。",
      actionLabel: "重新扫描",
      actionHint: "异常时建议切换身份。"
    }
  };

  const en: Record<string, { title: string; detail: string; actionLabel: string; actionHint: string }> = {
    hermes_installed: {
      title: "Hermes Installed",
      detail: "Check whether the Hermes executable is present.",
      actionLabel: "Install",
      actionHint: "Run the official install if missing."
    },
    hermes_version: {
      title: "Hermes Version",
      detail: "Read the current Hermes CLI version.",
      actionLabel: "Rescan",
      actionHint: "Run diagnose again if it looks wrong."
    },
    model_configured: {
      title: "Model Configured",
      detail: "Check whether a default model exists.",
      actionLabel: "Open Models",
      actionHint: "Add a model config if missing."
    },
    provider_key_configured: {
      title: "Provider Key Configured",
      detail: "Check whether an API key is stored.",
      actionLabel: "Open Models",
      actionHint: "Add a key if missing."
    },
    gateway_available: {
      title: "Gateway Available",
      detail: "Check whether the gateway service is reachable.",
      actionLabel: "Restart Gateway",
      actionHint: "Try a restart if unavailable."
    },
    config_file: {
      title: "config.yaml",
      detail: "Ensure the main Hermes config file exists.",
      actionLabel: "Rescan",
      actionHint: "Missing files can be recreated from repair."
    },
    env_file: {
      title: ".env",
      detail: "Ensure the Hermes environment file exists.",
      actionLabel: "Rescan",
      actionHint: "Missing files can be recreated from repair."
    },
    state_db: {
      title: "state.db",
      detail: "Ensure the Hermes database exists.",
      actionLabel: "Rescan",
      actionHint: "History falls back to JSON if missing."
    },
    sessions_dir: {
      title: "sessions Directory",
      detail: "Ensure the Hermes sessions directory exists.",
      actionLabel: "Rescan",
      actionHint: "It affects history browsing."
    },
    logs_dir: {
      title: "logs Directory",
      detail: "Ensure the Hermes logs directory exists.",
      actionLabel: "Rescan",
      actionHint: "It affects log-derived diagnostics."
    },
    active_profile: {
      title: "Active Identity",
      detail: "Ensure the current identity is valid.",
      actionLabel: "Rescan",
      actionHint: "Switch identity if needed."
    }
  };

  const table = locale === "en-US" ? en : zh;
  return table[id] ?? table.hermes_version;
}

function describeIssue(id: string, locale: LocaleCode) {
  const zh: Record<string, { title: string; cause: string; recommendation: string }> = {
    hermes_missing: {
      title: "Hermes 未安装",
      cause: "系统中未检测到 Hermes 可执行文件。",
      recommendation: "执行官方安装脚本并在完成后重新扫描。"
    },
    model_missing: {
      title: "缺少模型配置",
      cause: "当前默认模型为空，无法直接发起模型调用。",
      recommendation: "前往模型配置页新增或设定一个默认模型。"
    },
    provider_missing: {
      title: "缺少 Provider Key",
      cause: "当前没有可用的 API Key。",
      recommendation: "前往模型配置页补录 Key 与 URL。"
    },
    gateway_unavailable: {
      title: "Gateway 不可用",
      cause: "Gateway 服务未就绪或状态异常。",
      recommendation: "尝试重启网关，必要时执行安装/修复。"
    },
    config_missing: {
      title: "缺少 config.yaml",
      cause: "Hermes 主配置文件不存在。",
      recommendation: "创建默认配置文件，再回到模型配置页补充内容。"
    },
    env_missing: {
      title: "缺少 .env",
      cause: "Hermes 环境变量文件不存在。",
      recommendation: "创建默认 .env 后录入对应 Provider Key。"
    },
    active_profile_missing: {
      title: "当前身份异常",
      cause: "没有识别到当前可用身份。",
      recommendation: "前往配置身份页切换或新建身份。"
    },
    state_db_missing: {
      title: "缺少 state.db",
      cause: "Hermes 数据库不存在，可能影响历史读取。",
      recommendation: "保留现状或等待后续会话自动生成数据库。"
    }
  };

  const en: Record<string, { title: string; cause: string; recommendation: string }> = {
    hermes_missing: {
      title: "Hermes Missing",
      cause: "No Hermes executable was detected on this machine.",
      recommendation: "Run the official installer and rescan afterwards."
    },
    model_missing: {
      title: "Model Missing",
      cause: "No default model is configured yet.",
      recommendation: "Add or activate a model config from the Models page."
    },
    provider_missing: {
      title: "Provider Key Missing",
      cause: "No API key is currently available.",
      recommendation: "Open Models and add the provider key and base URL."
    },
    gateway_unavailable: {
      title: "Gateway Unavailable",
      cause: "The gateway service is not healthy or not reachable.",
      recommendation: "Try restarting the gateway, then diagnose again."
    },
    config_missing: {
      title: "config.yaml Missing",
      cause: "The main Hermes config file does not exist.",
      recommendation: "Create default files first, then complete model setup."
    },
    env_missing: {
      title: ".env Missing",
      cause: "The Hermes environment file does not exist.",
      recommendation: "Create a default .env and enter the provider key."
    },
    active_profile_missing: {
      title: "Active Identity Invalid",
      cause: "The current identity could not be resolved.",
      recommendation: "Switch to another identity or create a new one."
    },
    state_db_missing: {
      title: "state.db Missing",
      cause: "The Hermes database file does not exist.",
      recommendation: "Leave it as-is or wait for Hermes to recreate it later."
    }
  };

  const table = locale === "en-US" ? en : zh;
  return table[id] ?? table.gateway_unavailable;
}

const KNOWN_TEXT_BY_LOCALE = {
  "zh-CN": {
    hermesDetected: "已检测到 Hermes",
    hermesNotInstalled: "未安装",
    syncLatestState: "正在同步最新状态…",
    syncStatePending: "状态同步中，请稍候。",
    hermesNotFound: "未检测到 `hermes` 可执行文件",
    gatewayUnavailable: "Gateway 尚未可用",
    providerKeyMissing: "缺少 Provider Key。",
    modelMissing: "未配置默认模型。",
    modelNotConfiguredYet: "尚未配置默认模型。",
    activeIdentityMissing: "未识别到当前身份。",
    activeIdentityInvalid: "未识别到当前活动身份。",
    detectingLocalIdentities: "正在识别本地身份。",
    noIssues: "体检完成，未发现异常。",
    officialInstallPrepared: "已准备官方安装脚本。",
    officialInstallDone: "官方安装执行完成，请按需再次体检。",
    officialUpdateDone: "官方更新完成。",
    gatewayRestarted: "Gateway 已重启。",
    gatewayRepairDone: "Gateway 修复完成。",
    configRepairDone: "配置文件修复完成。",
    noBatchRepair: "没有可执行的一键修复项，请先运行体检。",
    batchRepairDone: "一键修复完成。",
    hermesUninstallDone: "Hermes Agent 卸载完成。",
    panelUninstallScheduled: "Hermes Panel 将在退出后卸载。",
    officialInstallReadyStep: "准备官方安装",
    officialInstallRunStep: "执行安装脚本",
    rescanStep: "重新扫描状态",
    diagnoseReadStep: "读取当前环境",
    diagnoseAnalyzeStep: "分析异常项",
    diagnoseSyncStep: "同步界面",
    updateStep: "执行官方更新",
    restartGatewayStep: "重启 Gateway",
    reinstallGatewayStep: "重新安装 Gateway 服务",
    restartGatewayAgainStep: "再次重启 Gateway",
    createDefaultFilesStep: "创建默认配置文件",
    uninstallHermesStep: "卸载 Hermes Agent",
    cleanupHermesStep: "清理 Hermes 数据",
    scheduleUninstallStep: "计划卸载 Hermes Panel",
    issueRepairStep: "修复",
    readHermesStateDone: "已读取 Hermes 当前状态。",
    updateIssueListDone: "已更新问题列表与修复入口。",
    restartFailedRetryInstall: "直接重启失败，继续尝试重新安装服务。",
    defaultFilesCreated: "已创建默认配置文件。",
    defaultFilesCompleted: "已补全默认 config.yaml 与 .env。",
    noBatchRepairNeeded: "该问题无需批量修复。",
    uninstallDoneStep: "卸载流程已完成。",
    panelUninstallAfterExit: "应用将在退出后执行卸载。",
    cleanedHermesData: "已清理 Hermes 数据目录。",
    finishedAt: "完成于",
    startedAt: "开始于",
    steps: "查看步骤",
    hideSteps: "隐藏步骤",
    chinese: "中文",
    english: "English"
  },
  "en-US": {
    hermesDetected: "Hermes detected",
    hermesNotInstalled: "Not installed",
    syncLatestState: "Refreshing latest state...",
    syncStatePending: "Syncing latest state. Please wait.",
    hermesNotFound: "Hermes executable was not found.",
    gatewayUnavailable: "Gateway is not available yet.",
    providerKeyMissing: "Provider API key is missing.",
    modelMissing: "No default model is configured.",
    modelNotConfiguredYet: "No default model is configured yet.",
    activeIdentityMissing: "No active identity was detected.",
    activeIdentityInvalid: "No active identity was detected.",
    detectingLocalIdentities: "Detecting local identities.",
    noIssues: "Diagnosis completed with no issues.",
    officialInstallPrepared: "Official installer is ready.",
    officialInstallDone: "Official install completed. Run diagnosis again if needed.",
    officialUpdateDone: "Official update completed.",
    gatewayRestarted: "Gateway restarted.",
    gatewayRepairDone: "Gateway repair completed.",
    configRepairDone: "Default files were repaired.",
    noBatchRepair: "No batch repair actions are available yet. Run diagnosis first.",
    batchRepairDone: "Batch repair completed.",
    hermesUninstallDone: "Hermes Agent uninstall completed.",
    panelUninstallScheduled: "Hermes Panel will uninstall after exit.",
    officialInstallReadyStep: "Prepare Official Install",
    officialInstallRunStep: "Run Install Script",
    rescanStep: "Rescan State",
    diagnoseReadStep: "Read Environment",
    diagnoseAnalyzeStep: "Analyze Issues",
    diagnoseSyncStep: "Sync Interface",
    updateStep: "Run Official Update",
    restartGatewayStep: "Restart Gateway",
    reinstallGatewayStep: "Reinstall Gateway Service",
    restartGatewayAgainStep: "Restart Gateway Again",
    createDefaultFilesStep: "Create Default Files",
    uninstallHermesStep: "Uninstall Hermes Agent",
    cleanupHermesStep: "Clean Hermes Data",
    scheduleUninstallStep: "Schedule Hermes Panel Uninstall",
    issueRepairStep: "Repair",
    readHermesStateDone: "Read the current Hermes state.",
    updateIssueListDone: "Updated the issue list and repair entry.",
    restartFailedRetryInstall: "Direct restart failed. Retrying with a service reinstall.",
    defaultFilesCreated: "Created the default configuration files.",
    defaultFilesCompleted: "Created default config.yaml and .env files.",
    noBatchRepairNeeded: "This issue does not require batch repair.",
    uninstallDoneStep: "Uninstall flow completed.",
    panelUninstallAfterExit: "The app will uninstall after it exits.",
    cleanedHermesData: "Removed the Hermes data directory.",
    finishedAt: "Finished",
    startedAt: "Started",
    steps: "Steps",
    hideSteps: "Hide Steps",
    chinese: "Chinese",
    english: "English"
  }
} satisfies Record<LocaleCode, Record<string, string>>;

type KnownTextId = keyof (typeof KNOWN_TEXT_BY_LOCALE)["zh-CN"];

const KNOWN_TEXT_ALIASES = new Map<string, KnownTextId>([
  ["已检测到 Hermes", "hermesDetected"],
  ["Hermes detected", "hermesDetected"],
  ["未安装", "hermesNotInstalled"],
  ["Not installed", "hermesNotInstalled"],
  ["正在同步最新状态…", "syncLatestState"],
  ["Refreshing latest state...", "syncLatestState"],
  ["状态同步中，请稍候。", "syncStatePending"],
  ["Syncing latest state. Please wait.", "syncStatePending"],
  ["未检测到 `hermes` 可执行文件", "hermesNotFound"],
  ["Hermes executable was not found.", "hermesNotFound"],
  ["Gateway 尚未可用", "gatewayUnavailable"],
  ["Gateway is not available yet.", "gatewayUnavailable"],
  ["缺少 Provider Key。", "providerKeyMissing"],
  ["Provider API key is missing.", "providerKeyMissing"],
  ["未配置默认模型。", "modelMissing"],
  ["No default model is configured.", "modelMissing"],
  ["尚未配置默认模型。", "modelNotConfiguredYet"],
  ["No default model is configured yet.", "modelNotConfiguredYet"],
  ["未识别到当前身份。", "activeIdentityMissing"],
  ["No active identity was detected.", "activeIdentityMissing"],
  ["未识别到当前活动身份。", "activeIdentityInvalid"],
  ["正在识别本地身份。", "detectingLocalIdentities"],
  ["Detecting local identities.", "detectingLocalIdentities"],
  ["体检完成，未发现异常。", "noIssues"],
  ["Diagnosis completed with no issues.", "noIssues"],
  ["已准备官方安装脚本。", "officialInstallPrepared"],
  ["Official installer is ready.", "officialInstallPrepared"],
  ["官方安装执行完成，请按需再次体检。", "officialInstallDone"],
  ["Official install completed. Run diagnosis again if needed.", "officialInstallDone"],
  ["官方更新完成。", "officialUpdateDone"],
  ["Official update completed.", "officialUpdateDone"],
  ["Gateway 已重启。", "gatewayRestarted"],
  ["Gateway restarted.", "gatewayRestarted"],
  ["Gateway 修复完成。", "gatewayRepairDone"],
  ["Gateway repair completed.", "gatewayRepairDone"],
  ["配置文件修复完成。", "configRepairDone"],
  ["Default files were repaired.", "configRepairDone"],
  ["没有可执行的一键修复项，请先运行体检。", "noBatchRepair"],
  ["No batch repair actions are available yet. Run diagnosis first.", "noBatchRepair"],
  ["一键修复完成。", "batchRepairDone"],
  ["Batch repair completed.", "batchRepairDone"],
  ["Hermes Agent 卸载完成。", "hermesUninstallDone"],
  ["Hermes Agent uninstall completed.", "hermesUninstallDone"],
  ["Hermes Panel 将在退出后卸载。", "panelUninstallScheduled"],
  ["Hermes Panel will uninstall after exit.", "panelUninstallScheduled"],
  ["已读取 Hermes 当前状态。", "readHermesStateDone"],
  ["Read the current Hermes state.", "readHermesStateDone"],
  ["已更新问题列表与修复入口。", "updateIssueListDone"],
  ["Updated the issue list and repair entry.", "updateIssueListDone"],
  ["直接重启失败，继续尝试重新安装服务。", "restartFailedRetryInstall"],
  ["Direct restart failed. Retrying with a service reinstall.", "restartFailedRetryInstall"],
  ["已创建默认配置文件。", "defaultFilesCreated"],
  ["Created the default configuration files.", "defaultFilesCreated"],
  ["已补全默认 config.yaml 与 .env。", "defaultFilesCompleted"],
  ["Created default config.yaml and .env files.", "defaultFilesCompleted"],
  ["该问题无需批量修复。", "noBatchRepairNeeded"],
  ["This issue does not require batch repair.", "noBatchRepairNeeded"],
  ["卸载流程已完成。", "uninstallDoneStep"],
  ["Uninstall flow completed.", "uninstallDoneStep"],
  ["应用将在退出后执行卸载。", "panelUninstallAfterExit"],
  ["The app will uninstall after it exits.", "panelUninstallAfterExit"],
  ["已清理 Hermes 数据目录。", "cleanedHermesData"],
  ["Removed the Hermes data directory.", "cleanedHermesData"]
]);

function knownText(locale: LocaleCode, id: KnownTextId) {
  return KNOWN_TEXT_BY_LOCALE[locale][id];
}

function localizeKnownText(value: string, locale: LocaleCode): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return trimmed;
  }

  const directId = KNOWN_TEXT_ALIASES.get(trimmed);
  if (directId) {
    return KNOWN_TEXT_BY_LOCALE[locale][directId];
  }

  const matchedIdentities = trimmed.match(/^已识别\s+(\d+)\s+个本地身份。$/);
  if (matchedIdentities) {
    return locale === "en-US"
      ? `Detected ${matchedIdentities[1]} local identit${matchedIdentities[1] === "1" ? "y" : "ies"}.`
      : trimmed;
  }

  const matchedIssues = trimmed.match(/^体检完成，共发现\s+(\d+)\s+个问题。$/);
  if (matchedIssues) {
    return locale === "en-US"
      ? `Diagnosis completed with ${matchedIssues[1]} issue(s).`
      : trimmed;
  }

  const matchedFailedSteps = trimmed.match(/^一键修复完成，但有\s+(\d+)\s+个步骤失败。$/);
  if (matchedFailedSteps) {
    return locale === "en-US"
      ? `Batch repair completed, but ${matchedFailedSteps[1]} step(s) failed.`
      : trimmed;
  }

  const matchedCurrentStatus = trimmed.match(/^当前状态：(.+)$/);
  if (matchedCurrentStatus) {
    return locale === "en-US"
      ? `Current status: ${localizeKnownText(matchedCurrentStatus[1], locale)}`
      : `当前状态：${localizeKnownText(matchedCurrentStatus[1], locale)}`;
  }

  const matchedCurrentVersion = trimmed.match(/^当前版本：(.+)$/);
  if (matchedCurrentVersion) {
    return locale === "en-US"
      ? `Current version: ${localizeKnownText(matchedCurrentVersion[1], locale)}`
      : `当前版本：${localizeKnownText(matchedCurrentVersion[1], locale)}`;
  }

  return value;
}

function renderOverviewHermesVersion(snapshot: AppStateSnapshot, locale: LocaleCode) {
  const version = snapshot.overview.hermesVersion.trim();
  if (!version) {
    return "Hermes Agent";
  }

  if (/^\d/.test(version) || /^v?\d/i.test(version)) {
    return version;
  }

  if (snapshot.overview.hermesInstalled) {
    return localizeKnownText(version, locale) || knownText(locale, "hermesDetected");
  }

  return localizeKnownText(version, locale) || knownText(locale, "hermesNotInstalled");
}

function renderOverviewGatewaySummary(snapshot: AppStateSnapshot, locale: LocaleCode) {
  const summary = snapshot.overview.gatewaySummary.trim();
  if (!summary) {
    return describePage("overview", locale);
  }
  return localizeKnownText(summary, locale);
}

function renderCheckDetail(check: StatusCheck, locale: LocaleCode) {
  const detail = localizeKnownText(check.detail, locale).trim();
  if (detail && detail !== check.detail.trim()) {
    return detail;
  }

  if (check.id === "model_configured" && check.status !== "ok") {
    return knownText(locale, "modelMissing");
  }

  if (check.id === "provider_key_configured" && check.status !== "ok") {
    return knownText(locale, "providerKeyMissing");
  }

  if (check.id === "active_profile" && check.status !== "ok") {
    return knownText(locale, "activeIdentityMissing");
  }

  if (check.id === "hermes_installed" && check.status !== "ok") {
    return knownText(locale, "hermesNotFound");
  }

  if (check.id === "gateway_available" && check.status !== "ok" && !detail) {
    return knownText(locale, "gatewayUnavailable");
  }

  return detail || describeCheck(check.id, locale).detail;
}

function renderIssueDetail(issue: IssueItem, locale: LocaleCode) {
  const detail = localizeKnownText(issue.detail, locale).trim();
  if (detail && detail !== issue.detail.trim()) {
    return detail;
  }

  if (issue.id === "model_missing") {
    return knownText(locale, "modelNotConfiguredYet");
  }

  if (issue.id === "provider_missing") {
    return knownText(locale, "providerKeyMissing");
  }

  if (issue.id === "active_profile_missing") {
    return knownText(locale, "activeIdentityInvalid");
  }

  if (issue.id === "hermes_missing") {
    return knownText(locale, "hermesNotFound");
  }

  return detail || describeIssue(issue.id, locale).cause;
}

function renderTaskHeadline(task: TaskProgress, locale: LocaleCode) {
  if (task.summary.trim()) {
    return localizeKnownText(task.summary, locale);
  }

  return renderTaskType(task.taskType, locale);
}

function renderTaskType(taskType: string, locale: LocaleCode) {
  const en: Record<string, string> = {
    diagnose: "Diagnosis",
    install_official: "Official Install",
    official_update: "Official Update",
    repair_gateway: "Gateway Repair",
    repair_missing_files: "Repair Missing Files",
    repair_all: "Batch Repair",
    restart_gateway: "Restart Gateway",
    uninstall_hermes: "Uninstall Hermes Agent",
    uninstall_hermes_clean: "Uninstall Hermes Agent + Data",
    uninstall_panel: "Uninstall Hermes Panel"
  };
  const zh: Record<string, string> = {
    diagnose: "一键体检",
    install_official: "官方安装",
    official_update: "官方更新",
    repair_gateway: "修复 Gateway",
    repair_missing_files: "修复配置文件",
    repair_all: "一键修复",
    restart_gateway: "重启网关",
    uninstall_hermes: "卸载 Hermes Agent",
    uninstall_hermes_clean: "卸载 Hermes Agent 并清理数据",
    uninstall_panel: "卸载 Hermes Panel"
  };
  const table = locale === "en-US" ? en : zh;
  return table[taskType] ?? taskType;
}

function renderTaskStepLabel(taskType: string, stepId: string, fallback: string, locale: LocaleCode) {
  const labelIdMap: Record<string, keyof (typeof KNOWN_TEXT_BY_LOCALE)["zh-CN"]> = {
    read: "diagnoseReadStep",
    analyze: "diagnoseAnalyzeStep",
    done: "diagnoseSyncStep",
    prepare: "officialInstallReadyStep",
    install: "officialInstallRunStep",
    rescan: "rescanStep",
    update: "updateStep",
    "gateway-restart": "restartGatewayStep",
    "gateway-install": "reinstallGatewayStep",
    "gateway-resume": "restartGatewayAgainStep",
    "repair-files": "createDefaultFilesStep",
    uninstall: "uninstallHermesStep",
    cleanup: "cleanupHermesStep",
    schedule: "scheduleUninstallStep"
  };

  const mapped = labelIdMap[stepId];
  if (mapped) {
    return knownText(locale, mapped);
  }

  if (stepId.includes("_missing") || stepId === "gateway_unavailable") {
    const title = describeIssue(stepId, locale).title;
    return locale === "en-US" ? `${knownText(locale, "issueRepairStep")} ${title}` : `修复 ${title}`;
  }

  return localizeKnownText(fallback, locale);
}

function renderTaskStepDetail(detail: string, locale: LocaleCode) {
  return localizeKnownText(detail, locale);
}

function renderLanguageOptionLabel(optionLocale: LocaleCode, currentLocale: LocaleCode) {
  if (optionLocale === "zh-CN") {
    return knownText(currentLocale, "chinese");
  }

  return knownText(currentLocale, "english");
}

function invokeWithTimeout<T>(
  command: string,
  args: Record<string, unknown>,
  timeoutMs: number,
  timeoutMessage: string
) {
  let timer = 0;

  return Promise.race([
    invoke<T>(command, args),
    new Promise<T>((_, reject) => {
      timer = window.setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
    })
  ]).finally(() => {
    window.clearTimeout(timer);
  });
}

function invokeWithoutArgsWithTimeout<T>(command: string, timeoutMs: number, timeoutMessage: string) {
  let timer = 0;

  return Promise.race([
    invoke<T>(command),
    new Promise<T>((_, reject) => {
      timer = window.setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
    })
  ]).finally(() => {
    window.clearTimeout(timer);
  });
}

function normalizeError(value: unknown) {
  if (value instanceof Error) {
    return value.message;
  }

  return String(value);
}

function sleep(duration: number) {
  return new Promise((resolve) => window.setTimeout(resolve, duration));
}

function formatDate(value: string) {
  if (!value) {
    return "-";
  }

  return value.replace("T", " ").replace("Z", "");
}

export default App;
