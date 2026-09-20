import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { EventCard } from "../components/EventCard";
import { EventPreviewPane } from "../components/EventPreviewPane";
import { useReadingWorkspace } from "../components/useReadingWorkspace";
import { ShareButton } from "../components/ShareButton";
import { ErrorNotice } from "../components/Feedback";
import { PageHeader } from "../components/PageHeader";
import { editionGroups, refreshOutcome } from "../editorial";
import { formatPublicationDate } from "../reader";
import { ReaderLoading } from "../components/ReaderLoading";
import { EditionHeading } from "../components/EditionHeading";
import { ReaderButton } from "../components/ReaderControls";
import "../reader-extras.css";

export function WeeklyPage() {
  const query=useQuery({queryKey:["weekly"],queryFn:()=>api.weekly(),staleTime:Infinity,refetchOnWindowFocus:false,refetchOnReconnect:false});
  const reader=useReadingWorkspace(),[outcome,setOutcome]=useState("");
  const items=query.data?.items.filter(item=>!item.notInterested)??[];
  const groups=editionGroups(items,query.data?.sections);
  const activeId=reader.selectedId;
  async function refresh() {
    const before=query.data?.items??[],result=await query.refetch();
    if(!result.error&&result.data)setOutcome(refreshOutcome(before,result.data.items));
  }
  return <div className="ns-editorial-page ns-weekly-page">
    <PageHeader compact eyebrow="THE WEEKLY EDIT" title="每周回顾" subtitle="按主题回看重要进展，不只追逐最新一条。"/>
    <div className="ns-library-toolbar ns-weekly-toolbar"><span>{query.data?`${formatPublicationDate(query.data.windowStart,"day")} — ${formatPublicationDate(query.data.windowEnd,"day")} · ${items.length} 篇`:"过去一周 · 按主题回顾"}</span><div className="ns-edition-controls"><ReaderButton size="small" disabled={query.isFetching} onClick={()=>void refresh()}>更新回顾</ReaderButton>{!!items.length&&<ShareButton kind="week" date="latest" items={items} compact/>}</div></div>
    {outcome&&<p className="ns-refresh-outcome" role="status">{outcome}</p>}
    {query.error&&<ErrorNotice error={query.error} retry={()=>void query.refetch()}/>}
    {query.isLoading&&<ReaderLoading label="正在读取本周回顾…" />}
    {query.data&&!items.length&&<div className="ns-library-empty">最近7天还没有符合条件的已完成摘要，不以默认摘录凑数。</div>}
    {groups.some(group=>group.section)&&<nav className="ns-weekly-outline" aria-label="本周主题目录">{groups.filter(group=>group.section).map(group=><a href={`#week-${group.key}`} key={group.key}>{group.section!.title}<span>{group.items.length} 篇</span></a>)}</nav>}
    <EditionHeading section={groups[0]?.section} id={groups[0]?`week-${groups[0].key}`:undefined} workspace/>
    <div className={`ns-weekly-grid ns-reader-workspace${activeId?" ns-reader-open":""}`}><div className="ns-edition-list">
      {groups.map((group,groupIndex)=><section id={groupIndex>0?`week-${group.key}`:undefined} key={group.key} className="ns-edition-section" data-section={group.section?.kind??"legacy"} aria-label={group.section?.title??"本周文章"}>
        {groupIndex>0&&<EditionHeading section={group.section}/>}
        {group.items.map(event=><EventCard key={event.id} event={event} brief selected={activeId===event.id} onOpen={(item,opener)=>reader.open(item.id,opener)} onOpenRelated={reader.open}/>)}
      </section>)}
    </div>{activeId&&<div className="ns-preview-slot"><EventPreviewPane eventId={activeId} preview={items.find(item=>item.id===activeId)} onClose={reader.close} editionNote={reader.editionNote??undefined}/></div>}</div>
  </div>;
}
