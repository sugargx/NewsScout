import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";

export function useReadingWorkspace() {
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("reader") ?? "";
  const editionNote = params.get("readerNote") === "archive" ? "历史版收录时的标题与摘要保留在左侧；这里显示该文章的当前版本。" : undefined;
  const returnFocus = useRef<HTMLElement | null>(null);
  const returnScroll = useRef<number | null>(null);
  const returnScrollContainer = useRef<HTMLElement | null>(null);
  const returnContainerTop = useRef<number | null>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (selectedId) {
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    const focusTarget = returnFocus.current;
    const scrollTop = returnScroll.current;
    requestAnimationFrame(() => {
      if (scrollTop !== null) window.scrollTo({ top: scrollTop, behavior: "auto" });
      if (returnScrollContainer.current && returnContainerTop.current !== null) {
        returnScrollContainer.current.scrollTop = returnContainerTop.current;
      }
      focusTarget?.focus({ preventScroll: true });
    });
  }, [selectedId]);

  function setReader(id: string | null, replace = false, note?: "archive" | null) {
    setParams(previous => {
      const next = new URLSearchParams(previous);
      if (id) next.set("reader", id);
      else next.delete("reader");
      if (note === "archive") next.set("readerNote", note);
      else if (note === null || !id) next.delete("readerNote");
      return next;
    }, { replace });
  }

  function open(id: string, opener?: HTMLElement | null, note: "archive" | null = null) {
    if (!selectedId) {
      returnFocus.current = opener ?? document.activeElement as HTMLElement | null;
      returnScroll.current = window.scrollY;
      let parent = opener?.parentElement ?? null;
      while (parent) {
        const style = window.getComputedStyle(parent);
        if (/(auto|scroll)/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight) break;
        parent = parent.parentElement;
      }
      returnScrollContainer.current = parent;
      returnContainerTop.current = parent?.scrollTop ?? null;
    }
    setReader(id, false, note);
  }

  return { selectedId, editionNote, open, close: () => setReader(null, true, null), select: (id: string, note?: "archive" | null) => setReader(id, false, note) };
}
