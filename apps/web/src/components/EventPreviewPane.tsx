import { Badge } from "@fluentui/react-components";
import { ArrowClockwiseRegular, ArrowLeftRegular, ChevronLeftRegular, ChevronRightRegular } from "@fluentui/react-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { eventDates, updateReaderState } from "../reader";
import type { Event } from "../types";
import { EventActions } from "./EventActions";
import { ErrorNotice } from "./Feedback";
import { ShareButton } from "./ShareButton";
import { SummaryContent } from "./SummaryContent";
import { CoverageBundle } from "./CoverageBundle";
import { sourceReadingCapabilities, SourceReading } from "./SourceReading";
import "../reader-extras.css";
import { contentLabel, readingTitle } from "../editorial";
import { ReadingValue } from "./ReadingValue";
import { LoadingStatus, ReaderSkeleton } from "./ReaderLoading";
import { ReaderButton, ReaderProgress, ReaderTabs } from "./ReaderControls";
import { useReaderDialog } from "./useReaderDialog";

type ReaderPreview=Pick<Event,"title"|"displayTitle"|"summary"|"summaryKind"|"summaryPoints"|"eventType"|"evidence">
  & Partial<Pick<Event,"primaryTopic"|"publishedAt"|"freshnessAt"|"publicationPrecision"|"opened">>;

