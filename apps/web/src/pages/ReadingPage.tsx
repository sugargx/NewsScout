import { Checkbox, Field, Select } from "@fluentui/react-components";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api";
import { EventPreviewPane } from "../components/EventPreviewPane";
import { useReadingWorkspace } from "../components/useReadingWorkspace";
import { PageHeader } from "../components/PageHeader";
import { eventDates } from "../reader";
import type { Event } from "../types";
import "../reader-extras.css";
import { contentLabel, readingTitle } from "../editorial";
import { LoadingStatus, ReaderSkeleton } from "../components/ReaderLoading";
import { ReaderButton, ReaderProblem, ReaderStart } from "../components/ReaderControls";

export function ReadingPage() {
  const [source,setSource]=useState("");
  const [scope,setScope]=useState("technical");
  const [hours,setHours]=useState("720");
  const sources=useQuery({queryKey:["sources"],queryFn:api.sources});
  return <div className="ns-reading-page">
    <PageHeader compact eyebrow="THE READING ROOM" title="深度阅读"/>
    <div className="ns-library-toolbar ns-reading-controls"><Field label="T1 博客来源"><Select value={source} onChange={(_,data)=>setSource(data.value)}><option value="">全部 T1 博客</option>{sources.data?.items.filter(item=>item.tier==="T1"&&item.contentType==="blog").map(item=><option value={item.id} key={item.id}>{item.name}</option>)}</Select></Field>
      <Field label="阅读内容"><Select value={scope} onChange={(_,data)=>setScope(data.value)}><option value="technical">技术与研究</option><option value="all">全部博客 · 包含公司动态</option></Select></Field><Field label="阅读时间范围"><Select value={hours} onChange={(_,data)=>setHours(data.value)}><option value="720">过去30天</option><option value="0">全部已收录 · 不限日期</option></Select></Field></div>
    <ReadingQueue key={`${source}:${scope}:${hours}`} source={source} scope={scope} hours={hours}
      sourceError={sources.error} sourceBusy={sources.isFetching} retrySources={()=>void sources.refetch()}/>
  </div>;
}
function ReadingQueue({source,scope,hours,sourceError,sourceBusy,retrySources}:{source:string;scope:string;hours:string;sourceError:Error|null;sourceBusy:boolean;retrySources:()=>void}) {
  const [asOf]=useState(()=>new Date().toISOString()),[remaining,setRemaining]=useState(false),[opened,setOpened]=useState<Set<string>>(()=>new Set());
  const reader=useReadingWorkspace();
  const query=useInfiniteQuery({queryKey:["reading",source,scope,hours,asOf],initialPageParam:0,
    staleTime:Infinity,refetchOnWindowFocus:false,refetchOnReconnect:false,
    queryFn:({pageParam,signal})=>api.events("?"+new URLSearchParams({tier:"T1",kind:"blog",hours,sort:"newest",asOf,limit:"40",offset:String(pageParam),...(scope==="technical"?{technical:"true"}:{}),...(source?{source}:{})}),signal),
    getNextPageParam:page=>page.nextOffset??undefined});
  const all=query.data?.pages.flatMap(page=>page.items).filter(item=>!item.notInterested)??[],isOpened=(event:Event)=>event.opened||opened.has(`${event.id}:${event.contentVersion}`);
  const active=all.find(item=>item.id===reader.selectedId),visible=all.filter(item=>!remaining||!isOpened(item)||item.id===active?.id);
  const position=visible.findIndex(item=>item.id===active?.id),done=all.filter(isOpened).length;
  async function next() {
    if(position>=0&&position<visible.length-1) {reader.select(visible[position+1].id);return;}
    const result=await query.fetchNextPage(),last=result.data?.pages.at(-1);
    if(last?.items[0])reader.select(last.items[0].id);
  }
  const start=<ReaderStart onStart={()=>{const first=visible[0];if(first)reader.open(first.id);}} disabled={!visible.length}/>;
  return <>
    <div className="ns-library-toolbar ns-reading-progress"><Checkbox checked={remaining} label="只看尚未打开的文章" onChange={(_,data)=>setRemaining(data.checked===true)}/>{query.data?<span>已加载 {all.length} 篇 · 已打开 {done} 篇{query.hasNextPage?" · 还有更多":""}</span>:query.isLoading?<LoadingStatus>正在读取阅读队列…</LoadingStatus>:null}</div>
    {(query.error||sourceError)&&<ReaderProblem title={query.error?"阅读队列暂时不可用":"来源目录暂时不可用"} error={query.error??sourceError}
      details={query.error&&sourceError?<p>来源目录也暂时不可用：{sourceError.message}。重试会一并重新读取。</p>:undefined}
      retry={()=>{if(query.error)void query.refetch();if(sourceError)retrySources();}} busy={query.isFetching||sourceBusy}/>}
    {!active&&!query.isLoading&&!query.error&&!!visible.length&&start}
    {query.isLoading&&<div className="ns-library ns-reader-workspace ns-queue-loading" aria-busy="true" aria-label="阅读队列加载中"><ReaderSkeleton variant="queue" count={5}/></div>}
    {!query.isLoading&&!all.length&&!query.error&&<div className="ns-library-empty">这个来源在当前时间和内容筛选下没有已收录的文章。<br/>可切换“全部已收录”阅读较早的技术文章；没有近期条目不等于采集失败。</div>}
    {!!all.length&&<div className={`ns-library ns-reader-workspace${active?" ns-reader-open":""}`}><div className="ns-library-list" aria-label="T1 顺序阅读队列">
      {visible.map((event,index)=><button type="button" className="ns-library-item" data-event-id={event.id} aria-pressed={active?.id===event.id} key={event.id} onClick={click=>reader.open(event.id,click.currentTarget)}><strong>{String(index+1).padStart(2,"0")} · {readingTitle(event)}</strong><span>{contentLabel(event)} · {event.primaryTopic} · {event.evidence.find(item=>item.sourceTier==="T1")?.sourceName} · {isOpened(event)?"已打开":"尚未打开"}</span><span>{eventDates(event).publication}</span></button>)}
      {query.hasNextPage&&<ReaderButton variant="ghost" disabled={query.isFetchingNextPage} onClick={()=>void query.fetchNextPage()}>{query.isFetchingNextPage?"加载中…":"加载更多文章"}</ReaderButton>}
    </div>{active?<div className="ns-preview-slot"><EventPreviewPane eventId={active.id} preview={active} onClose={reader.close} position={{index:position,count:visible.length,hasMore:query.hasNextPage}} onOpened={event=>setOpened(previous=>new Set(previous).add(`${event.id}:${event.contentVersion}`))}
      onPrevious={position>0?()=>reader.select(visible[position-1].id):undefined}
      onNext={position<visible.length-1||query.hasNextPage&&!query.isFetchingNextPage?()=>void next():undefined}/></div>:null}</div>}
  </>;
}
