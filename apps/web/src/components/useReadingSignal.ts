import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type RefObject } from "react";
import { useLocation } from "react-router-dom";
import { api, ApiError } from "../api";
import { useReaderSession } from "../auth";
import { acceptReadingPersonalization, createReadingClock, isReadingPersonalization, readingSurface, readingThresholdMs } from "../reading-personalization";
import type { Event, ReadingSignal } from "../types";

export function useReadingSignal(event: Pick<Event, "id" | "contentVersion"> | undefined, pane: RefObject<HTMLElement | null>) {
  const session = useReaderSession(), client = useQueryClient(), { pathname } = useLocation();
  const settings = session.readingPersonalization;
  const surface = readingSurface(pathname);
  const enabled = !!session.user && session.identityVerified && settings?.enabled === true && !!settings.generation;
  const key = `${session.user?.id}:${settings?.generation}:${event?.id}:${event?.contentVersion}:${surface}`;
  const completed = useRef(new Set<string>());
  const retry = useRef<(() => void) | null>(null);
  const [failure, setFailure] = useState<{ key: string; error: unknown } | null>(null);

  useEffect(() => {
    if (!enabled || !event || !settings?.generation || completed.current.has(key)) return;
    const element = pane.current;
    if (!element) return;
    const controller = new AbortController();
    const input: ReadingSignal = { eventId: event.id, contentVersion: event.contentVersion,
      generation: settings.generation, activeMs: readingThresholdMs, surface };
    const clock = createReadingClock(performance.now());
    let attempted = false, pending = false, activationPending = true;
    const eligible = () => {
      if (document.visibilityState !== "visible" || !document.hasFocus() ||
          document.documentElement.dataset.sessionValidation === "pending" ||
          element.closest('[inert], [aria-hidden="true"]') || getComputedStyle(element).visibility === "hidden") return false;
      if (document.activeElement !== document.body && !element.contains(document.activeElement)) return false;
      const box = element.getBoundingClientRect();
      const height = Math.min(box.bottom, innerHeight) - Math.max(box.top, 0);
      const width = Math.min(box.right, innerWidth) - Math.max(box.left, 0);
      return box.width > 0 && box.height > 0 &&
        height >= Math.min(box.height, innerHeight) / 2 && width >= Math.min(box.width, innerWidth) / 2;
    };
    const send = async () => {
      if (pending || controller.signal.aborted) return;
      pending = true;
      setFailure(null);
      try {
        const result = await api.readingSignal(input, controller.signal);
        if (!isReadingPersonalization(result.settings) || result.settings.generation !== input.generation || typeof result.recorded !== "boolean") {
          throw new Error("阅读学习响应不完整，请重新连接。");
        }
        if (controller.signal.aborted) return;
        completed.current.add(key);
        if (completed.current.size > 200) completed.current.delete(completed.current.values().next().value!);
        acceptReadingPersonalization(client, result.settings, input.generation);
      } catch (error) {
        if (controller.signal.aborted) return;
        setFailure({ key, error });
        retry.current = error instanceof ApiError && [403, 409].includes(error.status) ? () => {
          void client.invalidateQueries({ queryKey: ["session"], exact: true });
          void client.invalidateQueries({ queryKey: ["event", input.eventId], exact: true });
        } : () => { void send(); };
      } finally {
        pending = false;
      }
    };
    const sample = (activity = false) => {
      const visible = eligible();
      const elapsed = clock.sample(performance.now(), visible, visible && (activity || activationPending));
      if (visible) activationPending = false;
      if (elapsed >= readingThresholdMs && visible && !attempted) {
        attempted = true;
        input.activeMs = Math.min(120_000, Math.floor(elapsed));
        void send();
      }
    };
    const activity = (event: globalThis.Event) => { if (event.isTrusted) sample(true); };
    const visibility = () => {
      if (document.visibilityState === "visible") activationPending = true;
      sample();
    };
    const focus = (event: FocusEvent) => {
      if (event.target !== window) return;
      if (event.type === "focus") activationPending = true;
      sample();
    };
    sample(true);
    const timer = window.setInterval(() => sample(), 1_000);
    for (const name of ["pointerdown", "keydown", "scroll", "wheel"]) element.addEventListener(name, activity, { passive: true });
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("focus", focus);
    window.addEventListener("blur", focus);
    window.addEventListener("pagehide", visibility);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      for (const name of ["pointerdown", "keydown", "scroll", "wheel"]) element.removeEventListener(name, activity);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("focus", focus);
      window.removeEventListener("blur", focus);
      window.removeEventListener("pagehide", visibility);
      retry.current = null;
    };
  }, [enabled, key, client, pane]);

  return { error: enabled && failure?.key === key ? failure.error : null, retry: () => retry.current?.() };
}
