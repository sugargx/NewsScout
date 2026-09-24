import { CalendarRegular } from "@fluentui/react-icons";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { EmptyState } from "../components/EmptyState";
import { EventCard } from "../components/EventCard";
import { EventPreviewPane } from "../components/EventPreviewPane";
import { useReadingWorkspace } from "../components/useReadingWorkspace";
import { ErrorNotice } from "../components/Feedback";
import { PageHeader } from "../components/PageHeader";
import { editionGroups, refreshOutcome } from "../editorial";
import { formatPublicationDate } from "../reader";
import { ReaderLoading } from "../components/ReaderLoading";
import { EditionHeading } from "../components/EditionHeading";
import { ReaderButton } from "../components/ReaderControls";
import { WeeklyTopics } from "../components/ReaderOverview";
import { useSearchParams } from "react-router-dom";
import "../reader-extras.css";

export function WeeklyPage() {
  const query=useQuery({queryKey:["weekly"],queryFn:()=>api.weekly(),staleTime:Infinity,refetchOnWindowFocus:false,refetchOnReconnect:false});
  const reader=useReadingWorkspace(),[outcome,setOutcome]=useState("");
  const [params,setParams]=useSearchParams();
  const items=query.data?.items.filter(item=>!item.notInterested)??[];
  const groups=editionGroups(items,query.data?.sections);
  const topic=params.get("weekTopic")??(reader.selectedId?"all":"");
  const visibleGroups=topic==="all"?groups:groups.filter(group=>group.key===topic);
  const activeId=reader.selectedId;
  async function refresh() {
    const before=query.data?.items??[],result=await query.refetch();
    if(!result.error&&result.data)setOutcome(refreshOutcome(before,result.data.items));
  }
  return <div className="ns-editorial-page ns-weekly-page">
    <PageHeader eyebrow="Weekly review" title="每周回顾" subtitle="从主题出发，回看过去七天真正发生的变化。"/>
    <div className="ns-batch-bar ns-weekly-toolbar"><span className="ns-batch-meta">{query.data?`${formatPublicationDate(query.data.windowStart,"day")} — ${formatPublicationDate(query.data.windowEnd,"day")} · ${items.length} 篇`:"过去一周 · 按主题回顾"}</span><div className="ns-batch-actions"><ReaderButton size="small" disabled={query.isFetching} onClick={()=>void refresh()}>{query.isFetching?"更新中…":"更新回顾"}</ReaderButton></div></div>
    {outcome&&<p className="ns-refresh-outcome" role="status">{outcome}</p>}
    {query.error&&<ErrorNotice error={query.error} retry={()=>void query.refetch()}/>}
    {query.isLoading&&<ReaderLoading label="正在读取本周回顾…" />}
    {query.data&&!items.length&&<EmptyState icon={<CalendarRegular/>} title="本周还没有可回顾的内容">最近 7 天还没有符合条件的已完成摘要，不以默认摘录凑数。</EmptyState>}
    {!!items.length&&<WeeklyTopics topics={groups.map(group=>({key:group.key,title:group.section?.title??"本周材料",count:group.items.length}))}
      selected={topic} onSelect={key=>setParams(previous=>{const next=new URLSearchParams(previous);next.set("weekTopic",key);next.delete("reader");next.delete("readerNote");return next;})}/>}
    {!!items.length&&!visibleGroups.length&&<EmptyState icon={<CalendarRegular/>} title="选择一个主题开始回顾">先看关心的领域，也可以选择“全部主题”顺序浏览。</EmptyState>}
    <div className={`ns-weekly-grid ns-reader-workspace${activeId?" ns-reader-open":""}`}><div className="ns-edition-list">
      {visibleGroups.map(group=><section id={`week-${group.key}`} key={group.key} className="ns-article-list ns-edition-section" data-section={group.section?.kind??"legacy"} aria-label={group.section?.title??"本周文章"}>
        <EditionHeading section={group.section} count={group.items.length}/>
        {group.items.map(event=><EventCard key={event.id} event={event} brief selected={activeId===event.id} onOpen={(item,opener)=>reader.open(item.id,opener)} onOpenRelated={reader.open}/>)}
      </section>)}
    </div>{activeId&&<div className="ns-preview-slot"><EventPreviewPane eventId={activeId} preview={items.find(item=>item.id===activeId)} onClose={reader.close} editionNote={reader.editionNote??undefined}/></div>}</div>
  </div>;
}
