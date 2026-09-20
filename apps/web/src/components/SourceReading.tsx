import { Button } from "@fluentui/react-components";
import { useState } from "react";
import { httpsUrl } from "../reader";
import type { ReadingContext } from "../types";
import "../reader-extras.css";

const contextTitle: Record<ReadingContext["kind"], string> = {
  article: "已收录正文",
  feed: "来源摘录",
  post: "帖子正文",
  podcast: "节目简介",
  release: "版本与变更",
};

export function formatSourceTimestamp(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor(total % 3_600 / 60);
  const remainingSeconds = total % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}` : `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

export function formatSourceDuration(seconds: number) {
  return seconds >= 3_600 ? `${formatSourceTimestamp(seconds)}（时:分:秒）` : `${formatSourceTimestamp(seconds)}（分:秒）`;
}

function ReadableText({ text, expandable }: { text: string; expandable: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const limit = expandable ? 1_400 : 1_200;
  const visible = expandable && expanded || text.length <= limit ? text : `${text.slice(0, limit).trimEnd()}…`;
  return <div className="ns-source-text">
    {visible.split(/\n{2,}/).filter(Boolean).map((paragraph, index) => <p key={index}>{paragraph}</p>)}
    {expandable && text.length > limit && <Button appearance="subtle" size="small" onClick={() => setExpanded(value => !value)}>{expanded ? "收起内容" : "显示更多"}</Button>}
  </div>;
}

export type SourceReadingEvidence = {
  title: string;
  sourceName?: string | null;
  url?: string | null;
  excerpt?: string | null;
  readingContext?: ReadingContext | null;
};

export type SourceReadingProps = {
  evidence?: SourceReadingEvidence;
  sources?: readonly SourceReadingEvidence[];
  eventType?: string | null;
};

function fallbackKind(eventType: string | null | undefined, sourceUrl: string): ReadingContext["kind"] {
  const hostname = (() => {
    try { return new URL(sourceUrl).hostname.toLocaleLowerCase(); } catch { return ""; }
  })();
  if (/(^|\.)(reddit\.com|x\.com|twitter\.com)$/.test(hostname)) return "post";
  const type = eventType?.toLocaleLowerCase() ?? "";
  if (type.includes("podcast")) return "podcast";
  if (type.includes("release")) return "release";
  if (type.includes("post") || type.includes("reddit") || type.includes("social")) return "post";
  return "feed";
}

export function sourceReadingModel(evidence: SourceReadingEvidence, eventType?: string | null) {
  const context = evidence.readingContext;
  const sourceUrl = context?.sourceUrl || evidence.url || "";
  const url = httpsUrl(sourceUrl);
  const kind = context?.kind ?? fallbackKind(eventType, sourceUrl);
  const hasUsableContext = !!context && context.status !== "unavailable" && context.status !== "blocked";
  const title = hasUsableContext || !context ? contextTitle[kind] : "来源摘录";
  const body = hasUsableContext ? context.body.trim() || evidence.excerpt?.trim() || "" : evidence.excerpt?.trim() || "";
  const isExcerpt = !context || context.truncated || context.status === "partial";
  const canExpand = (hasUsableContext && (kind === "article" || kind === "post" || kind === "podcast" || kind === "release")) || (!context && (kind === "post" || kind === "podcast"));
  const isReddit = /(^|\.)reddit\.com$/i.test(new URL(url ?? "https://invalid.invalid").hostname) || /reddit/i.test(`${evidence.sourceName ?? ""} ${evidence.title}`);
  const comments = context?.comments.filter(comment => comment.body.trim()) ?? [];
  const commentsRequireAuthorization = kind === "post" && context?.commentsStatus === "requires_authorization";
  const commentsAvailableEmpty = kind === "post" && context?.commentsStatus === "available" && comments.length === 0;
  const isXPublicPreview = kind === "post" && context?.origin === "publisher_page"
    && /(^|\.)(x\.com|twitter\.com)$/i.test(new URL(url ?? "https://invalid.invalid").hostname);
  return { context, url, kind, title, hasUsableContext, body, isExcerpt, canExpand, isReddit, comments, commentsRequireAuthorization, commentsAvailableEmpty, isXPublicPreview };
}

export function sourceReadingCapabilities(evidence:readonly SourceReadingEvidence[],summary:string) {
  let hasDistinctBody=false,hasSupplementalContent=false;
  for(const source of evidence) {
    const context=source.readingContext;
    if(!context||!["available","partial"].includes(context.status))continue;
    const body=context.body.trim(),summaryText=summary.trim();
    const addsBody=!!body&&body!==summaryText&&(!body.includes(summaryText)||body.length>summaryText.length+80);
    const hasChapters=context.chapters.length>0;
    const hasTranscript=!!httpsUrl(context.transcriptUrl??"");
    const hasComments=context.commentsStatus==="available"&&context.comments.some(comment=>!!comment.body.trim());
    hasDistinctBody ||= addsBody;
    hasSupplementalContent ||= hasChapters||hasTranscript||hasComments;
  }
  return {hasDistinctBody,hasDetailSourceContent:hasDistinctBody||hasSupplementalContent};
}

export function hasDetailSourceContent(evidence:readonly SourceReadingEvidence[],summary:string) {
  return sourceReadingCapabilities(evidence,summary).hasDetailSourceContent;
}

function SourceReadingItem({ evidence, eventType }: { evidence: SourceReadingEvidence; eventType?: string | null }) {
  const { context, url, kind, title, hasUsableContext, body, isExcerpt, canExpand, comments, commentsRequireAuthorization, commentsAvailableEmpty, isXPublicPreview } = sourceReadingModel(evidence, eventType);
  const displayTitle=`${title}${isExcerpt&&!title.endsWith("节选")?"（节选）":""}`;
  return <section className="ns-source-reading" aria-label={displayTitle}>
    <div className="ns-source-reading-heading"><h3>{displayTitle}</h3>{url && <a href={url} target="_blank" rel="noopener noreferrer">原始出处 ↗</a>}</div>
    {body ? <ReadableText text={body} expandable={canExpand} /> : <p className="ns-source-empty">当前没有可展示的{title}，可前往原始出处继续阅读。</p>}
    {!context && body && <p className="ns-source-note">{kind === "podcast" ? "以下为保留的节目简介摘录，不代表完整节目或音频内容。" : kind === "post" ? "以下为保留的帖子正文摘录，不代表完整讨论或评论。" : "以下为保留的来源摘录，非全文。"}</p>}
    {context && isExcerpt && body && <p className="ns-source-note">已收录内容为节选；可打开原始出处继续阅读。</p>}
    {isXPublicPreview && <p className="ns-source-note">这是已登记公开原帖的预览，可能被截断，不代表完整时间线。</p>}
    {context && hasUsableContext && kind === "podcast" && <>
      {context.durationSeconds !== null && <p className="ns-source-note">节目时长 {formatSourceDuration(context.durationSeconds)}</p>}
      {!!context.chapters.length && <section className="ns-source-chapters" aria-label="节目章节"><h4>节目章节</h4>{context.chapters.map((chapter, index) => {
        const chapterUrl = chapter.url && httpsUrl(chapter.url);
        return <div key={`${chapter.startSeconds}-${index}`}><time>{formatSourceTimestamp(chapter.startSeconds)}</time>{chapterUrl ? <a href={chapterUrl} target="_blank" rel="noopener noreferrer">{chapter.title}</a> : <span>{chapter.title}</span>}</div>;
      })}</section>}
      {context.transcriptUrl && httpsUrl(context.transcriptUrl) && <p><a href={context.transcriptUrl} target="_blank" rel="noopener noreferrer">查看可用文字稿 ↗</a></p>}
    </>}
    {kind === "post" && (context?.commentsStatus === "available" && comments.length > 0
      ? <section className="ns-source-comments" aria-label="讨论"><h4>讨论</h4>{comments.map(comment => {
        const commentUrl = comment.url && httpsUrl(comment.url);
        return <article key={comment.id}><div>{typeof comment.score === "number" && <span>评分 {comment.score}</span>}{commentUrl && <a href={commentUrl} target="_blank" rel="noopener noreferrer">查看原帖 ↗</a>}</div><p>{comment.body}</p></article>;
      })}</section>
      : commentsRequireAuthorization ? <p className="ns-source-note">评论暂不可用，需要来源授权。</p>
      : commentsAvailableEmpty && <p className="ns-source-note">当前没有可展示的评论。</p>)}
  </section>;
}

export function SourceReading({ evidence, sources, eventType }: SourceReadingProps) {
  const entries = sources ?? (evidence ? [evidence] : []);
  if (!entries.length) return null;
  return <div className="ns-source-reading-list">{entries.map((source, index) =>
    <SourceReadingItem key={`${source.title}-${index}`} evidence={source} eventType={eventType} />)}</div>;
}
