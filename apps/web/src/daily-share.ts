import { readingTitle } from "./editorial";
import type { Event } from "./types";

export type ShareOrder = "ai" | "scout";
export const SHARE_DEFAULT_COUNT = 10;
export const SHARE_MAX_COUNT = 15;
export const SHARE_ORDER_KEY = "newsscout.share.order";
export const SHARE_DISCLAIMER = "摘要由 AI 根据原文生成，仅供参考，请以原文为准。";

// `earlier` marks a 补读 item (published before the edition's 24-hour window) with its publication day.
export interface ShareEntry { id: string; title: string; summary: string; url: string; source: string; ai: boolean; earlier?: string }
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
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    for (const key of [...url.searchParams.keys()]) if (TRACKING.test(key)) url.searchParams.delete(key);
    return url.href;
  } catch {
    return "";
  }
}

// Image-only label: readable Unicode paths instead of %E6%B7… runs; text exports keep the exact URL.
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
  return {
    id: event.id, title: readingTitle(event), summary: shareSummary(event), ai: aiRelated(event),
    url: primary ? cleanUrl(primary.url) : "", source: primary ? shareSource(primary.sourceName) : "",
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

export function shareText(date: string, entries: ShareEntry[], day = "今日"): string {
  const earlier = entries.filter(entry => entry.earlier).length;
  return [`NewsScout · ${shareHeading(entries.length, day)}（${date}${earlier ? `，含 ${earlier} 条补读` : ""}）`, "",
    ...entries.flatMap((entry, index) => [`${index + 1}. ${entry.earlier ? `【${earlierLabel(entry)}】` : ""}${entry.title}`, entry.summary, ...(entry.url ? [`原文：${entry.url}`] : []), ""]),
    SHARE_DISCLAIMER].join("\n");
}

export function shareSubtitle(entries: ShareEntry[], day = "今日"): string {
  const earlier = entries.filter(entry => entry.earlier).length;
  return `选自 NewsScout ${day === "今日" ? "" : `${day}版`}今日精选${earlier ? ` · 含 ${earlier} 条补读` : ""} · 每条附原文链接`;
}

export function entryText(entry: ShareEntry): string {
  return [entry.title, entry.summary, ...(entry.url ? [`原文：${entry.url}`] : [])].join("\n");
}

export function shareFileName(date: string) {
  return `NewsScout-今日分享-${date}.png`;
}

const FONT = '"PingFang SC", "Noto Sans SC", "Microsoft YaHei", "Source Han Sans SC", "Segoe UI", system-ui, sans-serif';
const COLORS = { bg: "#fcfcf9", text: "#17211e", soft: "#4f5b56", muted: "#66716c", accent: "#275d52", accentSoft: "#e4eeea", border: "#dce1da" };
const WIDTH = 1080, PAD = 72, NUMBER = 84, X = PAD + NUMBER, CONTENT = WIDTH - X - PAD;
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

function layout(context: CanvasRenderingContext2D, entries: ShareEntry[]): Block[] {
  return entries.map(entry => {
    const label = earlierLabel(entry);
    context.font = `700 ${TITLE.size}px ${FONT}`;
    const title = wrap(context, entry.title, CONTENT, TITLE.max);
    context.font = `400 ${SUMMARY.size}px ${FONT}`;
    const summary = entry.summary ? wrap(context, entry.summary, CONTENT, SUMMARY.max) : [];
    context.font = `400 ${LINK.size}px ${FONT}`;
    // Never print a truncated link: an over-long URL falls back to its domain, written for the recipient.
    let url = entry.url ? wrapUrl(context, displayUrl(entry.url), CONTENT) : [];
    if (url.length > LINK.max) url = [`${host(entry.url) || "原文"} · 链接较长，请按标题搜索原文`];
    const source = entry.source ? `原文 · ${entry.source}` : "原文";
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

export function renderShareImage(input: { date: string; weekday: string; entries: ShareEntry[]; day?: string }): HTMLCanvasElement {
  if (!input.entries.length) throw new Error("至少选择一条新闻，才能生成分享图。");
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH; canvas.height = 10;
  const measure = canvas.getContext("2d");
  if (!measure) throw new Error("当前浏览器无法生成图片。");
  const blocks = layout(measure, input.entries);
  const header = 330, gap = 88, footer = 150;
  const height = header + blocks.reduce((total, block) => total + block.height, 0) + gap * (blocks.length - 1) + footer;
  if (height > MAX_HEIGHT) throw new Error("内容太长，无法生成一张图片。请减少条目后重试。");
  canvas.height = Math.ceil(height);
  const context = canvas.getContext("2d")!;
  context.textBaseline = "top";
  context.fillStyle = COLORS.bg; context.fillRect(0, 0, WIDTH, canvas.height);
  context.fillStyle = COLORS.accent; context.fillRect(0, 0, WIDTH, 10);
  context.font = `700 32px ${FONT}`; context.fillText("NewsScout", PAD, 62);
  context.fillStyle = COLORS.muted; context.font = `400 26px ${FONT}`; context.textAlign = "right";
  context.fillText(`${input.date} · ${input.weekday}`, WIDTH - PAD, 66); context.textAlign = "left";
  context.fillStyle = COLORS.text; context.font = `700 56px ${FONT}`;
  context.fillText(shareHeading(blocks.length, input.day), PAD, 136);
  context.fillStyle = COLORS.muted; context.font = `400 28px ${FONT}`;
  context.fillText(shareSubtitle(input.entries, input.day), PAD, 220);
  context.fillStyle = COLORS.border; context.fillRect(PAD, 290, WIDTH - PAD * 2, 2);
  let y = header;
  blocks.forEach((block, index) => {
    badge(context, PAD, y + 4, String(index + 1).padStart(2, "0"));
    let cursor = y;
    if (block.label) {
      context.fillStyle = COLORS.accent; context.font = `700 ${LINK.size}px ${FONT}`;
      context.fillText(block.label, X, cursor + 4); cursor += LABEL_LINE;
    }
    context.fillStyle = COLORS.text; context.font = `700 ${TITLE.size}px ${FONT}`;
    block.title.forEach(line => { context.fillText(line, X, cursor); cursor += TITLE.line; });
    if (block.summary.length) {
      cursor += 16; context.fillStyle = COLORS.soft; context.font = `400 ${SUMMARY.size}px ${FONT}`;
      block.summary.forEach(line => { context.fillText(line, X, cursor); cursor += SUMMARY.line; });
    }
    cursor += 20; context.fillStyle = COLORS.muted; context.font = `700 ${LINK.size}px ${FONT}`;
    context.fillText(block.source, X, cursor); cursor += LINK.line;
    context.fillStyle = COLORS.accent; context.font = `400 ${LINK.size}px ${FONT}`;
    block.url.forEach(line => { context.fillText(line, X, cursor); cursor += LINK.line; });
    y += block.height;
    if (index < blocks.length - 1) {
      context.fillStyle = COLORS.border; context.fillRect(X, y + gap / 2 - 1, CONTENT, 1);
      y += gap;
    }
  });
  const bottom = canvas.height - footer;
  context.fillStyle = COLORS.border; context.fillRect(PAD, bottom + 44, WIDTH - PAD * 2, 2);
  context.fillStyle = COLORS.muted; context.font = `400 24px ${FONT}`;
  context.fillText(SHARE_DISCLAIMER, PAD, bottom + 78);
  context.fillStyle = COLORS.accent; context.font = `700 24px ${FONT}`; context.textAlign = "right";
  context.fillText("NewsScout · 今日精选", WIDTH - PAD, bottom + 78); context.textAlign = "left";
  return canvas;
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
