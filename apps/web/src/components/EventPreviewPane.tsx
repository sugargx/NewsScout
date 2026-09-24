import { ArrowClockwiseRegular, ArrowLeftRegular, ChevronLeftRegular, ChevronRightRegular } from "@fluentui/react-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { eventDates, updateReaderState } from "../reader";
import type { Event } from "../types";
import { EventActions } from "./EventActions";
import { ErrorNotice } from "./Feedback";
import { SummaryContent } from "./SummaryContent";
import { CoverageBundle } from "./CoverageBundle";
import { sourceReadingCapabilities, sourceReadingModel, SourceReading } from "./SourceReading";
import "../reader-extras.css";
import { contentLabel, readingTitle } from "../editorial";
import { entryText, shareEntry } from "../daily-share";
import { LoadingStatus, ReaderSkeleton } from "./ReaderLoading";
import { ReaderButton, ReaderProgress, ReaderTabs } from "./ReaderControls";
import { useReaderDialog } from "./useReaderDialog";

type ReaderPreview=Pick<Event,"title"|"displayTitle"|"summary"|"summaryKind"|"summaryPoints"|"eventType"|"evidence">
  & Partial<Pick<Event,"primaryTopic"|"publishedAt"|"freshnessAt"|"publicationPrecision"|"opened">>;

function PreviewMeta({event}:{event:ReaderPreview}) {
  return <div className="ns-preview-meta">{event.primaryTopic&&<span className="ns-preview-topic">{event.primaryTopic}</span>}<span>{contentLabel(event)}</span>
    <span>{event.evidence[0]?.sourceName??"来源未知"}</span><span>{eventDates({updatedAt:"",...event}).publication}</span>{event.opened&&<span className="ns-opened-mark">已打开</span>}</div>;
}

