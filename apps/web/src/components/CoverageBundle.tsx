import { Button } from "@fluentui/react-components";
import { Link } from "react-router-dom";
import type { Event } from "../types";
import { formatPublicationDate } from "../reader";
import { SummaryContent } from "./SummaryContent";
import "../coverage.css";
import { readingTitle } from "../editorial";

export function CoverageBundle({ event, onOpen, snapshot = false, expanded = false, matchingOnly=false, allowedEventIds, onExpandedChange }: {
  event: Pick<Event, "id" | "coverage">;
  onOpen?: (id: string, opener?: HTMLElement, note?: "archive" | null) => void;
  snapshot?: boolean;
  expanded?: boolean;
  matchingOnly?:boolean;
  allowedEventIds?:readonly string[];
  onExpandedChange?:(expanded:boolean)=>void;
}) {
  const bundle = event.coverage;
  if (!bundle || bundle.members.length < 2) return null;
  const scopedMembers=bundle.members.filter(member=>(!matchingOnly||member.matchesFilters===true)&&(!allowedEventIds||allowedEventIds.includes(member.eventId)));
  const visibleMembers = scopedMembers.filter(member => !member.hidden);
  if(!visibleMembers.length)return null;
  const hiddenCount = scopedMembers.length - visibleMembers.length;
  const materialCount=matchingOnly||allowedEventIds?scopedMembers.length:bundle.materialCount;
  const family = bundle.relation === "release_family";
  const archive = bundle.relation === "archived_materials";
  return <details className={`cp-coverage${family ? " cp-release-family" : ""}${archive ? " cp-archived-materials" : ""}`} data-coverage-key={bundle.key} open={expanded || undefined} onToggle={event=>onExpandedChange?.(event.currentTarget.open)}>
    <summary><strong>{archive ? `历史版 · ${materialCount} 篇独立文章` : `${materialCount} ${family ? "个更新" : "份相关材料"}`}</strong><span>{archive ? bundle.topic : family ? "查看各目标与版本" : "查看来源与标题"}</span></summary>
    <div className="cp-coverage-body">
      {(matchingOnly||allowedEventIds)&&<p className="cp-coverage-note">仅列出符合当前筛选的材料。</p>}
      {snapshot && <p className="cp-coverage-note">这是保存版本中收录的材料。</p>}
      {hiddenCount > 0 && <p className="cp-coverage-note">已隐藏 {hiddenCount} 个不感兴趣的条目。</p>}
      <div className={family ? "cp-release-grid" : undefined}>
        {visibleMembers.map(member => <section className="cp-coverage-member" key={member.eventId} data-coverage-member={member.eventId}>
          <div className="cp-coverage-meta">
            <span>{[...new Set(member.evidence.map(item => item.sourceName))].join(" · ") || "来源未知"}</span>
            <span>{formatPublicationDate(member.publishedAt, member.publicationPrecision)}</span>
          </div>
          <h3>{onOpen
            ? <Button appearance="subtle" onClick={click => onOpen(member.eventId, click.currentTarget, archive ? "archive" : null)}>{family ? `${member.releaseTarget} · ${member.releaseVersion}` : readingTitle(member)}</Button>
            : <Link to={`/events/${encodeURIComponent(member.eventId)}${archive ? "?readerNote=archive" : ""}`}>{family ? `${member.releaseTarget} · ${member.releaseVersion}` : readingTitle(member)}</Link>}</h3>
          {archive && <SummaryContent event={member}/>}
          {family && <p className="cp-release-highlight">{member.summaryPoints?.[0] || member.summary}</p>}
          {(family || member.eventId !== event.id) && (onOpen
            ? <Button size="small" appearance="subtle" onClick={click => onOpen(member.eventId, click.currentTarget, archive ? "archive" : null)}>查看详情</Button>
            : <Link to={`/events/${encodeURIComponent(member.eventId)}${archive ? "?readerNote=archive" : ""}`}>查看详情{snapshot ? "（保存版本）" : ""}</Link>)}
        </section>)}
      </div>
    </div>
  </details>;
}
