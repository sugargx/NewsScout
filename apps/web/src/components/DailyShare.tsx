import { ArrowDownloadRegular, CopyRegular, ShareRegular } from "@fluentui/react-icons";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { canvasPng, downloadBlob, earlierLabel, orderForShare, renderShareImage, shareEntry, shareFileName, shareHeading, shareText, shareWeekday, SHARE_DEFAULT_COUNT, SHARE_MAX_COUNT, SHARE_ORDER_KEY, type ShareOrder } from "../daily-share";
import type { BriefSection, Event } from "../types";
import { ErrorNotice } from "./Feedback";
import { ReaderButton } from "./ReaderControls";
import "../daily-share.css";

type ShareCandidate = Pick<Event, "id" | "title" | "summary" | "evidence"> & Partial<Pick<Event, "displayTitle" | "summaryPoints" | "topics" | "publishedAt">>;
interface Rendered { key: string; blob: Blob; url: string; count: number; height: number }

function storedOrder(): ShareOrder {
  try { return localStorage.getItem(SHARE_ORDER_KEY) === "scout" ? "scout" : "ai"; } catch { return "ai"; }
}

// System sharing is offered on touch devices only; desktop keeps download as the single primary action.
function canShareFiles() {
  try {
    if (typeof navigator.share !== "function" || typeof navigator.canShare !== "function" || !matchMedia("(pointer: coarse)").matches) return false;
    return navigator.canShare({ files: [new File([new Uint8Array(8)], "probe.png", { type: "image/png" })] });
  } catch {
    return false;
  }
}

function orderNote(order: ShareOrder, total: number, ai: number) {
  if (!total) return "";
  if (ai === total) return `今天 ${total} 条都与 AI 相关，两种排序结果相同。`;
  if (!ai) return "今天没有识别到 AI 相关新闻，两种排序结果相同。";
  return order === "ai" ? `${ai} 条 AI 相关新闻排在前面，其余保持精选顺序。` : "与今日精选页面的排列顺序一致。";
}

// The image already exists when sharing starts, so only the share sheet failed; browsers describe that in English.
function shareFailure(error: unknown) {
  const refused = error instanceof DOMException && error.name === "NotAllowedError";
  return new Error(`${refused ? "系统没有允许这次分享。" : "系统分享暂时不可用。"}可以改用“下载分享图”，保存后再发送。`);
}

