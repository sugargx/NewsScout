import { Badge, Select } from "@fluentui/react-components";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { EventCard } from "../components/EventCard";
import { EventPreviewPane } from "../components/EventPreviewPane";
import { ErrorNotice } from "../components/Feedback";
import { PageHeader } from "../components/PageHeader";
import { ShareButton } from "../components/ShareButton";
import { useExposure } from "../components/useExposure";
import { useReadingWorkspace } from "../components/useReadingWorkspace";
import { editionGroups, refreshOutcome } from "../editorial";
import { formatDate } from "../reader";
import { useStyles } from "../styles";
import { ReaderLoading } from "../components/ReaderLoading";
import { EditionHeading } from "../components/EditionHeading";
import { ReaderButton } from "../components/ReaderControls";

export function BriefPage() {
  const styles=useStyles(),client=useQueryClient(),reader=useReadingWorkspace();
  const [date,setDate]=useState("latest"),[outcome,setOutcome]=useState("");
  const history=useQuery({queryKey:["briefs"],queryFn:api.briefs});
  const query=useQuery({queryKey:["brief",date],queryFn:()=>api.brief(date),
    staleTime:Infinity,refetchOnWindowFocus:false,refetchOnReconnect:false,refetchOnMount:false});
  const save=useMutation({mutationFn:api.saveBrief,onSuccess:async data=>{
    client.setQueryData(["brief","today"],data);client.setQueryData(["brief",data.localDate],data);
    await client.invalidateQueries({queryKey:["briefs"]});
  }});
  const data=query.data,visibleItems=data?.items.filter(item=>!item.notInterested)??[];
  const groups=editionGroups(visibleItems,data?.sections);
  const readerItems=[...new Set(visibleItems.flatMap(item=>
    item.coverage?.members.filter(member=>!member.hidden).map(member=>member.eventId)??[item.id]))];
  const archivedReaderItems=new Set(visibleItems.flatMap(item=>item.coverage?.relation==="archived_materials"
    ?item.coverage.members.filter(member=>!member.hidden).map(member=>member.eventId):[]));
  const index=readerItems.indexOf(reader.selectedId),exposure=useExposure(visibleItems,date);
  const select=(id:string)=>reader.select(id,archivedReaderItems.has(id)?"archive":null);
  async function refresh() {
    const before=data?.items??[],result=await query.refetch();
    if(!result.error&&result.data)setOutcome(date==="latest"?refreshOutcome(before,result.data.items):"已重新读取历史版，保存内容与顺序未改写。");
  }
  return <div className="ns-editorial-page ns-brief-page">
    <PageHeader compact eyebrow="Morning Brief" title="晨间简报"/>
    <div className="ns-edition-controls" aria-label="简报版本与更新">
      <Select aria-label="简报日期" value={date} onChange={(_,value)=>{setDate(value.value);save.reset();setOutcome("");reader.close();}}>
        <option value="latest">当前精选 · 固定顺序</option><option value="today">今日晨间版</option>
        {history.data?.items.map(item=><option value={item.localDate} key={item.localDate}>{item.localDate} · {item.itemCount} 条</option>)}
      </Select>
      <ReaderButton size="small" disabled={query.isFetching} title="仅应用已有内容与反馈，不采集来源" onClick={()=>void refresh()}>{query.isFetching?"更新中…":date==="latest"?"应用更新":"重新读取历史版"}</ReaderButton>
      <details className="ns-edition-options"><summary>版本与分享</summary><div>
        {data&&<><p>{data.localDate} · {formatDate(data.generatedAt)}</p><p>{data.isSnapshot?"这份保存版不会被之后的收录或摘要改写。":date==="today"?"这是今日简报的预览。保存后，标题、摘要与顺序都会固定。":"本次阅读内容与顺序保持不变，手动应用更新后再替换。"}</p></>}
        {data?.eligibility&&<p>等待摘要 {data.eligibility.awaitingSummary} 条 · 等待来源确认 {data.eligibility.awaitingSourceConfirmation} 条</p>}
        {!!visibleItems.length&&<ShareButton kind="brief" date={date} items={date==="latest"?visibleItems:undefined}/>}
        {date==="today"&&data&&<ReaderButton size="small" disabled={data.isSnapshot||!data.items.length||save.isPending||query.isFetching} onClick={()=>save.mutate()}>{data.isSnapshot?"今日简报已保存":save.isPending?"正在保存…":"保存今日简报"}</ReaderButton>}
        <Link to="/sources">来源与采集</Link><Link to="/settings">摘要与更新设置</Link>
      </div></details>
    </div>
    {outcome&&<p className="ns-refresh-outcome" role="status">{outcome}</p>}
    {exposure.error&&<ErrorNotice title="浏览记录未保存" error={exposure.error}/>}
    {history.error&&<ErrorNotice title="简报历史加载失败" error={history.error} retry={()=>void history.refetch()}/>}
    {query.error&&<ErrorNotice title="简报读取失败" error={query.error} retry={()=>void query.refetch()}/>}
    {save.error&&<ErrorNotice title="今日简报保存失败" error={save.error} retry={()=>save.mutate()}/>}
    {query.isLoading&&<ReaderLoading label="正在读取晨间简报…" />}
    {data&&<>
      <div className="ns-edition-byline" aria-label="简报概况"><Badge appearance="tint">{data.isSnapshot?date==="today"?"已保存晨间版":"已保存历史版":date==="latest"?"本次精选":"待保存预览"}</Badge><span>{data.localDate} · {visibleItems.length} 组 / 条 · 约 {data.estimatedMinutes} 分钟</span></div>
      {!!visibleItems.length?<><EditionHeading section={groups[0]?.section} workspace/>
      <div className={`ns-reader-workspace${reader.selectedId?" ns-reader-open":""}`}>
        <div ref={exposure.container} className="ns-edition-list">{groups.map((group,groupIndex)=><section key={group.key} className={`ns-edition-section ns-section-${group.section?.kind??"legacy"}`} data-section={group.section?.kind??"legacy"} aria-label={group.section?.title??"本版文章"}>
          {groupIndex>0&&<EditionHeading section={group.section}/>}
          {group.items.map(event=><EventCard key={event.id} event={event} brief snapshot={data.isSnapshot} selected={reader.selectedId===event.id} onOpen={(item,opener)=>reader.open(item.id,opener)} onOpenRelated={reader.open}/>)}
        </section>)}</div>
        {reader.selectedId&&<div className="ns-preview-slot"><EventPreviewPane eventId={reader.selectedId} preview={visibleItems.find(item=>item.id===reader.selectedId)} onClose={reader.close} position={index>=0?{index,count:readerItems.length}:undefined}
          onPrevious={index>0?()=>select(readerItems[index-1]):undefined} onNext={index>=0&&index<readerItems.length-1?()=>select(readerItems[index+1]):undefined}
          editionNote={reader.editionNote??(data.isSnapshot?"正在阅读当前文章版本；左侧历史版的标题、摘要与顺序保持不变。":undefined)}/></div>}
      </div></>:<div className={styles.empty}><p>本次没有符合条件的已处理新闻，不用旧闻或待处理摘录凑数。</p><div className={styles.buttonGroup}><Link to="/radar">查看新闻雷达</Link><Link to="/settings">查看摘要队列</Link><Link to="/sources">管理来源</Link></div></div>}
    </>}
  </div>;
}
