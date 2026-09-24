import { ChevronRightRegular, OptionsRegular, ShareRegular, SparkleRegular } from "@fluentui/react-icons";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import { EmptyState } from "../components/EmptyState";
import { EventCard } from "../components/EventCard";
import { EventPreviewPane } from "../components/EventPreviewPane";
import { ErrorNotice } from "../components/Feedback";
import { MetaParts } from "../components/MetaParts";
import { PageHeader } from "../components/PageHeader";
import { useQuickInterests } from "../components/QuickInterests";
import { useExposure } from "../components/useExposure";
import { useReadingWorkspace } from "../components/useReadingWorkspace";
import { editionDateLabel, editionGroups, editionRefetchInterval, editionTime } from "../editorial";
import { ReaderLoading } from "../components/ReaderLoading";
import { ReaderButton } from "../components/ReaderControls";
import "../daily-share.css";

// A quiet day counts only the fresh 24-hour picks; 补读 items are older by definition.
function quietNote(scope: string, fresh: number, earlier: number) {
  if (!fresh) return `${scope}没有达到标准的新内容，下面是 ${earlier} 篇值得补读的较早内容。`;
  return `${scope}符合标准的新内容较少，只收录 ${fresh} 篇${earlier ? `，另有 ${earlier} 篇值得补读` : ""}。`;
}

