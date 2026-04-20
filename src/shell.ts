import type { AppStateSnapshot, IssueItem, PageId } from "./types";

export const PRIMARY_PAGE_ORDER: PageId[] = [
  "overview",
  "models",
  "channels",
  "history",
  "profiles",
  "settings"
];

export type StartupPageId =
  | "install"
  | "status"
  | "repair"
  | "models"
  | "channels"
  | "profiles"
  | "settings";

export type StartupGateDecision = {
  ready: boolean;
  page: StartupPageId;
};

export function resolveStartupGate(
  snapshot: Pick<AppStateSnapshot, "overview">,
  issues: IssueItem[]
): StartupGateDecision {
  if (!snapshot.overview.hermesInstalled) {
    return { ready: false, page: "install" };
  }

  const blockingIssue = issues[0];
  if (!blockingIssue) {
    return { ready: true, page: "status" };
  }

  return {
    ready: false,
    page: startupPageForTarget(blockingIssue.targetPage)
  };
}

export function startupPageForTarget(targetPage: PageId | null | undefined): StartupPageId {
  switch (targetPage) {
    case "models":
      return "models";
    case "channels":
      return "channels";
    case "profiles":
      return "profiles";
    case "settings":
      return "settings";
    case "install":
      return "install";
    case "status":
      return "status";
    default:
      return "repair";
  }
}

export function overviewDiagnosisLabel(lastDiagnosisAt: string): string {
  return lastDiagnosisAt.trim();
}
