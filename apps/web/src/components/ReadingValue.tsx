import type { Event } from "../types";

export function ReadingValue({ event, expanded = false }: {
  event: Pick<Event, "importance" | "summaryKind">;
  expanded?: boolean;
}) {
  const value = event.importance?.trim();
  if (event.summaryKind !== "copilot" || !value) return null;
  return expanded
    ? <section className="ns-reading-callout ns-reading-value-expanded"><h3>阅读价值</h3><p>{value}</p></section>
    : <details className="ns-reading-value"><summary>阅读价值</summary><p>{value}</p></details>;
}
