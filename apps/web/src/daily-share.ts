import { readingTitle } from "./editorial";
import type { Event } from "./types";

export type ShareOrder = "ai" | "scout";
export const SHARE_DEFAULT_COUNT = 10;
export const SHARE_MAX_COUNT = 15;
export const SHARE_ORDER_KEY = "newsscout.share.order";
export const SHARE_DISCLAIMER = "摘要由 AI 根据原文生成，仅供参考，请以原文为准。";

// `earlier` marks a 补读 item (published before the edition's 24-hour window) with its publication day.
export interface ShareEntry { id: string; title: string; summary: string; url: string; source: string; ai: boolean; earlier?: string }
export interface SharePortal { url: string; modules: { size: number; data: Uint8Array } }
export interface ShareRenderInput { date: string; weekday: string; entries: ShareEntry[]; day?: string; portal?: SharePortal | null }
interface ShareLink { x: number; y: number; width: number; height: number; url: string }
type Shareable = Pick<Event, "id" | "title" | "summary" | "evidence"> & Partial<Pick<Event, "displayTitle" | "summaryPoints" | "topics" | "publishedAt">>;

const AI_FACETS = new Set(["模型与多模态", "Agent 与工具", "评测与安全", "AI 编程", "记忆与检索", "AGI", "MCP / A2A"]);
const AI_WORDS = /(?:^|[^a-z])(?:ai|agi|llms?|agents?|agentic|mcp|rag|transformers?|diffusion|multimodal|embeddings?|inference|fine-?tun(?:e|ed|ing)|(?:chat)?gpt|claude|gemini|llama|qwen|deepseek|mistral|grok|copilot|openai|anthropic|hugging ?face)(?=[^a-z]|$)/i;
const AI_CJK = /人工智能|大模型|模型|智能体|机器学习|深度学习|神经网络|多模态|算力|具身智能|生成式|提示词|微调/;
const TRACKING = /^(?:utm_[a-z_]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|ref_src)$/i;
const FEED_SUFFIX = /\s*·\s*(?:[\u4e00-\u9fff]{1,6}\s*)?(?:RSS|Atom|Feed)$/i;

export function aiRelated(event: Shareable): boolean {
  if (event.topics?.some(topic => AI_FACETS.has(topic))) return true;
  const text = `${event.title} ${event.displayTitle ?? ""}`;
  return AI_WORDS.test(text) || AI_CJK.test(text);
}

// AI-first is a stable partition of the 24-hour items; 补读 items always follow in edition order.
export function orderForShare<T extends Shareable>(events: T[], order: ShareOrder, earlier: ReadonlySet<string> = new Set()): T[] {
  const current = events.filter(event => !earlier.has(event.id)), later = events.filter(event => earlier.has(event.id));
  if (order === "scout") return [...current, ...later];
  return [...current.filter(aiRelated), ...current.filter(event => !aiRelated(event)), ...later];
}

const DAY = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric" });
export function publishedDay(value?: string | null): string {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "较早发布";
  const parts = DAY.formatToParts(date), part = (type: string) => parts.find(item => item.type === type)?.value ?? "";
  return `${part("month")}月${part("day")}日发布`;
}
export function earlierLabel(entry: Pick<ShareEntry, "earlier">): string {
  return entry.earlier ? `补读 · ${entry.earlier}` : "";
}

export function cleanUrl(value: string): string {
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return "";
    for (const key of [...url.searchParams.keys()]) if (TRACKING.test(key)) url.searchParams.delete(key);
    return url.href;
  } catch {
    return "";
  }
}

// Only a public HTTPS origin is useful to recipients; never export local hosts, credentials or the reader's route/query.
export function publicPortalUrl(value: string): string {
  try {
    const url = new URL(value), hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    if (url.protocol !== "https:" || url.username || url.password || url.port
      || !hostname.includes(".") || hostname.length > 253 || hostname.includes(":") || /^[\d.]+$/.test(hostname)
      || !hostname.split(".").every(label => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(label))
      || /(?:^|\.)(?:localhost|local|localdomain|internal|lan|home|home\.arpa|invalid)$/.test(hostname)) return "";
    return `${url.origin}/`;
  } catch {
    return "";
  }
}