export function BriefPage() {
  const reader=useReadingWorkspace(),navigate=useNavigate(),openInterests=useQuickInterests(),sectionId=useId();
  const [date,setDate]=useState("latest"),[outcome,setOutcome]=useState("");
  const latest=date==="latest";
  const history=useQuery({queryKey:["briefs"],queryFn:api.briefs});
  const current=useQuery({queryKey:["brief","latest"],queryFn:()=>api.brief("latest"),staleTime:Infinity,
    refetchOnWindowFocus:false,refetchOnReconnect:false,refetchOnMount:false,refetchInterval:query=>editionRefetchInterval(query.state.data)});
  const archived=useQuery({queryKey:["brief",date],queryFn:()=>api.brief(date),enabled:!latest,
    staleTime:Infinity,refetchOnWindowFocus:false,refetchOnReconnect:false,refetchOnMount:false});
  const query=latest?current:archived,data=query.data;
  const shownEdition=useRef("");
  useEffect(()=>{
    const edition=current.data?.isSnapshot?current.data.localDate:"";
    if(shownEdition.current&&edition&&edition!==shownEdition.current)setOutcome(`今日精选已更新为 ${editionDateLabel(edition)}版。`);
    if(edition)shownEdition.current=edition;
  },[current.data]);
  const visibleItems=data?.items.filter(item=>!item.notInterested)??[];
  const catchUpIds=new Set(data?.sections?.filter(section=>section.kind==="catch_up").flatMap(section=>section.eventIds)??[]);
  const freshCount=visibleItems.filter(item=>!catchUpIds.has(item.id)).length;
  const groups=editionGroups(visibleItems,data?.sections);
  const readerItems=[...new Set(visibleItems.flatMap(item=>
    item.coverage?.members.filter(member=>!member.hidden).map(member=>member.eventId)??[item.id]))];
  const archivedReaderItems=new Set(visibleItems.flatMap(item=>item.coverage?.relation==="archived_materials"
    ?item.coverage.members.filter(member=>!member.hidden).map(member=>member.eventId):[]));
  const index=readerItems.indexOf(reader.selectedId),exposure=useExposure(visibleItems,date);
  const select=(id:string)=>reader.select(id,archivedReaderItems.has(id)?"archive":null);
  const currentEdition=current.data?.isSnapshot?current.data.localDate:"";
  const pastEditions=history.data?.items.filter(item=>item.localDate!==currentEdition)??[];
  return <div className="ns-editorial-page ns-brief-page">
    <PageHeader eyebrow="Today’s selection" title={latest?"今日精选":"往期精选"}
      subtitle={latest?"每天定时生成当天精选，生成后全天固定，按价值从高到低排列。":"已保存的往期版本，标题、摘要与顺序保持当时的样子。"}
      action={<ReaderButton icon={<OptionsRegular/>} aria-haspopup="dialog" onClick={()=>openInterests?.()}>调整兴趣</ReaderButton>}/>
    {latest&&<button type="button" className="ns-fresh" onClick={()=>navigate("/radar?hours=24&sort=newest")}>
      <span><b>最近 24 小时的新内容</b><small>按来源时间，查看最新发生了什么</small></span><ChevronRightRegular aria-hidden="true"/>
    </button>}
    <div className="ns-batch-bar" aria-label="精选版本">
      <select className="ns-select" aria-label="精选日期" value={date} onChange={event=>{setDate(event.currentTarget.value);setOutcome("");reader.close();}}>
        <option value="latest">今日精选（最新）</option>
        {pastEditions.map(item=><option value={item.localDate} key={item.localDate}>{item.localDate} · {item.itemCount} 条</option>)}
      </select>
      {data&&<span className="ns-batch-meta"><MetaParts parts={[
        `${editionDateLabel(data.localDate)}版`,...(visibleItems.length?[`${visibleItems.length} 篇`,`约 ${data.estimatedMinutes} 分钟`]:[]),
        ...(data.windowEnd?[<time key="cutoff" dateTime={data.windowEnd} aria-label="本版选文截止">选文截至 {editionTime(data.windowEnd)}</time>]:[]),
        ...(latest&&data.nextRefreshAt?[<time key="next" dateTime={data.nextRefreshAt} aria-label="下次更新">下次更新 {editionTime(data.nextRefreshAt)}</time>]:[]),
      ]}/></span>}
      {latest&&!!visibleItems.length&&<div className="ns-batch-actions"><Link className="ns-button-link ns-brief-share-link" to="/share"><ShareRegular aria-hidden="true"/>生成今日分享图</Link></div>}
    </div>
    {latest&&data?.refreshPending&&<p className="ns-refresh-outcome" role="status">今日精选正在生成，先为你展示上一期；生成完成后会自动更新。</p>}
    {latest&&data&&!data.isSnapshot&&!data.refreshPending&&!!visibleItems.length&&<p className="ns-refresh-outcome" role="note">今日版尚未生成，当前按最新内容预览。</p>}
    {outcome&&<p className="ns-refresh-outcome" role="status">{outcome}</p>}
    {data&&visibleItems.length>0&&freshCount<5&&<p className="ns-quiet-note" role="note">{quietNote(latest&&!data.refreshPending?"今天":"这一期",freshCount,visibleItems.length-freshCount)}</p>}
    {exposure.error&&<ErrorNotice title="浏览记录未保存" error={exposure.error}/>}
    {history.error&&<ErrorNotice title="往期精选加载失败" error={history.error} retry={()=>void history.refetch()}/>}
    {query.error&&<ErrorNotice title="精选读取失败" error={query.error} retry={()=>void query.refetch()}/>}
    {query.isLoading&&<ReaderLoading label="正在读取今日精选…" variant="rows" count={5}/>}
    {data&&(visibleItems.length?<div className={`ns-reader-workspace${reader.selectedId?" ns-reader-open":""}`}>
        <div ref={exposure.container} className="ns-edition-list">{groups.map((group,groupIndex)=><section key={group.key} className={`ns-article-list ns-edition-section ns-section-${group.section?.kind??"legacy"}`} data-section={group.section?.kind??"legacy"} aria-labelledby={`${sectionId}-${groupIndex}`}>
          <div className="ns-section-line" data-edition-kind={group.section?.kind}><h2 id={`${sectionId}-${groupIndex}`}>{group.section?.title??"值得阅读"}</h2>
            <span>{group.items.length} 篇 · {group.section?.description??"按兴趣权重排序"}</span></div>
          {group.items.map(event=><EventCard key={event.id} event={event} brief snapshot={data.isSnapshot} selected={reader.selectedId===event.id} onOpen={(item,opener)=>reader.open(item.id,opener)} onOpenRelated={reader.open}/>)}
        </section>)}</div>
        {reader.selectedId&&<div className="ns-preview-slot"><EventPreviewPane eventId={reader.selectedId} preview={visibleItems.find(item=>item.id===reader.selectedId)} onClose={reader.close} position={index>=0?{index,count:readerItems.length}:undefined}
          onPrevious={index>0?()=>select(readerItems[index-1]):undefined} onNext={index>=0&&index<readerItems.length-1?()=>select(readerItems[index+1]):undefined}
          editionNote={reader.editionNote??(data.isSnapshot&&!latest?"正在阅读当前文章版本；左侧往期精选的标题、摘要与顺序保持不变。":undefined)}/></div>}
      </div>
      :<EmptyState icon={<SparkleRegular/>} title={latest?"今天还没有达到标准的内容":"这一期没有可读的精选"} actions={<><Link className="ns-button-link" to="/radar">查看新闻雷达</Link><Link className="ns-button-link" to="/sources">查看来源采集</Link></>}>
        今日精选只收录达到标准的已处理新闻，不用旧闻或待处理摘录凑数。可以先到新闻雷达看看最新动态。</EmptyState>)}
  </div>;
}