export function DailyShare({ date, day = "今日", items, sections = [], onAction, focusOnMount = false }: { date: string; day?: string; items: ShareCandidate[]; sections?: BriefSection[]; onAction?: (outcome: "success" | "failure", durationMs: number) => void; focusOnMount?: boolean }) {
  const baseId = useId(), headingId = `${baseId}-heading`, limitId = `${baseId}-limit`;
  const [order, setOrder] = useState<ShareOrder>(storedOrder);
  const [picked, setPicked] = useState<ReadonlySet<string> | null>(null);
  const [rendered, setRendered] = useState<Rendered | null>(null), [rendering, setRendering] = useState(true);
  const [renderError, setRenderError] = useState<unknown>(null), [actionError, setActionError] = useState<{ title: string; error: unknown } | null>(null);
  const [status, setStatus] = useState(""), [busy, setBusy] = useState(false), [manualText, setManualText] = useState(0);
  const [moreBelow, setMoreBelow] = useState(false), [shareFiles] = useState(canShareFiles);
  const frame = useRef<HTMLDivElement>(null), latest = useRef<Rendered | null>(null);
  const heading = useRef<HTMLHeadingElement>(null), manual = useRef<HTMLTextAreaElement>(null);
  const earlierIds = useMemo(() => new Set(sections.filter(section => section.kind === "catch_up").flatMap(section => section.eventIds)), [sections]);
  const ordered = useMemo(() => orderForShare(items, order, earlierIds), [items, order, earlierIds]);
  const current = useMemo(() => ordered.filter(item => !earlierIds.has(item.id)), [ordered, earlierIds]);
  const later = useMemo(() => ordered.filter(item => earlierIds.has(item.id)), [ordered, earlierIds]);
  const entryById = useMemo(() => new Map(items.map(item => [item.id, shareEntry(item, earlierIds.has(item.id))])), [items, earlierIds]);
  // 补读 items are older than the edition's 24-hour window, so they are never picked by default.
  const selected = useMemo(() => picked ?? new Set(current.slice(0, SHARE_DEFAULT_COUNT).map(item => item.id)), [picked, current]);
  const entries = useMemo(() => ordered.filter(item => selected.has(item.id)).flatMap(item => entryById.get(item.id) ?? []), [ordered, selected, entryById]);
  const currentAi = useMemo(() => current.filter(item => entryById.get(item.id)?.ai).length, [current, entryById]);
  const aiMixed = useMemo(() => {
    const ai = [...entryById.values()].filter(entry => entry.ai).length;
    return ai > 0 && ai < entryById.size;
  }, [entryById]);
  const weekday = shareWeekday(date), full = entries.length >= SHARE_MAX_COUNT;
  const renderKey = `${date}|${day}|${entries.map(entry => entry.id).join(",")}`;
  const ready = rendered?.key === renderKey && !rendering ? rendered : null;

  // Switching editions or restoring the defaults removes the control that had focus; keep keyboard users in the picker.
  useEffect(() => { if (focusOnMount) heading.current?.focus(); }, [focusOnMount]);
  // Each failed copy puts the reader in the manual-copy box with its text selected.
  useEffect(() => {
    if (!manualText) return;
    manual.current?.focus();
    manual.current?.select();
  }, [manualText]);

  const updateScroll = useCallback(() => {
    const element = frame.current;
    setMoreBelow(!!element && element.scrollHeight - element.scrollTop - element.clientHeight > 12);
  }, []);
  useEffect(() => {
    const element = frame.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateScroll);
    observer.observe(element);
    return () => observer.disconnect();
  }, [updateScroll]);
  useEffect(() => () => { if (latest.current) URL.revokeObjectURL(latest.current.url); }, []);
  useEffect(() => {
    let cancelled = false;
    if (!entries.length) {
      if (latest.current) URL.revokeObjectURL(latest.current.url);
      latest.current = null;
      setRendered(null); setRenderError(null); setRendering(false); setMoreBelow(false);
      return;
    }
    setRendering(true);
    const timer = setTimeout(() => void (async () => {
      try {
        await document.fonts.ready;
        const canvas = renderShareImage({ date, weekday, entries, day }), height = canvas.height;
        const blob = await canvasPng(canvas);
        if (cancelled) return;
        if (latest.current) URL.revokeObjectURL(latest.current.url);
        latest.current = { key: renderKey, blob, url: URL.createObjectURL(blob), count: entries.length, height };
        setRendered(latest.current); setRenderError(null);
      } catch (error) {
        if (cancelled) return;
        if (latest.current) URL.revokeObjectURL(latest.current.url);
        latest.current = null;
        setRendered(null); setRenderError(error); setMoreBelow(false);
      } finally {
        if (!cancelled) setRendering(false);
      }
    })(), 120);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [date, day, weekday, entries, renderKey]);

  function changeOrder(next: ShareOrder) {
    setOrder(next); setStatus("");
    try { localStorage.setItem(SHARE_ORDER_KEY, next); } catch { /* The choice still applies to this visit. */ }
  }
  function toggle(id: string) {
    const next = new Set(entries.map(entry => entry.id));
    if (next.has(id)) next.delete(id); else if (next.size < SHARE_MAX_COUNT) next.add(id);
    setPicked(next); setStatus("");
  }
  async function imageBlob() {
    if (latest.current?.key === renderKey) return latest.current.blob;
    await document.fonts.ready;
    return canvasPng(renderShareImage({ date, weekday, entries, day }));
  }
  async function download() {
    const started = performance.now();
    setBusy(true); setActionError(null); setStatus("");
    try {
      downloadBlob(await imageBlob(), shareFileName(date));
      setStatus(`已下载分享图：${entries.length} 条新闻，每条附原文链接。`);
      onAction?.("success", performance.now() - started);
    } catch (error) {
      setActionError({ title: "分享图未生成", error }); onAction?.("failure", performance.now() - started);
    } finally {
      setBusy(false);
    }
  }
  // navigator.share must run within the tap's user activation, so it only uses the finished preview.
  async function share() {
    if (!ready) return;
    const started = performance.now();
    setActionError(null); setStatus("");
    try {
      await navigator.share({ files: [new File([ready.blob], shareFileName(date), { type: "image/png" })], title: `NewsScout · ${shareHeading(ready.count, day)}` });
      setStatus("已打开系统分享。");
      onAction?.("success", performance.now() - started);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setActionError({ title: "没有打开系统分享", error: shareFailure(error) }); onAction?.("failure", performance.now() - started);
    }
  }
  async function copy() {
    setActionError(null);
    try {
      await navigator.clipboard.writeText(shareText(date, entries, day));
      setManualText(0); setStatus("文字版已复制，可直接粘贴到聊天或社交平台。");
    } catch {
      setManualText(count => count + 1); setStatus("浏览器未允许自动复制，请在下方文本框中手动复制。");
    }
  }

  const option = (item: ShareCandidate) => {
    const entry = entryById.get(item.id)!, checked = selected.has(item.id), locked = !checked && full;
    const position = entries.findIndex(value => value.id === item.id), id = `${baseId}-${item.id}`;
    const meta = [earlierLabel(entry), entry.source || "来源未知", aiMixed && entry.ai ? "AI 相关" : ""].filter(Boolean).join(" · ");
    return <li key={item.id} className={checked ? "is-selected" : undefined}>
      <label>
        <input type="checkbox" checked={checked} disabled={locked} onChange={() => toggle(item.id)}
          aria-labelledby={`${id}-title`} aria-describedby={locked ? `${id}-meta ${limitId}` : `${id}-meta`} />
        <span className="ns-share-position" aria-hidden="true">{checked ? String(position + 1).padStart(2, "0") : "—"}</span>
        <span className="ns-share-option-text">
          <strong id={`${id}-title`}>{entry.title}</strong>
          <small id={`${id}-meta`}>{meta}</small>
          <span className="ns-share-option-summary">{entry.summary}</span>
        </span>
      </label>
    </li>;
  };

  return <div className="ns-share-daily">
    <div className="ns-share-toolbar">
      <div className="ns-share-order">
        <span className="ns-share-order-label" aria-hidden="true">排序</span>
        <div className="ns-segmented" role="group" aria-label="分享排序">
          <button type="button" aria-pressed={order === "ai"} onClick={() => changeOrder("ai")}>AI 相关优先</button>
          <button type="button" aria-pressed={order === "scout"} onClick={() => changeOrder("scout")}>精选顺序</button>
        </div>
        <span className="ns-share-order-note">{orderNote(order, current.length, currentAi)}{order === "ai" && later.length ? "补读内容始终排在最后。" : ""}</span>
      </div>
      <div className="ns-share-actions">
        <ReaderButton icon={<CopyRegular />} disabled={!entries.length} onClick={() => void copy()}>复制文字版</ReaderButton>
        <ReaderButton variant={shareFiles ? "secondary" : "primary"} icon={<ArrowDownloadRegular />} disabled={!entries.length} disabledFocusable={busy} aria-busy={busy} onClick={() => void download()}>{busy ? "正在生成…" : "下载分享图"}</ReaderButton>
        {shareFiles && <ReaderButton variant="primary" icon={<ShareRegular />} disabled={!ready} onClick={() => void share()}>分享图片</ReaderButton>}
      </div>
    </div>
    <p className="ns-share-status" role="status">{status}</p>
    {actionError && <ErrorNotice title={actionError.title} error={actionError.error} />}
    {manualText > 0 && <textarea ref={manual} className="ns-share-manual" readOnly rows={8} aria-label="分享文字版" value={shareText(date, entries, day)} onFocus={event => event.currentTarget.select()} />}
    <div className="ns-share-layout">
      <section className="ns-share-picker" aria-labelledby={headingId}>
        <div className="ns-share-picker-head">
          <h2 ref={heading} id={headingId} className="ns-share-col-title" tabIndex={-1}>选择新闻</h2>
          <span>已选 {entries.length} / 最多 {SHARE_MAX_COUNT} 条</span>
          {picked && <button type="button" className="ns-share-reset" onClick={() => { setPicked(null); setStatus(""); heading.current?.focus(); }}>恢复默认</button>}
        </div>
        <p id={limitId} className="ns-share-limit" role="status">{full ? `已达 ${SHARE_MAX_COUNT} 条上限，取消一条后可再选。` : ""}</p>
        <ol className="ns-share-options">{current.map(option)}</ol>
        {later.length > 0 && <div className="ns-share-earlier">
          <h3 className="ns-share-group-title">值得补读 · 较早发布</h3>
          <p className="ns-share-group-note">默认不选入。勾选后，图片和文字版都会标注“补读”和发布日期。</p>
          <ol className="ns-share-options">{later.map(option)}</ol>
        </div>}
      </section>
      <section className="ns-share-preview" aria-label="分享图预览">
        <div className="ns-share-preview-head">
          <h2 className="ns-share-col-title">预览</h2>
          <span>{rendering ? "正在排版…" : rendered ? `长图 · ${rendered.count} 条 · 1080 × ${rendered.height}` : "尚未选择新闻"}</span>
          {ready && <a className="ns-share-open" href={ready.url} target="_blank" rel="noopener">查看原尺寸</a>}
        </div>
        <div className="ns-share-frame-wrap" data-more={moreBelow && rendered ? "" : undefined}>
          <div ref={frame} className="ns-share-frame" aria-busy={rendering} onScroll={updateScroll}
            {...(rendered ? { tabIndex: 0, role: "group", "aria-label": "分享图预览区域，可滚动" } : {})}>
            {renderError !== null ? <div className="ns-share-frame-problem"><ErrorNotice title="预览需要调整" error={renderError} /></div>
              : !entries.length ? <div className="ns-share-placeholder">勾选至少 1 条新闻即可预览</div>
              : rendered ? <img src={rendered.url} alt={`分享图预览：${shareHeading(rendered.count, day)}`} onLoad={updateScroll} />
              : <div className="ns-share-placeholder">正在生成预览…</div>}
          </div>
          {moreBelow && rendered && <p className="ns-share-scroll-hint" aria-hidden="true">在预览中滚动查看全部 {rendered.count} 条</p>}
        </div>
        <p className="ns-share-footnote">图片在当前浏览器生成，不会上传或公开发布。摘要来自今日精选，转发前请核对原文。图中链接无法点击；需要可点链接时，请一并发送文字版。{shareFiles ? "也可长按预览图保存。" : ""}</p>
      </section>
    </div>
  </div>;
}