export function EventPreviewPane({eventId,onClose,onNext,onPrevious,onOpened,editionNote,preview,relatedCoverage,allowedRelatedIds,onOpenRelated,position}:{eventId:string;onClose?:()=>void;onNext?:()=>void;onPrevious?:()=>void;onOpened?:(event:Event)=>void;editionNote?:string;preview?:ReaderPreview;relatedCoverage?:Event["coverage"];allowedRelatedIds?:readonly string[];onOpenRelated?:(id:string,opener?:HTMLElement)=>void;position?:{index:number;count:number;hasMore?:boolean}}) {
  const [related,setRelated]=useState<{parent:string;id:string;editionNote?:string}|null>(null);
  const [detailView,setDetailView]=useState<"summary"|"source">("summary");
  const activeId=related?.parent===eventId?related.id:eventId;
  const activeEditionNote=related?.parent===eventId?related.editionNote??editionNote:editionNote;
  const client=useQueryClient(),recorded=useRef(""),pane=useRef<HTMLElement>(null);
  useReaderDialog(pane);
  const callback=useRef(onOpened);callback.current=onOpened;
  const query=useQuery({queryKey:["event",activeId],queryFn:()=>api.event(activeId),enabled:!!activeId,
    staleTime:Infinity,refetchOnWindowFocus:false,refetchOnReconnect:false});
  const opened=useMutation({mutationFn:(id:string)=>api.eventState(id,{opened:true}),
    onSuccess:event=>{updateReaderState(client,event);callback.current?.(event);}});
  const record=opened.mutate,data=query.data;
  const sourceCapabilities=data?sourceReadingCapabilities(data.evidence,data.summary):{hasDistinctBody:false,hasDetailSourceContent:false};
  const hasDistinctSourceContext=sourceCapabilities.hasDistinctBody;
  const hasRichSourceContent=sourceCapabilities.hasDetailSourceContent;
  const listPreview=activeId===eventId?preview:undefined;
  useEffect(()=>{
    if(data && recorded.current!==`${data.id}:${data.contentVersion}`) {
      recorded.current=`${data.id}:${data.contentVersion}`;record(data.id);
    }
  },[data?.id,data?.contentVersion,record]);
  useEffect(()=>{if(pane.current)pane.current.scrollTop=0;},[activeId]);
  useEffect(()=>setDetailView("summary"),[activeId]);
  useEffect(()=>{
    const close=(event:KeyboardEvent)=>{if(event.key==="Escape"&&!event.defaultPrevented&&onClose) {event.preventDefault();onClose();}};
    window.addEventListener("keydown",close);
    return ()=>window.removeEventListener("keydown",close);
  },[onClose]);
  useEffect(()=>{if(data)pane.current?.focus({preventScroll:true});},[data?.id,data?.contentVersion]);
  return <article className="ns-preview" ref={pane} aria-label="文章就地阅读" tabIndex={-1}>
    <div className="ns-preview-toolbar">
      <div className="ns-reader-return">{onClose?<ReaderButton size="small" variant="ghost" icon={<ArrowLeftRegular/>} onClick={onClose} aria-label="关闭阅读面板"><span className="ns-reader-back-label">返回列表</span></ReaderButton>:<span>文章详情</span>}
      {position&&activeId===eventId&&<ReaderProgress {...position}/>}</div>
      <div>
      <ReaderButton size="small" variant="ghost" icon={<ArrowClockwiseRegular/>} aria-label={query.isStale?"读取更新":"重新读取"} disabled={query.isFetching} onClick={()=>void query.refetch()}><span className="ns-reader-refresh-label">{query.isStale ? "读取更新" : "重新读取"}</span></ReaderButton>
      {activeId!==eventId&&<ReaderButton size="small" onClick={()=>setRelated(null)}>返回主题主条目</ReaderButton>}
      {(onPrevious||onNext||position)&&<span className="ns-preview-pagination"><ReaderButton size="small" variant="ghost" icon={<ChevronLeftRegular/>} aria-label="上一篇" disabled={!onPrevious} onClick={onPrevious}><span className="ns-reader-sequence-label">上一篇</span></ReaderButton><ReaderButton size="small" icon={<ChevronRightRegular/>} aria-label="下一篇" disabled={!onNext} onClick={onNext}><span className="ns-reader-sequence-label">下一篇</span></ReaderButton></span>}
    </div></div>
    {query.isLoading&&!data&&<section className="ns-preview-loading" aria-label="正在读取详情">
      {listPreview&&<div className="ns-preview-meta">{listPreview.primaryTopic&&<Badge appearance="tint">{listPreview.primaryTopic}</Badge>}<span>{contentLabel(listPreview)}</span><span>{listPreview.evidence[0]?.sourceName}</span><span>{eventDates({updatedAt:"",...listPreview}).publication}</span>{listPreview.opened&&<span>已打开</span>}</div>}
      <h2 className="ns-preview-title">{listPreview?readingTitle(listPreview):"正在读取详情"}</h2>
      {listPreview?.displayTitle&&listPreview.displayTitle!==listPreview.title&&<p className="ns-original-title">原始标题：{listPreview.title}</p>}
      <LoadingStatus>{listPreview?.summary?"正在读取详情，已载入的要点可先阅读…":"正在读取文章详情…"}</LoadingStatus>
      {listPreview?.summary&&<SummaryContent event={listPreview} compact/>}
      <ReaderSkeleton variant="detail"/>
    </section>}
    {query.error&&<ErrorNotice error={query.error} retry={()=>void query.refetch()} />}
    {data&&<>
      <div className="ns-preview-meta"><Badge appearance="tint">{data.primaryTopic}</Badge><span>{contentLabel(data)}</span><span>{data.evidence[0]?.sourceName ?? "来源未知"}</span><span>{eventDates(data).publication}</span>{data.opened&&<span>已打开</span>}</div>
      <h2 className="ns-preview-title">{readingTitle(data)}</h2>
      {data.displayTitle&&data.displayTitle!==data.title&&<p className="ns-original-title">原始标题：{data.title}</p>}
      {activeEditionNote&&<p className="ns-edition-note">{activeEditionNote}</p>}
      <div className="ns-preview-actions"><EventActions event={data}/><ShareButton kind="event" id={data.id} compact/></div>
      {opened.error&&<ErrorNotice title="浏览进度尚未保存" error={opened.error} retry={()=>record(data.id)}/>}
      {hasRichSourceContent?<section className="ns-preview-content-switch">
        <ReaderTabs label="详情内容" value={detailView} onChange={setDetailView} options={[{value:"summary",label:"要点"},{value:"source",label:"已收录原文 / 来源内容"}]}>
        {detailView==="summary"?(data.summaryKind!=="feed"||hasDistinctSourceContext?<SummaryContent event={data}/>:<p className="ns-source-note">这篇只保留了来源摘录；请在“已收录原文 / 来源内容”中查看。</p>)
          :<section className="ns-preview-source-content"><h3>已收录原文 / 来源内容</h3>{data.evidence.map(source=><div className="ns-reading-source" key={source.id}>
            <div><Badge appearance="outline">{source.sourceTier}</Badge><strong>{source.sourceName}</strong></div>
            <SourceReading evidence={source} eventType={data.eventType}/>
          </div>)}</section>}
        </ReaderTabs>
      </section>:<>
        {(data.summaryKind!=="feed"||hasDistinctSourceContext)&&<section><h3>要点</h3><SummaryContent event={data}/></section>}
        <section className="ns-preview-source-content"><h3>已收录原文 / 来源内容</h3>{data.evidence.map(source=><div className="ns-reading-source" key={source.id}>
          <div><Badge appearance="outline">{source.sourceTier}</Badge><strong>{source.sourceName}</strong></div>
          <SourceReading evidence={source} eventType={data.eventType}/>
        </div>)}</section>
      </>}
      <CoverageBundle event={{id:data.id,coverage:relatedCoverage===undefined?data.coverage:relatedCoverage}} allowedEventIds={allowedRelatedIds} onOpen={(id,opener,note)=>onOpenRelated?onOpenRelated(id,opener):setRelated({parent:eventId,id,editionNote:note==="archive"?"历史版收录时的标题与摘要保留在上一层；这里显示该文章的当前版本。":undefined})}/>
      <ReadingValue event={data} expanded/>
    </>}
  </article>;
}
