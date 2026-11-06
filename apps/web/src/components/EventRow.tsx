import type { MouseEventHandler } from "react";
import { useNavigate } from "react-router-dom";
import type { Event } from "../types";
import { aggregatedOnly, eventDates, formatPublicationDate, releaseName } from "../reader";
import { summaryPresentation } from "../summary-presentation";
import { EventActions } from "./EventActions";
import { CoverageBundle } from "./CoverageBundle";
import { readingTitle } from "../editorial";
import { ReaderRow } from "./ReaderRow";

export function rowClue(event: Pick<Event, "summary" | "summaryKind" | "summaryPoints" | "summaryMaterialLimit" | "summaryLimitations">) {
  if (event.summaryKind !== "copilot") return event.summary;
  return summaryPresentation(event).points[0] ?? event.summary;
}

export function EventRow({ event, onOpen, onOpenRelated, selected = false, snapshot = false, headingLevel = "h2" }: {
  event: Event;
  onOpen?: (event: Event, opener?: HTMLElement) => void;
  onOpenRelated?: (id: string, opener?: HTMLElement, note?: "archive" | null) => void;
  selected?: boolean;
  snapshot?: boolean;
  headingLevel?: "h2" | "h3";
}) {
  const navigate = useNavigate();
  const family = event.coverage?.relation === "release_family";
  const copy = event.coverage?.relation === "same_article";
  const development = event.coverage?.relation === "development_activity";
  const visibleCopy = copy ? event.coverage!.members.find(member => !member.hidden) : undefined;
  const hiddenCopyLead = copy && event.coverage!.members.some(member => member.eventId === event.id && member.hidden);
  const grouped = !!event.coverage && event.coverage.relation !== "same_named_topic";
  const sources = [...new Set((copy || development
    ? event.coverage!.members.filter(member => !member.hidden).flatMap(member => member.evidence)
    : event.evidence).map(item => item.sourceName))];
  const title = grouped ? event.coverage!.topic : readingTitle(event);
  const value = !grouped && event.summaryKind === "copilot" ? event.importance?.trim() : undefined;
  const dates = eventDates(event);
  const open: MouseEventHandler<HTMLButtonElement> = click => {
    if (hiddenCopyLead && visibleCopy) {
      if (onOpenRelated) onOpenRelated(visibleCopy.eventId, click.currentTarget);
      else navigate("/events/" + encodeURIComponent(visibleCopy.eventId));
    } else if (onOpen) onOpen(event, click.currentTarget);
    else navigate("/events/" + encodeURIComponent(event.id));
  };
  return <ReaderRow data-event-id={event.id} data-event-version={event.contentVersion} selected={selected} headingLevel={headingLevel}
    title={title} openLabel={title} onOpen={grouped && !copy ? undefined : open}
    meta={<><span className="ns-reader-story-topic">{event.primaryTopic}</span>
      <span className="ns-article-source" title={sources.join(" · ")}>{sources[0]}{sources.length > 1 ? ` 等 ${sources.length} 个来源` : ""}</span>
      <time dateTime={event.publishedAt ?? undefined} title={dates.publication}>{event.publishedAt ? formatPublicationDate(event.publishedAt, event.publicationPrecision) : "来源时间未知"}</time>
      {event.opened && !hiddenCopyLead && <span className="ns-opened-mark">已打开</span>}</>}
    preview={development ? "内部构建、测试与提交记录；不代表面向用户的正式发布。"
      : grouped && !copy
      ? event.coverage!.members.filter(member => !member.hidden).map(member => family ? releaseName(member) : member.title).join(" · ")
      : <>{aggregatedOnly(event) ? "基于聚合摘要 · " : ""}{rowClue(visibleCopy ?? event)}</>}
    value={value}
    actions={(!grouped || copy && !hiddenCopyLead) && <EventActions event={event} variant="icons"/>}>
    <CoverageBundle event={event} onOpen={onOpenRelated} snapshot={snapshot}/>
  </ReaderRow>;
}
