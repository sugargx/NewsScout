import { Badge } from "@fluentui/react-components";
import type { Event } from "../types";
import { aggregatedOnly, formatPublicationDate } from "../reader";
import { EventActions } from "./EventActions";
import { ShareButton } from "./ShareButton";
import { CoverageBundle } from "./CoverageBundle";
import { contentLabel, readingTitle } from "../editorial";
import { ReadingValue } from "./ReadingValue";
import { ReaderRow } from "./ReaderRow";

export function EventRow({ event, onOpen, onOpenRelated, selected = false }: { event: Event; onOpen?: (event: Event, opener?:HTMLElement) => void; onOpenRelated?:(id:string, opener?:HTMLElement,note?:"archive"|null)=>void;selected?: boolean }) {
  const family=event.coverage?.relation==="release_family";
  const grouped=!!event.coverage&&event.coverage.relation!=="same_named_topic";
  return <ReaderRow data-event-id={event.id} data-event-version={event.contentVersion} selected={selected}
    title={grouped?event.coverage!.topic:readingTitle(event)} onOpen={grouped?undefined:click=>onOpen?.(event,click.currentTarget)}
    meta={<><Badge appearance="tint">{event.primaryTopic}</Badge><span>{contentLabel(event)}</span><span className="ns-article-source" title={event.evidence[0]?.sourceName}>{event.evidence[0]?.sourceName}</span><time dateTime={event.publishedAt??undefined} title={event.publishedAt?formatPublicationDate(event.publishedAt,event.publicationPrecision):undefined}>{event.publishedAt ? formatPublicationDate(event.publishedAt,"day") : "来源时间未知"}</time>{event.opened && <span>已打开</span>}</>}
    preview={grouped?event.coverage!.members.filter(member=>!member.hidden).map(member=>family?`${member.releaseTarget} ${member.releaseVersion}`:member.title).join(" · "):<>{aggregatedOnly(event) ? "基于聚合摘要 · " : event.summaryKind==="feed" ? "原文摘录 · " : ""}{event.summary}</>}
    actions={!grouped&&<><ShareButton kind="event" id={event.id} compact/><EventActions event={event}/></>}>
      <CoverageBundle event={event} onOpen={onOpenRelated}/>
      {!grouped&&<ReadingValue event={event}/>}
  </ReaderRow>;
}
