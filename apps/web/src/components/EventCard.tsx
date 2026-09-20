import { useNavigate } from "react-router-dom";
import type { Event } from "../types";
import { useStyles } from "../styles";
import { eventDates, formatPublicationDate } from "../reader";
import { EventActions } from "./EventActions";
import { ShareButton } from "./ShareButton";
import { SummaryContent } from "./SummaryContent";
import { CoverageBundle } from "./CoverageBundle";
import { readingTitle } from "../editorial";
import { ReadingValue } from "./ReadingValue";
import { ReaderStory } from "./ReaderStory";

export function EventCard({ event, snapshot = false, onOpen, onOpenRelated, selected = false, brief = false }: { event: Event; snapshot?: boolean; onOpen?: (event: Event, opener?: HTMLElement) => void;onOpenRelated?:(id:string, opener?:HTMLElement,note?:"archive"|null)=>void; selected?: boolean;brief?:boolean }) {
  const styles = useStyles();
  const navigate = useNavigate();
  const dates = eventDates(event);
  const sources = [...new Set(event.evidence.map(item => item.sourceName))];
  const rawExcerpt = event.summaryKind === "feed";
  const longExcerpt = rawExcerpt && event.summary.length > 240;
  const family = event.coverage?.relation==="release_family";
  const grouped=!!event.coverage&&event.coverage.relation!=="same_named_topic";
  const open:React.MouseEventHandler<HTMLButtonElement>=click=>onOpen?onOpen(event,click.currentTarget):navigate("/events/"+encodeURIComponent(event.id));
  return <ReaderStory className={brief?"ns-brief-card":undefined} data-event-id={event.id} data-event-version={event.contentVersion}
    title={grouped?event.coverage!.topic:readingTitle(event)} selected={selected} onOpen={grouped?undefined:open}
    meta={<><span className="ns-reader-story-topic">{event.primaryTopic}</span><span className="ns-article-source" title={sources.join(" · ")}>{sources[0]}{sources.length>1?` 等 ${sources.length} 个来源`:""}</span><time dateTime={event.publishedAt??undefined} title={dates.publication}>{event.publishedAt?formatPublicationDate(event.publishedAt,"day"):dates.publication}</time>{event.opened&&<span>已打开</span>}</>}
    actions={!grouped&&<>
      {!snapshot&&!brief&&<ShareButton kind="event" id={event.id} compact/>}
      <ReadingValue event={event}/><EventActions event={event}/>
    </>}>
    {grouped?<p className="ns-group-description">{family?`${event.coverage!.materialCount} 个相关更新`:"来源材料合并展示，可分别阅读。"}</p>:<>
    {!brief&&<div className={styles.summaryLabel}>{event.summaryKind === "feed" ? "原文摘录" : "要点"}</div>}
    {brief?<SummaryContent event={event} compact/>:longExcerpt ? <details className={styles.excerptDisclosure}><summary><span>{event.summary.slice(0, 240)}…</span><span className={styles.excerptToggle}>展开来源摘录</span></summary><p className={styles.summary}>{event.summary}</p></details>
      : <SummaryContent event={event} compact/>}
    </>}
    <CoverageBundle event={event} onOpen={onOpenRelated} snapshot={snapshot} expanded={family&&!brief}/>
  </ReaderStory>;
}