export async function sharePortal(value: string): Promise<SharePortal | null> {
  const url = publicPortalUrl(value);
  if (!url) return null;
  const { create } = await import("qrcode");
  const { modules } = create(url, { errorCorrectionLevel: "H" });
  return { url, modules };
}

// Readable labels may decode paths; hyperlink targets and text exports retain the actual URL.
export function displayUrl(value: string): string {
  const text = value.replace(/^https?:\/\//, "").replace(/\/$/, "");
  try {
    return decodeURI(text);
  } catch {
    return text;
  }
}

const length = (text: string) => Array.from(text).length;
function clip(text: string, limit: number) {
  const characters = Array.from(text);
  if (characters.length <= limit) return text;
  const head = characters.slice(0, limit).join("");
  const boundary = Math.max(...["。", "！", "？", "；"].map(mark => head.lastIndexOf(mark)));
  return boundary >= limit * .5 ? head.slice(0, boundary + 1) : `${characters.slice(0, limit - 1).join("")}…`;
}
function sentence(point: string) {
  const text = point.replace(/^\s*(?:[-*•·]\s*|\d+(?:[、)）]|\.\s)\s*)/, "").replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim();
  return !text || /[。！？!?…」”）)]$/.test(text) ? text : `${text}。`;
}

// A few sentences from the edition's own summary points; no new model call.
export function shareSummary(event: Pick<Event, "summary"> & Partial<Pick<Event, "summaryPoints">>, limit = 140): string {
  const points = (event.summaryPoints?.length ? event.summaryPoints : event.summary.match(/[^。！？!?]+[。！？!?]*/g) ?? []).map(sentence).filter(Boolean);
  let text = "";
  for (const point of points) {
    if (text && length(text + point) > limit) break;
    text += point;
    if (length(text) >= limit) break;
  }
  return clip(text, limit + 30);
}

export function shareEntry(event: Shareable, catchUp = false): ShareEntry {
  const evidence = event.evidence.filter(item => cleanUrl(item.url));
  const primary = evidence.find(item => item.isOfficial) ?? evidence[0];
  const attribution = primary ?? event.evidence.find(item => item.isOfficial && item.sourceName.trim()) ?? event.evidence.find(item => item.sourceName.trim());
  return {
    id: event.id, title: readingTitle(event), summary: shareSummary(event), ai: aiRelated(event),
    url: primary ? cleanUrl(primary.url) : "", source: attribution ? shareSource(attribution.sourceName) : "",
    ...(catchUp ? { earlier: publishedDay(event.publishedAt ?? primary?.publishedAt) } : {}),
  };
}

// Registry names carry a feed descriptor ("· 节目 RSS", "· 官方研究索引", "· AI & ML"); recipients only need the publisher.
// A subreddit is the actual source, so "Reddit · r/LocalLLaMA" keeps it.
export function shareSource(name: string): string {
  const [head = "", ...rest] = name.replace(FEED_SUFFIX, "").split(/\s+·\s+/);
  const tail = rest.join(" · ").trim();
  return (/^r\/\w/.test(tail) ? `${head} ${tail}` : head).trim() || name.trim();
}

// `day` is "今日" only for the current edition; a held or earlier edition is named by its date.
export function shareHeading(count: number, day = "今日") {
  return `${day}值得分享的 ${count} 条新闻`;
}

function originalText(entry: ShareEntry) {
  const url = cleanUrl(entry.url);
  return url ? `原文：${url}` : `${entry.source ? `来源：${entry.source} · ` : ""}未提供原文链接`;
}

