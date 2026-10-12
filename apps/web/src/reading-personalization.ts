import type { QueryClient } from "@tanstack/react-query";
import type { ReadingPersonalization, ReaderSession, ReadingSurface } from "./types";

export const readingThresholdMs = 20_000;
const idleMs = 30_000;

export function isReadingPersonalization(value: unknown): value is ReadingPersonalization {
  if (typeof value !== "object" || value === null) return false;
  return "enabled" in value && typeof value.enabled === "boolean" &&
    "signalCount" in value && typeof value.signalCount === "number" && Number.isSafeInteger(value.signalCount) && value.signalCount >= 0 &&
    "generation" in value && (typeof value.generation === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.generation) || value.generation === null && !value.enabled);
}

export function acceptReadingPersonalization(client: QueryClient, value: ReadingPersonalization, expectedGeneration?: string) {
  if (!isReadingPersonalization(value)) throw new Error("阅读学习设置响应不完整。");
  client.setQueryData<ReaderSession>(["session"], previous => {
    if (!previous || expectedGeneration && previous.readingPersonalization?.generation !== expectedGeneration) return previous;
    return { ...previous, readingPersonalization: value };
  });
}

export function readingSurface(path: string): ReadingSurface {
  if (path === "/" || path.startsWith("/briefs")) return "brief";
  const section = path.split("/")[1];
  switch (section) {
    case "radar": case "reading": case "weekly": case "saved": case "topics": return section;
    default: return "article";
  }
}

// Count sampled foreground time, never wall-clock time after a suspended tab.
export function createReadingClock(start: number) {
  let previous = start, lastActivity = start, wasEligible = false, activeMs = 0;
  return {
    sample(now: number, eligible: boolean, activity = false) {
      const elapsed = now - previous;
      if (wasEligible && elapsed > 0 && elapsed <= 2_000) {
        activeMs += Math.max(0, Math.min(now, lastActivity + idleMs) - previous);
      }
      previous = now;
      if (activity) lastActivity = now;
      wasEligible = eligible && now - lastActivity < idleMs;
      return activeMs;
    },
  };
}