export function EventPreviewPane({eventId,onClose,closeLabel,backText="返回列表",navigationLabel="切换文章",onNext,onPrevious,onOpened,editionNote,preview,relatedCoverage,allowedRelatedIds,onOpenRelated,position,titleLevel=2}:{eventId:string;onClose?:()=>void;closeLabel?:string;backText?:string;navigationLabel?:string;onNext?:()=>void;onPrevious?:()=>void;onOpened?:(event:Event)=>void;editionNote?:string;preview?:ReaderPreview;relatedCoverage?:Event["coverage"];allowedRelatedIds?:readonly string[];onOpenRelated?:(id:string,opener?:HTMLElement)=>void;position?:{index:number;count:number;hasMore?:boolean};titleLevel?:1|2}) {
  const Title=titleLevel===1?"h1":"h2";
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
  const showSummary=!!data&&(data.summaryKind!=="feed"||hasDistinctSourceContext);
  const deck=data?.summaryKind==="copilot"?data.importance?.trim():"";
  const sourceUrl=data?.evidence[0]?sourceReadingModel(data.evidence[0],data.eventType).url:null;
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
  const sources=data&&<div className="ns-preview-source-content">{data.evidence.map(source=><div className="ns-reading-source" key={source.id}>
    <div className="ns-reading-source-name"><span className="ns-source-tier">{source.sourceTier}</span><strong>{source.sourceName}</strong></div>
    <SourceReading evidence={source} eventType={data.eventType}/>
  </div>)}</div>;
  return <article className="ns-preview" ref={pane} aria-label="文章就地阅读" tabIndex={-1}>
    <div className="ns-preview-toolbar">
      <div className="ns-reader-return">{onClose?<ReaderButton className="ns-preview-back" icon={<ArrowLeftRegular/>} onClick={onClose} aria-label={closeLabel??backText}><span className="ns-reader-back-label">{backText}</span></ReaderButton>:<span className="ns-preview-label">文章详情</span>}
        {position&&activeId===eventId&&<ReaderProgress {...position}/>}</div>
      <div className="ns-preview-tools">
        {activeId!==eventId&&<ReaderButton size="small" onClick={()=>setRelated(null)}>返回主题主条目</ReaderButton>}
        {(onPrevious||onNext||position)&&<nav className="ns-preview-pagination" aria-label={navigationLabel}><ReaderButton className="ns-icon-button" icon={<ChevronLeftRegular/>} aria-label="上一篇" disabled={!onPrevious} onClick={onPrevious}/><ReaderButton className="ns-icon-button" icon={<ChevronRightRegular/>} aria-label="下一篇" disabled={!onNext} onClick={onNext}/></nav>}
        <ReaderButton className="ns-icon-button" icon={<ArrowClockwiseRegular/>} aria-label={query.isStale?"读取更新":"重新读取"} disabled={query.isFetching} onClick={()=>void query.refetch()}/>
        {data&&<EventActions event={data} variant="icons"/>}
      </div>
    </div>
    <div className="ns-preview-body">
      {query.isLoading&&!data&&<section className="ns-preview-loading" aria-label="正在读取详情">
        {listPreview&&<PreviewMeta event={listPreview}/>}
        <Title className="ns-preview-title">{listPreview?readingTitle(listPreview):"正在读取详情"}</Title>
        {listPreview?.displayTitle&&listPreview.displayTitle!==listPreview.title&&<p className="ns-original-title">原始标题：{listPreview.title}</p>}
        <LoadingStatus>{listPreview?.summary?"正在读取详情，已载入的要点可先阅读…":"正在读取文章详情…"}</LoadingStatus>
        {listPreview?.summary&&<SummaryContent event={listPreview} compact/>}
        <ReaderSkeleton variant="detail"/>
      </section>}
      {query.error&&<ErrorNotice error={query.error} retry={()=>void query.refetch()} />}
      {data&&<>
        <PreviewMeta event={data}/>
        <Title className="ns-preview-title">{readingTitle(data)}</Title>
        {data.displayTitle&&data.displayTitle!==data.title&&<p className="ns-original-title">原始标题：{data.title}</p>}
        {deck&&<p className="ns-preview-deck">{deck}</p>}
        {activeEditionNote&&<p className="ns-edition-note">{activeEditionNote}</p>}
        {opened.error&&<ErrorNotice title="浏览进度尚未保存" error={opened.error} retry={()=>record(data.id)}/>}
        {hasRichSourceContent?<section className="ns-preview-section ns-preview-content-switch">
          <ReaderTabs label="详情内容" value={detailView} onChange={setDetailView} options={[{value:"summary",label:"要点"},{value:"source",label:"已收录原文 / 来源内容"}]}>
            {detailView==="summary"?(showSummary?<SummaryContent event={data}/>:<p className="ns-source-note">这篇只保留了来源摘录；请在“已收录原文 / 来源内容”中查看。</p>):sources}
          </ReaderTabs>
        </section>:<>
          {showSummary&&<section className="ns-preview-section"><h3>核心要点</h3><SummaryContent event={data}/></section>}
          <section className="ns-preview-section ns-preview-sources">{sources}</section>
        </>}
        <CoverageBundle event={{id:data.id,coverage:relatedCoverage===undefined?data.coverage:relatedCoverage}} allowedEventIds={allowedRelatedIds} onOpen={(id,opener,note)=>onOpenRelated?onOpenRelated(id,opener):setRelated({parent:eventId,id,editionNote:note==="archive"?"历史版收录时的标题与摘要保留在上一层；这里显示该文章的当前版本。":undefined})}/>
        <div className="ns-preview-actions">
          {sourceUrl&&<a className="ns-button-link ns-button-primary" href={sourceUrl} target="_blank" rel="noopener noreferrer">查看原始来源 ↗</a>}
          <CopyShareText event={data}/>
        </div>
      </>}
    </div>
  </article>;
}

function CopyShareText({ event }: { event: Event }) {
  const [status, setStatus] = useState<"" | "copied" | "failed">("");
  useEffect(() => setStatus(""), [event.id]);
  const text = entryText(shareEntry(event));
  async function copy() {
    try { await navigator.clipboard.writeText(text); setStatus("copied"); }
    catch { setStatus("failed"); }
  }
  return <>
    <ReaderButton size="small" onClick={() => void copy()}>{status === "copied" ? "已复制分享文字" : "复制分享文字"}</ReaderButton>
    <span className={status === "failed" ? "ns-preview-copy-note" : "ns-visually-hidden"} role="status">
      {status === "failed" ? "浏览器未允许自动复制，请手动复制下方文字。" : status === "copied" ? "已复制标题、概述和原文链接" : ""}</span>
    {status === "failed" && <textarea className="ns-preview-copy-manual" readOnly rows={5} aria-label="分享文字" value={text} autoFocus onFocus={field => field.currentTarget.select()} />}
  </>;
}