export function shareText(date: string, entries: ShareEntry[], day = "今日", portal = ""): string {
  const earlier = entries.filter(entry => entry.earlier).length;
  const portalUrl = publicPortalUrl(portal);
  return [`NewsScout · ${shareHeading(entries.length, day)}（${date}${earlier ? `，含 ${earlier} 条补读` : ""}）`, "",
    ...entries.flatMap((entry, index) => [`${index + 1}. ${entry.earlier ? `【${earlierLabel(entry)}】` : ""}${entry.title}`, entry.summary, originalText(entry), ""]),
    ...(portalUrl ? [`更多新闻 · NewsScout：${portalUrl}`, ""] : []),
    SHARE_DISCLAIMER].join("\n");
}

export function shareSubtitle(entries: ShareEntry[], day = "今日", format: "png" | "pdf" = "png"): string {
  const earlier = entries.filter(entry => entry.earlier).length;
  return `选自 NewsScout ${day === "今日" ? "" : `${day}版`}今日精选${earlier ? ` · 含 ${earlier} 条补读` : ""} · ${format === "pdf" ? "点击标题或原文打开链接" : "附原文地址（图片内不可点击）"}`;
}

export function entryText(entry: ShareEntry): string {
  return [entry.title, entry.summary, originalText(entry)].join("\n");
}

export function shareFileName(date: string, format: "png" | "pdf" = "png") {
  return `NewsScout-今日分享-${date}.${format}`;
}

const FONT = '"PingFang SC", "Noto Sans SC", "Microsoft YaHei", "Source Han Sans SC", "Segoe UI", system-ui, sans-serif';
const COLORS = { bg: "#fcfcf9", text: "#17211e", soft: "#4f5b56", muted: "#66716c", accent: "#275d52", accentSoft: "#e4eeea", border: "#dce1da" };
const WIDTH = 1080, PAD = 72, NUMBER = 84, X = PAD + NUMBER, CONTENT = WIDTH - X - PAD;
const HEADER = 330, GAP = 88, PDF_HEIGHT = Math.ceil(WIDTH * 297 / 210);
// iOS Safari draws nothing on a canvas above 16,777,216 px (1080 × 15,534); a longer image gets the "too long" message instead.
const MAX_HEIGHT = 15_500;
const TOKEN = /[\u2e80-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]|[^\s\u2e80-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]+|\s+/g;
const CLOSING = /^[，。、；：！？）」』》〉”’,.;:!?)]$/;

function wrap(context: CanvasRenderingContext2D, text: string, width: number, maxLines: number): string[] {
  const lines: string[] = [];
  let current = "";
  const push = () => { lines.push(current.trimEnd()); current = ""; };
  for (const token of text.match(TOKEN) ?? []) {
    if (/^\s+$/.test(token)) { if (current && context.measureText(current + " ").width <= width) current += " "; continue; }
    if (context.measureText(current + token).width <= width || CLOSING.test(token) && current) { current += token; continue; }
    if (current) push();
    if (context.measureText(token).width <= width) { current = token; continue; }
    for (const character of Array.from(token)) {
      if (current && context.measureText(current + character).width > width) push();
      current += character;
    }
  }
  if (current) push();
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1];
  while (last && context.measureText(`${last}…`).width > width) last = Array.from(last).slice(0, -1).join("");
  kept[maxLines - 1] = `${last}…`;
  return kept;
}

interface Block { entry: ShareEntry; label: string; title: string[]; summary: string[]; source: string; url: string[]; height: number }
// Sized for phones: the 1080px image is usually viewed at ~390 CSS px, so 32px summary text reads as ~12px.
const TITLE = { size: 40, line: 56, max: 4 }, SUMMARY = { size: 32, line: 50, max: 7 }, LINK = { size: 25, line: 36, max: 3 };
const LABEL_LINE = LINK.line + 6;

function host(value: string) {
  try { return new URL(value).hostname.replace(/^www\./, ""); } catch { return ""; }
}

