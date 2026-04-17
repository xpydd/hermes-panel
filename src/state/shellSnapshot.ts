import type {
  AppStateSnapshot,
  HistoryPageSnapshot,
  ModelsPageSnapshot,
  ProfilesPageSnapshot,
  RepairPageSnapshot
} from "../types";

type ShellSnapshotPages = {
  repairPage?: RepairPageSnapshot | null;
  historyPage?: HistoryPageSnapshot | null;
  modelsPage?: ModelsPageSnapshot | null;
  profilesPage?: ProfilesPageSnapshot | null;
};

export function mergeShellSnapshotData(
  next: AppStateSnapshot,
  pages: ShellSnapshotPages
): AppStateSnapshot {
  const merged: AppStateSnapshot = {
    ...next,
    overview: { ...next.overview },
    recentIssues: [...next.recentIssues]
  };

  if (pages.repairPage) {
    merged.overview.issueCount = pages.repairPage.issues.length;
    merged.overview.repairableIssueCount = pages.repairPage.repairableIssueCount;
    if (pages.repairPage.lastDiagnosisAt) {
      merged.overview.lastDiagnosisAt = pages.repairPage.lastDiagnosisAt;
    }
    if (pages.repairPage.issues.length) {
      merged.recentIssues = pages.repairPage.issues.slice(0, 4);
    }
  }

  if (pages.historyPage) {
    merged.overview.sessionCount = pages.historyPage.sessions.length;
  }

  const activeModel = pages.modelsPage?.modelConfigs.find((model) => model.isActive);
  if (activeModel?.name) {
    merged.overview.currentModel = activeModel.name;
  }

  const activeIdentity = pages.profilesPage?.identities.find((identity) => identity.current);
  if (activeIdentity?.name) {
    merged.overview.currentIdentity = activeIdentity.name;
  }

  return merged;
}
