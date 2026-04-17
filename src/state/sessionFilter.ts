import type { SessionSummary } from "../types";

export function filterSessionsByQuery(
  sessions: SessionSummary[],
  query: string
): SessionSummary[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return sessions;
  }

  return sessions.filter((session) => {
    const haystack = [
      session.title,
      session.model,
      session.preview,
      session.source,
      session.id
    ]
      .join(" ")
      .toLowerCase();

    return haystack.includes(normalizedQuery);
  });
}
