import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Checkbox } from "@fluentui/react-components";
import { ArrowClockwiseRegular, BookOpenRegular, BookmarkFilled, BookmarkRegular, CalendarRegular, HomeRegular, OptionsRegular, RadarRegular, StarRegular, WeatherMoonRegular, WeatherSunnyRegular } from "@fluentui/react-icons";
import { Fragment, startTransition, useEffect, useId, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { SummaryContent } from "../components/SummaryContent";
import { TopicWorkspace, type TopicDataSource, type TopicReadingContext } from "../components/TopicExplorer";
import { CoverageBundle } from "../components/CoverageBundle";
import { hasPublicOpened, loadPublicFeedback, publicApi, publicDate, publicFeedbackKey, publicView, recordPublicOpen, savePublicFeedback, type PublicArticle, type PublicFeedback, type PublicView } from "../public-reader";
import { interestSignature, loadPublicInterests, publicInterestKey, withPublicInterests, type PublicInterestRecord } from "../public-interests";
import { PublicInterestDialog } from "../components/PublicInterestDialog";
import "../public-reader.css";
import "../topic-explorer.css";
import "../reader-extras.css";
import "../editorial-reader.css";
import { contentLabel, disinterestReasons, editionGroups, readingTitle, refreshOutcome } from "../editorial";
import { ReaderShell } from "../components/ReaderShell";
import { PageHeader } from "../components/PageHeader";
import { LoadingStatus, ReaderSkeleton } from "../components/ReaderLoading";
import { ReadingValue } from "../components/ReadingValue";
import { EditionHeading } from "../components/EditionHeading";
import { ReaderNavigation } from "../components/ReaderNavigation";
import { ReaderButton, ReaderProblem, ReaderStart } from "../components/ReaderControls";
import { ReaderStory } from "../components/ReaderStory";
import { ReaderRow } from "../components/ReaderRow";
import { PublicArticlePane } from "../components/PublicArticlePane";
import { RadarControls, RadarFilterChips, radarView, type RadarView, type RadarFilterState } from "../components/RadarControls";
import { ReadingInvitation, SelectionOverview, WeeklyTopics } from "../components/ReaderOverview";

const publicLinks=[
  {key:"brief",label:"今日精选",shortLabel:"精选",icon:HomeRegular},
  {key:"radar",label:"新闻雷达",shortLabel:"雷达",icon:RadarRegular},
  {key:"reading",label:"深度阅读",shortLabel:"深读",icon:BookOpenRegular},
  {key:"weekly",label:"每周回顾",shortLabel:"回顾",icon:CalendarRegular},
  {key:"saved",label:"收藏",shortLabel:"收藏",icon:StarRegular},
] satisfies {key:PublicView;label:string;shortLabel:string;icon:typeof HomeRegular}[];

export function PublicReader() {
  const [params,setParams]=useSearchParams(),location=useLocation(),navigate=useNavigate();
  const radarTabsId=useId();
  const tab=publicView(location.pathname,params.get("tab"));
  const eventId=params.get("article")??location.pathname.match(/^\/events\/([0-9a-f-]+)$/i)?.[1]??"";
  const weeklyTopic=params.get("weekTopic")??(tab==="weekly"&&eventId?"all":"");
  const edition=params.get("edition")??"latest",archived=tab==="brief"&&edition!=="latest";
  const readingSource=params.get("readingSource")??"",readingScope=params.get("readingScope")??"technical",readingHours=params.get("readingHours")??"720";
  const [remaining,setRemaining]=useState(false),[readingRevision,setReadingRevision]=useState(0),[nextPending,setNextPending]=useState(false);
  const readingAsOf=useMemo(()=>new Date().toISOString(),[readingSource,readingScope,readingHours,readingRevision,tab]);
  const pendingReadingRefresh=useRef<{previous:PublicArticle[];asOf:string}|null>(null);
  const [search,setSearch]=useState(params.get("q")??""),[queryText,setQueryText]=useState(params.get("q")??""),[tier,setTier]=useState(params.get("tier")??""),[hours,setHours]=useState(params.get("hours")??"72");
  const [includeEngineering,setIncludeEngineering]=useState(params.get("includeEngineering")==="true");
  const [view,setView]=useState<RadarView>(()=>radarView(params.get("view")));
  const [topic,setTopic]=useState(params.get("topic")??""),[sort,setSort]=useState(params.get("sort")??"recommended");
  const [radarAsOf,setRadarAsOf]=useState(()=>new Date().toISOString());
  const [knownTopics,setKnownTopics]=useState<string[]>([]);
  const pendingRadarRefresh=useRef<{previous:PublicArticle[];asOf:string;scope:string}|null>(null);
  const topicScope=tab==="radar"&&view==="topics";
  const [outcome,setOutcome]=useState("");
  const initial=useMemo(loadPublicFeedback,[]);
  const [feedback,setFeedback]=useState(initial.value),[storageError,setStorageError]=useState(initial.error);
  const [interestRecord,setInterestRecord]=useState(loadPublicInterests);
  const [pendingInterests,setPendingInterests]=useState<PublicInterestRecord|null>(null);
  const [interestOpen,setInterestOpen]=useState(false);
  const interestTrigger=useRef<HTMLButtonElement>(null);
  const interestOpener=useRef<HTMLElement|null>(null);
  const interests=interestSignature(interestRecord.value);
  const [briefAsOf,setBriefAsOf]=useState(()=>new Date().toISOString());
  const pendingBriefRefresh=useRef<{previous:PublicArticle[];asOf:string;interests:string}|null>(null);
  const publicTopics=useMemo<TopicDataSource<PublicArticle>>(()=>({
    key:interests?`public-interests-${interests}`:"public",maxOffset:1000,
    events:(params,signal)=>publicApi.events(withPublicInterests(params,interests),signal),
    explore:(params,signal)=>publicApi.explore(withPublicInterests(params,interests),signal),
  }),[interests]);
  const [undo,setUndo]=useState("");
  const [theme,setTheme]=useState(document.documentElement.dataset.theme??"light");
  const radarScope=JSON.stringify([queryText,topic,tier,hours,sort,includeEngineering,interests]);
  const workspaceScope=JSON.stringify(tab==="brief"?[tab,edition,...(archived?[]:[interests,briefAsOf])]:tab==="reading"?[tab,readingAsOf]:tab==="radar"?[tab,radarScope,view,radarAsOf]:tab==="weekly"?[tab,weeklyTopic]:[tab]);
  const scroll=useRef(0),previousId=useRef(eventId),previousTab=useRef(tab),detail=useRef<HTMLElement>(null);
  const previousScope=useRef(workspaceScope);
  const listButtons=useRef(new Map<string,HTMLElement>());
  const lastOpened=useRef(""),lastOpener=useRef<HTMLElement|null>(null);
  const current=useRef({tab,workspaceScope,readingAsOf,eventId,feedback,remaining});current.current={tab,workspaceScope,readingAsOf,eventId,feedback,remaining};
  useEffect(()=>{const timer=setTimeout(()=>setQueryText(search.trim()),300);return()=>clearTimeout(timer);},[search]);
  useEffect(()=>{
    const changed=(event:StorageEvent)=>{if(event.key===publicFeedbackKey||event.key===null){const stored=loadPublicFeedback();setFeedback(stored.value);setStorageError(stored.error);}};
    window.addEventListener("storage",changed);return()=>window.removeEventListener("storage",changed);
  },[]);
  useEffect(()=>{
    const changed=(event:StorageEvent)=>{
      if(event.key!==null&&event.key!==publicInterestKey)return;
      const next=loadPublicInterests();
      setPendingInterests(next.raw===interestRecord.raw&&next.error===interestRecord.error?null:next);
    };
    window.addEventListener("storage",changed);return()=>window.removeEventListener("storage",changed);
  },[interestRecord.raw,interestRecord.error]);
  useEffect(()=>{
    if(eventId&&eventId!==previousId.current) {
      detail.current?.focus({preventScroll:true});
      if(detail.current)detail.current.scrollTop=0;
      if(window.innerWidth<=1024)window.scrollTo({top:0});
    } else if(!eventId&&previousId.current&&previousScope.current===workspaceScope) {
      window.scrollTo({top:scroll.current});
      if(!topicScope) {
        const opener=lastOpener.current?.isConnected?lastOpener.current:listButtons.current.get(lastOpened.current);
        (opener??document.querySelector<HTMLElement>(".ns-beta-feed button")??document.getElementById("main-content"))?.focus({preventScroll:true});
      }
    }
    if(previousTab.current!==tab)window.scrollTo({top:0});
    previousId.current=eventId;
    previousTab.current=tab;
    previousScope.current=workspaceScope;
  },[eventId,tab,workspaceScope,topicScope]);
  useEffect(()=>{
    if(!eventId||interestOpen)return;
    const escape=(event:KeyboardEvent)=>{
      if(event.key==="Escape"&&!event.defaultPrevented) {
        event.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown",escape);
    return()=>window.removeEventListener("keydown",escape);
  },[eventId,location.pathname,navigate,setParams,interestOpen]);
  const frozen={staleTime:Infinity,refetchOnWindowFocus:false,refetchOnReconnect:false};
  const history=useQuery({queryKey:["public-brief-history"],queryFn:({signal})=>publicApi.briefs(signal),enabled:tab==="brief",...frozen});
  const brief=useQuery({queryKey:["public-brief",edition,archived?"":interests,archived?"":briefAsOf],
    queryFn:({signal})=>publicApi.brief(edition,signal,archived?"":interests,briefAsOf),enabled:tab==="brief",...frozen});
  const weekly=useQuery({queryKey:["public-weekly"],queryFn:({signal})=>publicApi.weekly(signal),enabled:tab==="weekly",...frozen});
  const readingSources=useQuery({queryKey:["public-reading-sources"],queryFn:({signal})=>publicApi.readingSources(signal),enabled:tab==="reading",...frozen});
  const queue=useInfiniteQuery({
    queryKey:["public-reading",readingSource,readingScope,readingHours,readingAsOf],enabled:tab==="reading",initialPageParam:0,
    queryFn:({pageParam,signal})=>publicApi.reading(new URLSearchParams({
      hours:readingHours,scope:readingScope,asOf:readingAsOf,limit:"40",offset:String(pageParam),...(readingSource?{source:readingSource}:{}),
    }),signal),getNextPageParam:page=>page.nextOffset??undefined,...frozen,
  });
  const filters=withPublicInterests(new URLSearchParams({hours,sort,asOf:radarAsOf,...(queryText?{q:queryText}:{}),...(topic?{topic}:{}),...(tier?{tier}:{}),...(includeEngineering?{includeEngineering:"true"}:{})}),interests);
  const feed=useInfiniteQuery({
    queryKey:["public-feed",queryText,topic,tier,hours,sort,radarAsOf,includeEngineering,interests],enabled:tab==="radar",initialPageParam:0,
    queryFn:({pageParam,signal})=>publicApi.events(new URLSearchParams({...Object.fromEntries(filters),limit:"40",offset:String(pageParam)}),signal),
    getNextPageParam:page=>page.nextOffset!=null&&page.nextOffset<=1000?page.nextOffset:undefined,...frozen,
  });
  useEffect(()=>{
    const receivedTopics=feed.data?.pages.flatMap(page=>page.items.flatMap(item=>[item.primaryTopic,...item.topics]))??[];
    setKnownTopics(previous=>{const next=[...new Set([...previous,...receivedTopics])].filter(Boolean).sort();return next.length===previous.length?previous:next;});
  },[feed.data]);
  const articleInterests=tab==="radar"||tab==="brief"&&!archived?interests:"";
  const article=useQuery({queryKey:["public-article",eventId,articleInterests],queryFn:({signal})=>publicApi.event(eventId,signal,articleInterests),enabled:!!eventId,...frozen});
  const received=tab==="brief"?brief.data?.items:tab==="weekly"?weekly.data?.items:tab==="reading"?queue.data?.pages.flatMap(page=>page.items):tab==="radar"?feed.data?.pages.flatMap(page=>page.items):[];
  const items=[...new Map((received??[]).map(item=>[item.id,item])).values()]
    .filter(item=>item.coverage&&item.coverage.relation!=="same_named_topic"&&tab!=="reading"
      ?item.coverage.members.some(member=>!feedback.dismissed.includes(member.eventId)):!feedback.dismissed.includes(item.id));
  const selected=article.data;
  const listPreview=items.find(item=>item.id===eventId);
  useEffect(()=>{
    if(selected?.id===eventId&&(!feedback.opened.includes(eventId)
      ||selected.contentVersion!==undefined&&(feedback.openedVersions?.[eventId]??-1)<selected.contentVersion))
      update(recordPublicOpen(feedback,selected));
  },[selected?.id,selected?.contentVersion,eventId,feedback]);
  const queueVisible=items.filter(item=>!remaining||!hasPublicOpened(feedback,item)||item.id===eventId);
  const queued=eventId?queueVisible:queueVisible.slice(1);
  const queueLimited=queue.data?.pages.at(-1)?.paginationLimited===true;
  const groups=editionGroups(items,tab==="brief"?brief.data?.sections:tab==="weekly"?weekly.data?.sections:[]);
  const visibleGroups=tab!=="weekly"||weeklyTopic==="all"?groups:groups.filter(group=>group.key===weeklyTopic);
  const displayedItems=tab==="weekly"?visibleGroups.flatMap(group=>group.items):items;
  const readingIds=[...new Set(tab==="saved"?Object.keys(feedback.saved).reverse():tab==="reading"?queueVisible.map(item=>item.id):displayedItems.flatMap(item=>
    item.coverage?.members.filter(member=>!feedback.dismissed.includes(member.eventId)).map(member=>member.eventId)??[item.id]))];
  const readingIndex=readingIds.indexOf(eventId);
  const sectionStarts=new Map(visibleGroups.filter(group=>group.section).map(group=>[group.items[0].id,group]));
  const groupAnchor=(key:string)=>`public-week-${key}`;
  useEffect(()=>{
    const pending=pendingBriefRefresh.current;if(!pending)return;
    if(tab!=="brief"||archived||pending.interests!==interests){pendingBriefRefresh.current=null;return;}
    if(pending.asOf!==briefAsOf||brief.isFetching)return;
    if(brief.data&&!brief.error)setOutcome(refreshOutcome(pending.previous,brief.data.items));
    if(brief.data||brief.error)pendingBriefRefresh.current=null;
  },[brief.data,brief.error,brief.isFetching,briefAsOf,tab,archived,interests]);
  useEffect(()=>{
    const pending=pendingReadingRefresh.current;
    if(!pending)return;
    if(tab!=="reading"){pendingReadingRefresh.current=null;return;}
    if(pending.asOf===readingAsOf||queue.isFetching)return;
    if(queue.data)setOutcome(refreshOutcome(pending.previous,queue.data.pages.flatMap(page=>page.items)));
    if(queue.data||queue.error)pendingReadingRefresh.current=null;
  },[queue.data,queue.error,queue.isFetching,readingAsOf,tab]);
  useEffect(()=>{
    const pending=pendingRadarRefresh.current;if(!pending)return;
    if(tab!=="radar"||pending.scope!==radarScope){pendingRadarRefresh.current=null;return;}
    if(pending.asOf!==radarAsOf||feed.isFetching)return;
    if(feed.data&&!feed.error)setOutcome(refreshOutcome(pending.previous,feed.data.pages.flatMap(page=>page.items)));
    if(feed.data||feed.error)pendingRadarRefresh.current=null;
  },[feed.data,feed.error,feed.isFetching,radarAsOf,radarScope,tab]);
  useEffect(()=>{setParams(previous=>{
    const next=new URLSearchParams(previous);
    for(const [key,value] of Object.entries({q:queryText,topic,tier,sort:sort==="recommended"?"":sort,hours:hours==="72"?"":hours,view:view==="compact"?"":view,includeEngineering:includeEngineering?"true":""})) {
      if(value)next.set(key,value);else next.delete(key);
    }
    return previous.toString()===next.toString()?previous:next;
  },{replace:true});},[queryText,topic,tier,sort,hours,view,includeEngineering,setParams]);
  function update(next:PublicFeedback) {
    if(initial.error){setStorageError(initial.error);return false;}
    try {savePublicFeedback(next);setFeedback(next);setStorageError(null);return true;}
    catch {setStorageError("浏览器未能保存操作，可能是存储权限或空间不足。此次操作尚未生效。");return false;}
  }
  function openInterestDialog(opener:HTMLElement) {
    interestOpener.current=opener;setInterestOpen(true);
  }
  function closeInterestDialog() {
    setInterestOpen(false);
    if(interestOpen)requestAnimationFrame(()=>{
      const opener=interestOpener.current;
      (opener?.isConnected&&opener.getClientRects().length?opener:interestTrigger.current)?.focus({preventScroll:true});
    });
  }
  function applyInterests(next:PublicInterestRecord) {
    if(next.error){setPendingInterests(next);return;}
    const changed=interestSignature(next.value)!==interests;
    setInterestRecord(next);setPendingInterests(null);
    if(changed) {
      const cutoff=new Date().toISOString();
      pendingBriefRefresh.current=null;pendingRadarRefresh.current=null;
      setBriefAsOf(cutoff);setRadarAsOf(cutoff);
      if(tab==="radar"||tab==="brief"&&!archived)close();
    }
    setOutcome(next.value.length?"兴趣已保存，用于当前精选和雷达推荐；历史晨报、深读和周报顺序不变。":"已恢复共享推荐；本浏览器的收藏和阅读记录保持不变。");
    closeInterestDialog();
  }
  function favorite(item:PublicArticle) {
    const saved={...feedback.saved};
    if(saved[item.id])delete saved[item.id];else saved[item.id]={title:readingTitle(item),publisher:item.evidence[0]?.sourceName??"",savedAt:new Date().toISOString()};
    update({...feedback,saved});
  }
  function dismiss(id:string) {
    if(update({...feedback,dismissed:[...new Set([...feedback.dismissed,id])]})){setUndo(id);if(id===eventId)close();}
  }
  function open(id:string,originId=id,opener?:HTMLElement) {
    if(!eventId){scroll.current=window.scrollY;lastOpened.current=originId;lastOpener.current=opener??listButtons.current.get(originId)??null;}
    setParams(previous=>{const next=new URLSearchParams(previous);next.set("article",id);return next;});
  }
  function close() {
    if(location.pathname.startsWith("/events/")){const next=new URLSearchParams(params);next.delete("article");navigate("/?"+next,{replace:true});return;}
    setParams(previous=>{const next=new URLSearchParams(previous);next.delete("article");return next;},{replace:true});
  }
  function changeTab(next:PublicView) {
    const nextParams=new URLSearchParams(params);nextParams.delete("article");
    if(next==="brief")nextParams.delete("tab");else nextParams.set("tab",next);
    navigate("/?"+nextParams);setOutcome("");
  }
  function changeEdition(value:string) {
    setParams(previous=>{const next=new URLSearchParams(previous);next.delete("article");if(value==="latest")next.delete("edition");else next.set("edition",value);return next;});
    setOutcome("");
  }
  function changeReadingFilter(key:"readingSource"|"readingScope"|"readingHours",value:string) {
    setParams(previous=>{const next=new URLSearchParams(previous);next.delete("article");if(value)next.set(key,value);else next.delete(key);return next;});
    setRemaining(false);setOutcome("");pendingReadingRefresh.current=null;
  }
  async function nextArticle() {
    if(readingIndex>=0&&readingIndex<readingIds.length-1){open(readingIds[readingIndex+1]);return;}
    if(tab!=="reading"||readingIndex<0||!queue.hasNextPage||nextPending)return;
    const active=current.current;
    setNextPending(true);
    try {
      let result=await queue.fetchNextPage();
      for(;;) {
        if(current.current.tab!==active.tab||current.current.readingAsOf!==active.readingAsOf||current.current.eventId!==active.eventId)return;
        if(result.error)return;
        const all=[...new Map((result.data?.pages.flatMap(page=>page.items)??[]).map(item=>[item.id,item])).values()];
        const index=all.findIndex(item=>item.id===active.eventId);
        const next=index<0?undefined:all.slice(index+1).find(item=>!current.current.feedback.dismissed.includes(item.id)
          &&(!current.current.remaining||!hasPublicOpened(current.current.feedback,item)));
        if(next){open(next.id);return;}
        if(!result.hasNextPage)return;
        result=await queue.fetchNextPage();
      }
    } finally {setNextPending(false);}
  }
  async function refresh() {
    const scope=workspaceScope;
    setOutcome("");
    if(tab==="brief") {
      if(!archived&&interests) {
        const next=new Date().toISOString();
        pendingBriefRefresh.current={previous:brief.data?.items??[],asOf:next,interests};
        close();setBriefAsOf(next);void history.refetch();return;
      }
      const before=brief.data?.items??[],result=await brief.refetch();
      if(current.current.workspaceScope!==scope)return;
      if(result.data&&!result.error)setOutcome(archived?"已重新读取历史版，保存内容与顺序未改写。":refreshOutcome(before,result.data.items));
      void history.refetch();
    }
    if(tab==="weekly") {
      const before=weekly.data?.items??[],result=await weekly.refetch();
      if(current.current.workspaceScope!==scope)return;
      if(result.data&&!result.error)setOutcome(refreshOutcome(before,result.data.items));
    }
    if(tab==="reading") {
      if(readingSources.error)void readingSources.refetch();
      pendingReadingRefresh.current={previous:queue.data?.pages.flatMap(page=>page.items)??[],asOf:readingAsOf};
      close();setReadingRevision(value=>value+1);
    }
    if(tab==="radar") {
      const next=new Date().toISOString();
      pendingRadarRefresh.current={previous:feed.data?.pages.flatMap(page=>page.items)??[],asOf:next,scope:radarScope};
      close();setRadarAsOf(next);
    }
  }
  function actions(item:PublicArticle) {
    const saved=!!feedback.saved[item.id];
    return <div className="ns-beta-actions"><ReaderButton variant="ghost" size="small" icon={saved?<BookmarkFilled/>:<BookmarkRegular/>}
      aria-label={`${saved?"取消收藏":"收藏"}：${readingTitle(item)}`} aria-pressed={saved} onClick={()=>favorite(item)}>{saved?"已收藏":"收藏"}</ReaderButton>
      <ReaderButton variant="ghost" size="small" onClick={()=>dismiss(item.id)}>不感兴趣</ReaderButton></div>;
  }
  function coverage(item:PublicArticle,inReader=false) {
    const parent=inReader?(items.find(candidate=>candidate.id===item.id)??items.find(candidate=>candidate.coverage?.members.some(member=>member.eventId===item.id))):item;
    const fixedEdition=tab==="brief"||tab==="weekly";
    const bundle=fixedEdition&&parent?parent.coverage:item.coverage;
    const allowed=tab==="reading"||archived?readingIds:undefined;
    return <CoverageBundle event={{id:item.id,coverage:bundle?{...bundle,
      members:bundle.members.map(member=>({...member,hidden:feedback.dismissed.includes(member.eventId)})),
    }:bundle}} onOpen={(id,opener)=>open(id,item.id,opener)} snapshot={archived} allowedEventIds={allowed}/>;
  }
  function renderArticle(context?:TopicReadingContext<PublicArticle>) {
    return <PublicArticlePane item={selected} preview={context?.item.preview??listPreview} containerRef={detail}
      loading={article.isLoading} error={article.error} refreshing={article.isFetching} refresh={()=>void article.refetch()}
      close={context?.close??close} previous={context?context.previous:readingIndex>0?()=>open(readingIds[readingIndex-1]):undefined}
      next={context?context.next:readingIndex>=0&&(readingIndex<readingIds.length-1||tab==="reading"&&queue.hasNextPage&&!queue.isFetchingNextPage)?()=>void nextArticle():undefined}
      nextPending={nextPending} position={context?{index:context.index,count:context.count,hasMore:context.hasMore}:readingIndex>=0?{index:readingIndex,count:readingIds.length,hasMore:tab==="reading"&&queue.hasNextPage}:undefined}
      archived={archived} actions={selected&&actions(selected)}
      coverage={selected&&(context?<CoverageBundle event={{id:selected.id,coverage:context.item.coverage}} matchingOnly allowedEventIds={context.allowedIds} onOpen={context.open}/>:coverage(selected,true))}/>;
  }
  const filterSetters:{[K in keyof RadarFilterState]:(value:RadarFilterState[K])=>void}={search:setSearch,topic:setTopic,tier:setTier,hours:setHours,sort:setSort,includeEngineering:setIncludeEngineering};
  function changeFilter<K extends keyof RadarFilterState>(key:K,value:RadarFilterState[K]) {filterSetters[key](value);close();setOutcome("");}
  function resetFilters() {setSearch("");setQueryText("");setTopic("");setTier("");setSort("recommended");setHours("72");setIncludeEngineering(false);setOutcome("");pendingRadarRefresh.current=null;close();setRadarAsOf(new Date().toISOString());}
  const error=tab==="brief"?brief.error:tab==="weekly"?weekly.error:tab==="reading"?queue.error:tab==="radar"?feed.error:null;
  const busy=tab==="brief"?brief.isFetching:tab==="weekly"?weekly.isFetching:tab==="reading"?queue.isFetching:tab==="radar"&&feed.isFetching;
  const loading=tab==="brief"?brief.isLoading:tab==="weekly"?weekly.isLoading:tab==="reading"?queue.isLoading:tab==="radar"&&feed.isLoading;
  const loadingLabel=tab==="brief"?archived?"正在读取历史晨报…":"正在读取晨间精选…":tab==="weekly"?"正在读取本周回顾…":tab==="reading"?"正在读取阅读队列…":"正在读取当前筛选的新闻…";
  function statusLine() {
    if(loading)return <LoadingStatus>{loadingLabel}</LoadingStatus>;
    if(error&&!received)return null;
    if(tab==="brief")return <p>{brief.data?`${brief.data.localDate} · ${items.length} 条 · ${archived?"已保存历史版":interests?"你的兴趣精选，顺序固定":"本次精选，顺序固定"}`:"简报尚未载入"}</p>;
    if(tab==="weekly")return <p>{weekly.data?`${publicDate(weekly.data.windowStart,"day")} — ${publicDate(weekly.data.windowEnd,"day")} · ${items.length} 篇`:"过去一周 · 按主题回顾"}</p>;
    if(tab==="reading")return <p>{queue.data?`已加载 ${items.length} 篇 · 已打开 ${items.filter(item=>hasPublicOpened(feedback,item)).length} 篇${queueLimited?" · 已到本次浏览上限":queue.hasNextPage?" · 还有更多":""}`:"阅读队列尚未载入"}</p>;
    if(tab==="saved")return <p>本浏览器独享 · 不跨设备同步</p>;
    return <p>{feed.data?`已加载 ${items.length} 组 / 单篇${feed.hasNextPage?"，还有更多":""} · ${interests&&sort==="recommended"?"按你的兴趣推荐":"本次顺序固定"}`:"新闻列表尚未载入"}</p>;
  }
  const title=tab==="brief"?archived?"历史晨报":"今日精选":tab==="weekly"?"每周回顾":tab==="reading"?"深度阅读":tab==="saved"?"收藏":"新闻雷达";
  return <ReaderShell badge="公开试读" navigation={
    <ReaderNavigation label="公开阅读视图" activeKey={tab} onSelect={changeTab}
      items={publicLinks.map(({key,label,shortLabel,icon:Icon})=>({key,label,shortLabel,icon:<Icon/>,...(key==="saved"?{count:Object.keys(feedback.saved).length}:{})}))}/>
  } footer={<><ReaderButton size="small" variant="ghost" icon={<OptionsRegular/>} onClick={event=>openInterestDialog(event.currentTarget)}>兴趣设置</ReaderButton>
    <ReaderButton size="small" variant="ghost" aria-label="切换明暗主题" icon={theme==="dark"?<WeatherSunnyRegular/>:<WeatherMoonRegular/>}
    onClick={()=>{const next=theme==="dark"?"light":"dark";document.documentElement.dataset.theme=next;setTheme(next);}}><span className="ns-theme-label">{theme==="dark"?"浅色模式":"深色模式"}</span></ReaderButton>
    <p className="ns-reader-local-note">偏好只保存在此浏览器</p></>}>
    <div className={`ns-beta ns-editorial-page${tab==="radar"?" ns-radar-page":""}${tab==="weekly"?" ns-weekly-page":""}${tab==="reading"?" ns-reading-page":""}${eventId?" is-reading":""}`}>
    <PageHeader compact eyebrow={tab==="brief"?"值得读什么":tab==="reading"?"连续阅读队列":tab==="weekly"?"给重要变化一点上下文":tab==="saved"?"留给下次阅读":"浏览已收录内容"} title={title}
      action={<ReaderButton ref={interestTrigger} className="ns-interest-trigger" icon={<OptionsRegular/>}
        aria-label={interestRecord.value.length?`兴趣主题（已选 ${interestRecord.value.length} 项）`:"兴趣主题"} onClick={event=>openInterestDialog(event.currentTarget)}>兴趣主题
        {!!interestRecord.value.length&&<span className="ns-interest-count" aria-hidden="true">{interestRecord.value.length}</span>}</ReaderButton>}/>
    {interestOpen&&<PublicInterestDialog onClose={closeInterestDialog} onApply={applyInterests}/>}
    {(interestRecord.error||pendingInterests)&&<aside className="ns-interest-notice" aria-label="兴趣设置提示">
      <p role={pendingInterests?.error||interestRecord.error?"alert":"status"}>{pendingInterests?.error??interestRecord.error??"另一页面更新了兴趣；本页仍保留当前阅读顺序。"}</p>
      {pendingInterests&&!pendingInterests.error?<ReaderButton size="small" onClick={()=>applyInterests(loadPublicInterests())}>应用其他页面的设置</ReaderButton>:
        <ReaderButton size="small" onClick={event=>openInterestDialog(event.currentTarget)}>查看兴趣设置</ReaderButton>}
    </aside>}
    {storageError&&<div className="ns-beta-error" role="alert">{storageError}</div>}
    {undo&&<aside className="ns-feedback-undo" aria-label="本浏览器反馈"><p role="status">已在本浏览器隐藏这条内容。</p><div className="ns-feedback-buttons"><ReaderButton size="small" onClick={()=>{const reasons={...feedback.reasons};delete reasons[undo];if(update({...feedback,reasons,dismissed:feedback.dismissed.filter(id=>id!==undo)}))setUndo("");}}>撤销不感兴趣</ReaderButton>
      <details><summary>补充理由（可选）</summary><div>{disinterestReasons.map(reason=><ReaderButton key={reason.value} size="small" aria-pressed={feedback.reasons?.[undo]===reason.value} onClick={()=>update({...feedback,reasons:{...feedback.reasons,[undo]:reason.value}})}>{reason.label}</ReaderButton>)}</div></details><ReaderButton size="small" variant="ghost" aria-label="关闭反馈提示" onClick={()=>setUndo("")}>关闭</ReaderButton></div></aside>}
    {tab==="brief"&&<>
      {!archived&&brief.data&&<SelectionOverview date={brief.data.localDate} count={items.length} minutes={brief.data.estimatedMinutes} windowEnd={brief.data.windowEnd} updateLabel="更新内容"
        onLatest={()=>startTransition(()=>{setHours("24");setSort("newest");changeTab("radar");})}/>}
      <div className="ns-beta-edition-controls">
        <div className="ns-field"><label className="ns-field-label" htmlFor="ns-public-edition">晨报版本</label><select id="ns-public-edition" className="ns-select" value={edition} onChange={event=>changeEdition(event.currentTarget.value)}>
          <option value="latest">当前精选</option>
          {archived&&!history.data?.items.some(item=>item.localDate===edition)&&<option value={edition}>{edition} · 历史版</option>}
          {history.data?.items.map(item=><option key={item.localDate} value={item.localDate}>{item.localDate} · {item.itemCount} 条</option>)}
        </select></div>
        <p data-archived={archived}>{archived?"已保存的历史版，保留当时的标题、摘要和顺序。":interests?"按你的兴趣选文；保存新兴趣或点击更新时才重新排序。":"本次精选保持不变；点击更新后再读取。"}
          {archived&&brief.data?.windowEnd&&<span> <time dateTime={brief.data.windowEnd} aria-label="本版选文截止">截至 {publicDate(brief.data.windowEnd,"time")}（北京时间）</time></span>}
          {history.isLoading?" 正在读取历史版本…":history.data&&!history.data.items.length?" 还没有已保存的历史版。":""}</p>
      </div>
      {history.error&&<div role="alert" className="ns-beta-error">历史版本列表未载入：{history.error.message}<ReaderButton size="small" onClick={()=>void history.refetch()}>重试历史列表</ReaderButton></div>}
    </>}
    {tab==="reading"&&<>
      <div className="ns-filters ns-reading-controls">
        <select aria-label="T1 博客来源" value={readingSource} onChange={event=>changeReadingFilter("readingSource",event.currentTarget.value)}>
          <option value="">全部 T1 博客</option>
          {readingSource&&!readingSources.data?.items.some(source=>source.id===readingSource)&&<option value={readingSource}>所选来源</option>}
          {readingSources.data?.items.map(source=><option key={source.id} value={source.id}>{source.name}</option>)}
        </select>
        <select aria-label="阅读内容" value={readingScope} onChange={event=>changeReadingFilter("readingScope",event.currentTarget.value)}><option value="technical">技术与研究</option><option value="all">全部博客 · 包含公司动态</option></select>
        <select aria-label="阅读时间范围" value={readingHours} onChange={event=>changeReadingFilter("readingHours",event.currentTarget.value)}><option value="720">过去 30 天</option><option value="0">全部已收录 · 不限日期</option></select>
      </div>
      {readingSources.error&&!queue.error&&<ReaderProblem title="来源目录暂时不可用" error={readingSources.error} retry={()=>void readingSources.refetch()} busy={readingSources.isFetching}/>}
    </>}
    {tab==="radar"&&<>
      <RadarControls id={radarTabsId} filters={{search,topic,tier,sort,hours,includeEngineering}} topics={[...new Set([...knownTopics,...(topic?[topic]:[])])]}
        onChange={changeFilter} view={view} onViewChange={value=>{close();setView(value);setOutcome("");}} refresh={()=>void refresh()} reset={resetFilters} busy={feed.isFetching} shared personalized={!!interests}/>
      <RadarFilterChips filters={{search:queryText,topic,tier,sort,hours,includeEngineering}} onChange={changeFilter}/>
    </>}
    {!topicScope&&<div className="ns-beta-section-title"><div>
      {tab==="reading"&&<Checkbox checked={remaining} label="只看尚未打开的文章" onChange={(_,data)=>setRemaining(data.checked===true)}/>}
      {statusLine()}</div>
      {tab!=="saved"&&tab!=="radar"&&!error&&<ReaderButton size="small" icon={<ArrowClockwiseRegular/>} disabled={busy} onClick={()=>void refresh()}>{busy?"读取中…":archived?"重新读取历史版":tab==="reading"?"更新队列":"更新内容"}</ReaderButton>}
    </div>}
    {outcome&&<p className="ns-refresh-outcome" role="status">{outcome}</p>}
    {error&&!topicScope&&<ReaderProblem title={tab==="reading"?"阅读队列暂时不可用":tab==="weekly"?"本周回顾暂时不可用":tab==="brief"?"简报暂时不可用":"新闻暂时不可用"} error={error}
      details={tab==="reading"&&readingSources.error?<p>来源目录也暂时不可用：{readingSources.error.message}。重试会一并重新读取。</p>:undefined} retry={()=>void refresh()} busy={busy}/>}
    {tab==="weekly"&&weekly.data&&!!items.length&&<WeeklyTopics
      topics={groups.map(group=>({key:group.key,title:group.section?.title??"本周材料",count:group.items.length}))} selected={weeklyTopic}
      onSelect={key=>setParams(previous=>{const next=new URLSearchParams(previous);next.set("weekTopic",key);next.delete("article");return next;})}/>}
    {tab==="weekly"&&!!items.length&&!visibleGroups.length&&<div className="ns-beta-empty"><h2>选择一个主题开始回顾</h2><p>先看关心的领域，也可以选择“全部主题”顺序浏览。</p></div>}
    <EditionHeading section={visibleGroups[0]?.section} id={tab==="weekly"&&visibleGroups[0]?groupAnchor(visibleGroups[0].key):undefined} workspace/>
    {tab==="reading"&&!loading&&!!queueVisible.length&&<ReaderStart disabled={false} hidden={!!eventId}
      title={readingTitle(queueVisible[0])} meta={<>{contentLabel(queueVisible[0])} · {queueVisible[0].evidence[0]?.sourceName} · {publicDate(queueVisible[0].publishedAt,queueVisible[0].publicationPrecision)} · {hasPublicOpened(feedback,queueVisible[0])?"已打开":"尚未打开"}</>}
      preview={<SummaryContent event={queueVisible[0]} compact/>} onStart={event=>open(queueVisible[0].id,queueVisible[0].id,event.currentTarget)}/>}
    {tab==="reading"&&!eventId&&queued.length>0&&<h2 className="ns-queue-next-title">接下来</h2>}
    <div className={topicScope?"ns-beta-topic-panel":`ns-beta-workspace ns-reader-workspace${eventId?" has-reading ns-reader-open":""}${tab==="reading"?` ns-library${!loading&&!eventId&&!queueVisible.length?" is-empty":""}`:""}`}
      id={tab==="radar"?`${radarTabsId}-panel`:undefined} role={tab==="radar"?"tabpanel":undefined} aria-labelledby={tab==="radar"?`${radarTabsId}-${view}`:undefined}>
      {topicScope?<TopicWorkspace hours={hours} search={queryText} tier={tier} topic={topic} asOf={radarAsOf} sort={sort} includeEngineering={includeEngineering}
        dataSource={publicTopics} dismissed={feedback.dismissed} reader={{selectedId:eventId,open:(id,opener)=>open(id,id,opener??undefined),close,select:id=>open(id)}} renderArticle={renderArticle}/>:<>
      <section className={`ns-beta-feed${tab==="reading"?" ns-library-list":""}${tab==="radar"&&view==="compact"&&!loading&&items.length?" ns-reader-list":""}`} data-view={tab==="radar"?view:undefined} aria-busy={loading} aria-label={tab==="saved"?"本浏览器收藏":tab==="reading"?"T1 顺序阅读队列":"公开新闻列表"}>
        {tab==="saved"?Object.entries(feedback.saved).reverse().map(([id,saved])=><ReaderStory className="ns-beta-card" key={id} headingLevel="h3"
          title={saved.title} meta={<>{saved.publisher} · 收藏于 {publicDate(saved.savedAt)}</>} onOpen={()=>open(id)}
          titleRef={element=>{if(element)listButtons.current.set(id,element);else listButtons.current.delete(id);}}
          actions={<ReaderButton variant="ghost" size="small" onClick={()=>{const saved={...feedback.saved};delete saved[id];update({...feedback,saved});}}>取消收藏</ReaderButton>}/>
        ):loading?<ReaderSkeleton variant={tab==="reading"?"queue":tab==="radar"&&view==="compact"?"rows":"cards"} count={tab==="reading"?5:4}/>:tab==="reading"?queued.map((item,index)=><button key={item.id} type="button" className="ns-library-item" data-public-event={item.id} aria-pressed={eventId===item.id}
          ref={element=>{if(element)listButtons.current.set(item.id,element);else listButtons.current.delete(item.id);}} onClick={event=>open(item.id,item.id,event.currentTarget)}>
          <strong>{String(index+(eventId?1:2)).padStart(2,"0")} · {readingTitle(item)}</strong>
          <span>{contentLabel(item)} · {item.primaryTopic} · {item.evidence.find(source=>source.sourceTier==="T1")?.sourceName} · {hasPublicOpened(feedback,item)?"已打开":"尚未打开"}</span>
          <span>{publicDate(item.publishedAt,item.publicationPrecision)}</span>
        </button>):displayedItems.map((item,index)=>{const material=item,target=item.id,grouped=!!item.coverage&&item.coverage.relation!=="same_named_topic";
          const title=grouped?item.coverage!.topic:readingTitle(material);
          const meta=<><span className="ns-reader-story-topic">{item.primaryTopic}</span><span>{contentLabel(material)}</span><span className="ns-article-source" title={material.evidence[0]?.sourceName}>{material.evidence[0]?.sourceName}</span><time dateTime={material.publishedAt??undefined} title={publicDate(material.publishedAt,material.publicationPrecision)}>{publicDate(material.publishedAt,material.publicationPrecision)}</time>{hasPublicOpened(feedback,material)&&!grouped&&<span className="ns-beta-opened">已打开</span>}</>;
          const bundlePreview=grouped?item.coverage!.members.filter(member=>!feedback.dismissed.includes(member.eventId)).map(member=>item.coverage!.relation==="release_family"?`${member.releaseTarget} ${member.releaseVersion}`:member.title).join(" · "):material.summary;
          if(tab==="radar"&&view==="compact")return <ReaderRow key={item.id} title={title} meta={meta} preview={bundlePreview}
            selected={eventId===item.id} data-public-event={item.id} headingLevel="h3" onOpen={grouped?undefined:click=>open(target,item.id,click.currentTarget)}
            titleRef={element=>{if(element)listButtons.current.set(item.id,element);else listButtons.current.delete(item.id);}} actions={!grouped&&actions(item)}>
            {coverage(item)}{!grouped&&<ReadingValue event={item}/>}
          </ReaderRow>;
          return <Fragment key={item.id}>{index>0&&<EditionHeading section={sectionStarts.get(item.id)?.section} id={tab==="weekly"&&sectionStarts.get(item.id)?groupAnchor(sectionStarts.get(item.id)!.key):undefined}/>}<ReaderStory className="ns-beta-card" headingLevel="h3" selected={eventId===item.id} data-public-event={item.id}
          tabIndex={grouped?-1:undefined}
          containerRef={element=>{if(grouped){if(element)listButtons.current.set(item.id,element);else listButtons.current.delete(item.id);}}}
          titleRef={element=>{if(element)listButtons.current.set(item.id,element);else listButtons.current.delete(item.id);}}
          title={title} onOpen={grouped?undefined:click=>open(target,item.id,click.currentTarget)}
          meta={<><span className="ns-beta-number">{String(index+1).padStart(2,"0")}</span>{meta}</>}
          actions={!grouped&&<>
            {target===item.id&&<ReadingValue event={item}/>} {target===item.id&&actions(item)}
          </>}
          preview={grouped
            ?<p className="ns-beta-preview">{bundlePreview}</p>
            :<div className="ns-beta-preview"><SummaryContent event={material} compact/></div>}>
          {coverage(item)}
        </ReaderStory></Fragment>;})}
        {tab==="saved"&&!Object.keys(feedback.saved).length&&<div className="ns-beta-empty"><h3>先收藏一篇值得再读的文章。</h3><p>它会留在当前浏览器，不需要登录，也不会与其他读者混在一起。</p><ReaderButton variant="primary" onClick={()=>changeTab("brief")}>浏览晨间精选</ReaderButton></div>}
        {tab!=="saved"&&!busy&&!error&&!items.length&&<div className="ns-beta-empty"><h3>{archived?"这期保存的简报没有可显示的文章。":"这个范围暂时没有文章。"}</h3><p>{archived?"可以选择其他已保存日期，或返回当前精选。":tab==="weekly"?"过去一周暂无符合条件的内容，不会用无关新闻填充。":"可以扩大时间范围或清除筛选。不会用无关新闻填充。"}</p></div>}
        {tab==="reading"&&!loading&&!!items.length&&!queueVisible.length&&<div className="ns-beta-empty"><h3>已载入的文章都打开过了。</h3><p>{queue.hasNextPage?"可以继续加载更多，或回看已打开的文章。":"可以回看已打开的文章，或换一个阅读范围。"}</p><ReaderButton onClick={()=>setRemaining(false)}>显示已打开的文章</ReaderButton></div>}
        {tab==="reading"&&queueLimited&&<p className="ns-beta-notice" role="note">本次队列已达到公开浏览上限。可按来源缩小范围，或到新闻雷达按关键词查找。</p>}
        {tab==="radar"&&feed.hasNextPage&&<ReaderButton className="ns-beta-more" disabled={feed.isFetchingNextPage} onClick={()=>void feed.fetchNextPage()}>{feed.isFetchingNextPage?"正在读取…":"加载更多"}</ReaderButton>}
        {tab==="radar"&&(feed.data?.pages.at(-1)?.nextOffset??0)>1000&&<p className="ns-beta-notice" role="note">已达到本次公开浏览上限。可按主题、关键词或时间缩小范围。</p>}
        {tab==="reading"&&queue.hasNextPage&&<ReaderButton className="ns-beta-more" disabled={queue.isFetchingNextPage||nextPending} onClick={()=>void queue.fetchNextPage()}>{queue.isFetchingNextPage?"正在读取…":"加载更多文章"}</ReaderButton>}
      </section>
      {eventId&&<div className="ns-preview-slot">{renderArticle()}</div>}
      </>}
    </div>
    {tab==="brief"&&!archived&&<ReadingInvitation onStart={()=>changeTab("reading")}/>}
    <footer className="ns-beta-footer">公开试读 · 收藏和不感兴趣只保存在本浏览器，不影响站主或其他读者。已打开不代表读完。<br/>不开放采集、模型账户与管理接口。文章版权归原发布者，摘要不替代原文。</footer>
    </div>
  </ReaderShell>;
}