// Links break after "/ - _ . ? & = #" so each line stays easy to retype; a segment wider than a line breaks by character.
function wrapUrl(context: CanvasRenderingContext2D, text: string, width: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const segment of text.match(/[^\/\-_.?&=#]*[\/\-_.?&=#]?/g)?.filter(Boolean) ?? []) {
    if (context.measureText(current + segment).width <= width) { current += segment; continue; }
    if (current) lines.push(current);
    current = "";
    for (const character of Array.from(segment)) {
      if (current && context.measureText(current + character).width > width) { lines.push(current); current = ""; }
      current += character;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function layout(context: CanvasRenderingContext2D, entries: ShareEntry[], format: "png" | "pdf"): Block[] {
  return entries.map(entry => {
    const label = earlierLabel(entry);
    context.font = `700 ${TITLE.size}px ${FONT}`;
    const title = wrap(context, entry.title, CONTENT, TITLE.max);
    context.font = `400 ${SUMMARY.size}px ${FONT}`;
    const summary = entry.summary ? wrap(context, entry.summary, CONTENT, SUMMARY.max) : [];
    context.font = `400 ${LINK.size}px ${FONT}`;
    // Never print a truncated link: an over-long URL falls back to its domain, written for the recipient.
    const target = cleanUrl(entry.url);
    let url = target ? wrapUrl(context, displayUrl(target), CONTENT) : [];
    if (url.length > LINK.max) url = wrap(context, `${host(target) || "原文"} · ${format === "pdf" ? "点击打开完整原文" : "链接较长，请按标题搜索原文"}`, CONTENT, LINK.max);
    context.font = `700 ${LINK.size}px ${FONT}`;
    const source = wrap(context, target ? entry.source ? `原文 · ${entry.source}` : "原文" : `${entry.source ? `来源 · ${entry.source} · ` : ""}未提供原文链接`, CONTENT, 1)[0];
    const height = (label ? LABEL_LINE : 0) + title.length * TITLE.line + (summary.length ? 16 + summary.length * SUMMARY.line : 0) + 20 + LINK.line + url.length * LINK.line;
    return { entry, label, title, summary, source, url, height };
  });
}

function badge(context: CanvasRenderingContext2D, x: number, y: number, label: string) {
  context.fillStyle = COLORS.accentSoft;
  context.beginPath();
  if (typeof context.roundRect === "function") context.roundRect(x, y, 64, 48, 12); else context.rect(x, y, 64, 48);
  context.fill();
  context.fillStyle = COLORS.accent;
  context.font = `700 26px ${FONT}`;
  context.textAlign = "center";
  context.fillText(label, x + 32, y + 10);
  context.textAlign = "left";
}

function measureBlocks(input: ShareRenderInput, format: "png" | "pdf"): Block[] {
  if (!input.entries.length || input.entries.length > SHARE_MAX_COUNT) throw new Error(`请选择 1–${SHARE_MAX_COUNT} 条新闻后导出。`);
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH; canvas.height = 1;
  const measure = canvas.getContext("2d");
  if (!measure) throw new Error("当前浏览器无法生成图片。");
  try { return layout(measure, input.entries, format); }
  finally { canvas.width = 0; canvas.height = 0; }
}

function footerHeight(input: ShareRenderInput, format: "png" | "pdf") {
  return input.portal ? format === "png" ? 450 : 300 : 150;
}

function portalFooter(context: CanvasRenderingContext2D, portal: SharePortal, top: number, format: "png" | "pdf"): ShareLink {
  let width = WIDTH - PAD * 2;
  if (format === "png") {
    const quiet = 4, size = portal.modules.size, cell = Math.floor(328 / (size + quiet * 2));
    const side = (size + quiet * 2) * cell, left = WIDTH - PAD - side;
    context.fillStyle = "#ffffff"; context.fillRect(left, top, side, side);
    context.fillStyle = "#000000";
    for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) {
      if (portal.modules.data[row * size + col]) context.fillRect(left + (col + quiet) * cell, top + (row + quiet) * cell, cell, cell);
    }
    width -= 360;
  }
  context.fillStyle = COLORS.accent; context.font = `700 32px ${FONT}`;
  context.fillText("更多新闻，尽在 NewsScout", PAD, top + 8);
  context.fillStyle = COLORS.soft; context.font = `400 25px ${FONT}`;
  context.fillText(format === "png" ? "扫码访问门户 · 登录后继续阅读" : "点击访问门户 · 登录后继续阅读", PAD, top + 56);
  context.fillStyle = COLORS.accent;
  const lines = wrap(context, portal.url, width, format === "png" ? 5 : 2);
  lines.forEach((line, index) => context.fillText(line, PAD, top + 100 + index * 34));
  return { x: PAD, y: top, width, height: 100 + lines.length * 34, url: portal.url };
}

function paintPage(input: ShareRenderInput, blocks: Block[], height: number, format: "png" | "pdf", offset = 0, page = 1, pages = 1) {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH; canvas.height = Math.ceil(height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前浏览器无法生成分享文件。");
  const links: ShareLink[] = [];
  context.textBaseline = "top";
  context.fillStyle = COLORS.bg; context.fillRect(0, 0, WIDTH, canvas.height);
  context.fillStyle = COLORS.accent; context.fillRect(0, 0, WIDTH, 10);
  context.font = `700 32px ${FONT}`; context.fillText("NewsScout", PAD, 62);
  context.fillStyle = COLORS.muted; context.font = `400 26px ${FONT}`; context.textAlign = "right";
  context.fillText(`${input.date} · ${input.weekday}`, WIDTH - PAD, 66); context.textAlign = "left";
  context.fillStyle = COLORS.text; context.font = `700 56px ${FONT}`;
  context.fillText(shareHeading(input.entries.length, input.day), PAD, 136);
  context.fillStyle = COLORS.muted; context.font = `400 28px ${FONT}`;
  const subtitle = wrap(context, shareSubtitle(input.entries, input.day, format), WIDTH - PAD * 2, 2);
  subtitle.forEach((line, index) => context.fillText(line, PAD, 214 + index * 34));
  context.fillStyle = COLORS.border; context.fillRect(PAD, 290, WIDTH - PAD * 2, 2);
  let y = HEADER;
  blocks.forEach((block, index) => {
    badge(context, PAD, y + 4, String(offset + index + 1).padStart(2, "0"));
    let cursor = y;
    if (block.label) {
      context.fillStyle = COLORS.accent; context.font = `700 ${LINK.size}px ${FONT}`;
      context.fillText(block.label, X, cursor + 4); cursor += LABEL_LINE;
    }
    const url = cleanUrl(block.entry.url);
    if (url) links.push({ x: X, y: cursor, width: CONTENT, height: block.title.length * TITLE.line, url });
    context.fillStyle = COLORS.text; context.font = `700 ${TITLE.size}px ${FONT}`;
    block.title.forEach(line => { context.fillText(line, X, cursor); cursor += TITLE.line; });
    if (block.summary.length) {
      cursor += 16; context.fillStyle = COLORS.soft; context.font = `400 ${SUMMARY.size}px ${FONT}`;
      block.summary.forEach(line => { context.fillText(line, X, cursor); cursor += SUMMARY.line; });
    }
    cursor += 20; context.fillStyle = COLORS.muted; context.font = `700 ${LINK.size}px ${FONT}`;
    if (url) links.push({ x: X, y: cursor, width: CONTENT, height: (1 + block.url.length) * LINK.line, url });
    context.fillText(block.source, X, cursor); cursor += LINK.line;
    context.fillStyle = COLORS.accent; context.font = `400 ${LINK.size}px ${FONT}`;
    block.url.forEach(line => { context.fillText(line, X, cursor); cursor += LINK.line; });
    y += block.height;
    if (index < blocks.length - 1) {
      context.fillStyle = COLORS.border; context.fillRect(X, y + GAP / 2 - 1, CONTENT, 1);
      y += GAP;
    }
  });
  const bottom = canvas.height - footerHeight(input, format);
  context.fillStyle = COLORS.border; context.fillRect(PAD, bottom + 24, WIDTH - PAD * 2, 2);
  if (input.portal) links.push(portalFooter(context, input.portal, bottom + 48, format));
  context.fillStyle = COLORS.muted; context.font = `400 24px ${FONT}`;
  context.fillText(SHARE_DISCLAIMER, PAD, canvas.height - 64);
  context.fillStyle = COLORS.accent; context.font = `700 24px ${FONT}`; context.textAlign = "right";
  context.fillText(format === "pdf" ? `${page} / ${pages} 页` : "NewsScout · 今日精选", WIDTH - PAD, canvas.height - 64); context.textAlign = "left";
  return { canvas, links };
}

export function renderShareImage(input: ShareRenderInput): HTMLCanvasElement {
  const blocks = measureBlocks(input, "png");
  const height = HEADER + blocks.reduce((total, block) => total + block.height, 0) + GAP * (blocks.length - 1) + footerHeight(input, "png");
  if (height > MAX_HEIGHT) throw new Error("内容太长，无法生成一张图片。请减少条目后重试。");
  return paintPage(input, blocks, height, "png").canvas;
}

export async function renderSharePdf(input: ShareRenderInput): Promise<{ blob: Blob; pages: number }> {
  const blocks = measureBlocks(input, "pdf"), available = PDF_HEIGHT - HEADER - footerHeight(input, "pdf");
  const pages: Block[][] = [];
  let current: Block[] = [], used = 0;
  for (const block of blocks) {
    if (block.height > available) throw new Error("单条内容超出 PDF 页面，请减少文字后重试。");
    if (current.length && used + GAP + block.height > available) {
      pages.push(current); current = []; used = 0;
    }
    used += (current.length ? GAP : 0) + block.height; current.push(block);
  }
  if (current.length) pages.push(current);
  const { jsPDF } = await import("jspdf");
  const pdf = new jsPDF({ unit: "mm", format: "a4", compress: true });
  pdf.setProperties({ title: `NewsScout · ${shareHeading(input.entries.length, input.day)}（${input.date}）`, creator: "NewsScout" });
  let offset = 0;
  for (let index = 0; index < pages.length; index++) {
    if (index) pdf.addPage();
    const { canvas, links } = paintPage(input, pages[index], PDF_HEIGHT, "pdf", offset, index + 1, pages.length);
    const width = canvas.width, height = canvas.height;
    const png = await canvasPng(canvas);
    const pageWidth = pdf.internal.pageSize.getWidth(), pageHeight = pdf.internal.pageSize.getHeight();
    pdf.addImage(new Uint8Array(await png.arrayBuffer()), "PNG", 0, 0, pageWidth, pageHeight, undefined, "FAST");
    for (const link of links) {
      pdf.link(link.x / width * pageWidth, link.y / height * pageHeight, link.width / width * pageWidth, link.height / height * pageHeight, { url: link.url });
    }
    offset += pages[index].length;
  }
  return { blob: pdf.output("blob"), pages: pages.length };
}

// Encoding releases the canvas: iOS Safari keeps each 40–60 MB bitmap until garbage collection and stops drawing once its total canvas budget is spent.
export function canvasPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(blob => {
    canvas.width = 0; canvas.height = 0;
    if (blob) resolve(blob); else reject(new Error("图片编码失败，请重试。"));
  }, "image/png"));
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob), anchor = document.createElement("a");
  anchor.href = url; anchor.download = name; anchor.rel = "noopener";
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function shareWeekday(date: string) {
  const value = new Date(`${date}T12:00:00+08:00`);
  return Number.isNaN(value.getTime()) ? "" : new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", weekday: "long" }).format(value);
}
