import { Tab, TabList } from "@fluentui/react-components";
import { BookmarkRegular, SearchRegular } from "@fluentui/react-icons";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api";
import { EmptyState } from "../components/EmptyState";
import { EventRow } from "../components/EventRow";
import { EventPreviewPane } from "../components/EventPreviewPane";
import { TopicExplorer } from "../components/TopicExplorer";
import { useExposure } from "../components/useExposure";
import { ErrorNotice } from "../components/Feedback";
import { PageHeader } from "../components/PageHeader";
import { useReadingWorkspace } from "../components/useReadingWorkspace";
import { refreshOutcome } from "../editorial";
import type { Event } from "../types";
import { LoadingStatus, ReaderSkeleton } from "../components/ReaderLoading";
import { ReaderButton } from "../components/ReaderControls";
import { RadarControls, RadarFilterChips, radarView, type RadarFilterState } from "../components/RadarControls";

export function RadarPage({ savedOnly = false }: { savedOnly?: boolean }) {
  const viewTabsId=useId();
  const [params,setParams]=useSearchParams();
  const view=radarView(params.get("view"));
  const [search,setSearch]=useState(params.get("q")??""),[debouncedSearch,setDebouncedSearch]=useState(params.get("q")??"");
  const [topic,setTopic]=useState(params.get("topic")??""),[sort,setSort]=useState(params.get("sort")??"recommended"),[tier,setTier]=useState(params.get("tier")??"");
  const [hours,setHours]=useState(params.get("hours")??(savedOnly ? "0" : "72")),[library,setLibrary]=useState("saved"),[includeEngineering,setIncludeEngineering]=useState(params.get("includeEngineering")==="true");
  const [asOf,setAsOf]=useState(()=>new Date().toISOString());
  const [outcome,setOutcome]=useState("");
  const refreshRef=useRef<{asOf:string;scope:string;items:Event[]}|null>(null);
  const scope=JSON.stringify([savedOnly,library,debouncedSearch,topic,tier,sort,hours,includeEngineering]);
  const reader=useReadingWorkspace();
  useEffect(()=>{const timer=setTimeout(()=>setDebouncedSearch(search.trim()),350);return ()=>clearTimeout(timer);},[search]);
  useEffect(()=>{setParams(previous=>{
    const next=new URLSearchParams(previous);
    for(const [key,value] of Object.entries({q:debouncedSearch,topic,tier,sort:sort==="recommended"?"":sort,hours:hours===(savedOnly?"0":"72")?"":hours,includeEngineering:includeEngineering?"true":""})) {
      if(value)next.set(key,value);else next.delete(key);
    }
    return next.toString()===previous.toString()?previous:next;
  },{replace:true});},[debouncedSearch,topic,tier,sort,hours,includeEngineering,savedOnly,setParams]);
  const interests=useQuery({queryKey:["topics"],queryFn:api.topics});
  const query=useInfiniteQuery({
    queryKey:["events",savedOnly,library,debouncedSearch,topic,tier,sort,hours,asOf,includeEngineering,"coverage-v1"],
    initialPageParam:0,
    queryFn:({pageParam,signal})=>{
      const values=new URLSearchParams({limit:"40",offset:String(pageParam),sort,hours,asOf});
      if(!savedOnly)values.set("coverage","true");
      if(debouncedSearch) values.set("q",debouncedSearch);
      if(topic) values.set("topic",topic);
      if(tier) values.set("tier",tier);
      if(savedOnly) values.set(library==="saved" ? "saved" : "notInterested","true");
      if(!savedOnly&&includeEngineering) values.set("includeEngineering","true");
      return api.events("?"+values.toString(),signal);
    },
    getNextPageParam:last=>last.nextOffset ?? undefined,
    refetchOnWindowFocus:false,
    refetchOnReconnect:false,
    staleTime:Infinity,
  });
  const items=[...new Map((query.data?.pages.flatMap(page=>page.items) ?? []).map(event=>[event.id,event])).values()]
    .filter(event=>savedOnly?library==="saved"?event.saved&&!event.notInterested:event.notInterested:!event.notInterested);
  const exposure=useExposure(items,view);
  const topics=[...new Set([...(interests.data?.items.filter(item=>item.enabled).map(item=>item.label) ?? []),...items.flatMap(item=>item.topics),...(topic ? [topic] : [])])];
  const filterSetters:{[K in keyof RadarFilterState]:(value:RadarFilterState[K])=>void}={search:setSearch,topic:setTopic,tier:setTier,hours:setHours,sort:setSort,includeEngineering:setIncludeEngineering};
  function changeFilter<K extends keyof RadarFilterState>(key:K,value:RadarFilterState[K]) {filterSetters[key](value);reader.close();}
  const changeView=(value:string)=>setParams(previous=>{const next=new URLSearchParams(previous);if(value==="compact")next.delete("view");else next.set("view",value);return next;},{replace:true});
  const reset=()=>{refreshRef.current=null;setOutcome("");setSearch("");setDebouncedSearch("");setTopic("");setTier("");setHours(savedOnly?"0":"72");setSort("recommended");setIncludeEngineering(false);reader.close();setAsOf(new Date().toISOString());};
  const fresh=()=>{const next=new Date().toISOString();refreshRef.current={asOf:next,scope,items:query.data?.pages.flatMap(page=>page.items)??[]};setOutcome("");setAsOf(next);};
  useEffect(()=>{
    const pending=refreshRef.current;
    if(pending&&pending.scope!==scope){refreshRef.current=null;return;}
    if(pending&&pending.asOf===asOf&&query.data&&!query.isFetching) {
      if(!query.error)setOutcome(refreshOutcome(pending.items,query.data.pages.flatMap(page=>page.items)));
      refreshRef.current=null;
    }
  },[asOf,scope,query.data,query.isFetching,query.error]);
  return <div className="ns-editorial-page ns-radar-page">
    <PageHeader eyebrow={savedOnly?"Your library":"News radar"} title={savedOnly?"收藏":"新闻雷达"}
      subtitle={savedOnly?"收藏与“不感兴趣”记录会同步保存，不与其他读者共享，可随时撤销。":"用列表高效检索，或切换主题地图理解本批次的内容聚类。"}/>
    {savedOnly && <TabList className="ns-tabs" aria-label="阅读库" selectedValue={library} onTabSelect={(_,data)=>{setLibrary(String(data.value));reader.close();}}><Tab value="saved">收藏</Tab><Tab value="feedback">不感兴趣 · 可撤销</Tab></TabList>}
    <RadarControls id={viewTabsId} filters={{search,topic,tier,sort,hours,includeEngineering}} topics={topics}
      onChange={changeFilter} view={view} onViewChange={changeView} refresh={fresh} reset={reset} busy={query.isFetching} savedOnly={savedOnly}/>
    <RadarFilterChips filters={{search:debouncedSearch,topic,tier,sort,hours,includeEngineering}} onChange={changeFilter} defaultHours={savedOnly?"0":"72"}/>
    {outcome&&<p className="ns-refresh-outcome" role="status">{outcome}</p>}
    {interests.error && <ErrorNotice title="主题读取失败" error={interests.error} retry={()=>void interests.refetch()} />}
    {exposure.error && <ErrorNotice title="浏览记录未保存，本次浏览不会用于减少重复推荐" error={exposure.error} />}
    {query.error && <ErrorNotice title="新闻列表加载失败" error={query.error} retry={()=>void query.refetch()} />}
    <div id={`${viewTabsId}-panel`} role={savedOnly?undefined:"tabpanel"} aria-labelledby={savedOnly?undefined:`${viewTabsId}-${view}`}>
    {view==="topics" && !savedOnly ? <TopicExplorer hours={hours} search={debouncedSearch} tier={tier} topic={topic} asOf={asOf} reader={reader} includeEngineering={includeEngineering} sort={sort}/> : <>
      {query.isLoading ? <LoadingStatus>正在读取当前筛选的新闻…</LoadingStatus> : query.data&&!!items.length&&<p className="ns-result-count" role="status">已加载 {items.length} {savedOnly?"条":"组 / 单篇"}{query.hasNextPage?"，还有更多":""} · 本次顺序固定</p>}
      <div className={`ns-reader-workspace${reader.selectedId?" ns-reader-open":""}`}>
        <div ref={exposure.container} aria-busy={query.isLoading} className={query.isLoading||!items.length?undefined:"ns-reader-list ns-article-list"}>
          {query.isLoading?<ReaderSkeleton variant="rows" count={5}/>:items.map(event=><EventRow key={event.id} event={event} selected={event.id===reader.selectedId} onOpen={(item,opener)=>reader.open(item.id,opener)} onOpenRelated={reader.open} />)}
        </div>
        {reader.selectedId && <div className="ns-preview-slot">{(() => { const index = items.findIndex(event => event.id === reader.selectedId); return <EventPreviewPane eventId={reader.selectedId} preview={items[index]} onClose={reader.close} onPrevious={index > 0 ? () => reader.select(items[index - 1].id) : undefined} onNext={index >= 0 && index < items.length - 1 ? () => reader.select(items[index + 1].id) : undefined} editionNote={reader.editionNote??(savedOnly?"这是收藏库当前保存的条目；打开状态只记录这篇文章。":undefined)} />; })()}</div>}
      </div>
      {!query.isLoading && !query.error && !items.length && (savedOnly
        ? <EmptyState icon={<BookmarkRegular/>} title={library==="saved"?"还没有收藏":"没有标记为不感兴趣的内容"}>{library==="saved"?"在文章列表或阅读器中点击收藏，稍后从这里继续。":"标记为不感兴趣的内容会出现在这里，可随时撤销。"}</EmptyState>
        : <EmptyState icon={<SearchRegular/>} title="没有符合条件的内容" actions={<ReaderButton onClick={reset}>清除筛选</ReaderButton>}>清除搜索或放宽筛选条件；不会用旧新闻伪装今日更新。</EmptyState>)}
      {query.hasNextPage && <div className="ns-load-more"><ReaderButton disabled={query.isFetching} onClick={()=>void query.fetchNextPage()}>{query.isFetchingNextPage?"正在加载…":"加载更多"}</ReaderButton></div>}
    </>}
    </div>
  </div>;
}
