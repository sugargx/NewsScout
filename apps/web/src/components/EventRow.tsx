import type { MouseEventHandler } from "react";
import { useNavigate } from "react-router-dom";
import type { Event } from "../types";
import { aggregatedOnly, eventDates, formatPublicationDate } from "../reader";
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
  const grouped = !!event.coverage && event.coverage.relation !== "same_named_topic";
  const sources = [...new Set(event.evidence.map(item => item.sourceName))];
  const title = grouped ? event.coverage!.topic : readingTitle(event);
  const value = !grouped && event.summaryKind === "copilot" ? event.importance?.trim() : undefined;
  const dates = eventDates(event);
  const open: MouseEventHandler<HTMLButtonElement> = click => onOpen ? onOpen(event, click.currentTarget) : navigate("/events/" + encodeURIComponent(event.id));
  return <ReaderRow data-event-id={event.id} data-event-version={event.contentVersion} selected={selected} headingLevel={headingLevel}
    title={title} openLabel={title} onOpen={grouped ? undefined : open}
    meta={<><span className="ns-reader-story-topic">{event.primaryTopic}</span>
      <span className="ns-article-source" title={sources.join(" · ")}>{sources[0]}{sources.length > 1 ? ` 等 ${sources.length} 个来源` : ""}</span>
      <time dateTime={event.publishedAt ?? undefined} title={dates.publication}>{event.publishedAt ? formatPublicationDate(event.publishedAt, event.publicationPrecision) : "来源时间未知"}</time>
      {event.opened && <span className="ns-opened-mark">已打开</span>}</>}
    preview={grouped
      ? event.coverage!.members.filter(member => !member.hidden).map(member => family ? `${member.releaseTarget} ${member.releaseVersion}` : member.title).join(" · ")
      : <>{aggregatedOnly(event) ? "基于聚合摘要 · " : ""}{rowClue(event)}</>}
    value={value}
    actions={!grouped && <EventActions event={event} variant="icons"/>}>
    <CoverageBundle event={event} onOpen={onOpenRelated} snapshot={snapshot}/>
  </ReaderRow>;
}
