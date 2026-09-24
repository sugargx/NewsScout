import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import { eventDates } from "../reader";
import { EventPreviewPane } from "./EventPreviewPane";
import { ErrorNotice } from "./Feedback";
import { TopicNetwork } from "./TopicNetwork";
import "../topic-explorer.css";
import { readingTitle } from "../editorial";
import { CoverageBundle } from "./CoverageBundle";
import type { CoverageMember, Event, Exploration } from "../types";
import type { PublicArticle } from "../public-reader";
import { LoadingStatus, ReaderSkeleton } from "./ReaderLoading";
import { ReaderButton } from "./ReaderButton";

type Selection = { scope: string; facet: string; eventId: string; mobileView: "map" | "results" };
type ReaderWorkspace = { selectedId: string; open: (id: string, opener?: HTMLElement | null) => void; close: () => void; select: (id: string) => void };

type TopicArticle = Pick<PublicArticle, "id" | "title" | "displayTitle" | "summary" | "summaryKind" | "summaryPoints" | "primaryTopic" | "eventType" | "publishedAt" | "publicationPrecision" | "evidence" | "coverage"> & { notInterested?: boolean };
export interface TopicDataSource<T extends TopicArticle> {
  key: string;
  maxOffset?: number;
  explore: (params: URLSearchParams, signal: AbortSignal) => Promise<Exploration>;
  events: (params: URLSearchParams, signal: AbortSignal) => Promise<{items: T[]; nextOffset: number | null}>;
}
type ReadingItem<T> = {id: string; parentId: string; preview: T | CoverageMember; coverage: Event["coverage"]};
export interface TopicReadingContext<T> {
  item: ReadingItem<T>;
  allowedIds: string[];
  index: number;
  count: number;
  hasMore: boolean;
  close: () => void;
  previous?: () => void;
  next?: () => void;
  open: (id: string, opener?: HTMLElement) => void;
}
interface TopicExplorerProps {
  hours: string; search: string; tier: string; topic: string; asOf: string;
  reader?: ReaderWorkspace;
  includeEngineering?: boolean;
  sort?: string;
}
const ownerTopics: TopicDataSource<Event> = {
  key: "",
  explore: params => api.explore(params.toString()),
  events: (params, signal) => api.events("?" + new URLSearchParams({...Object.fromEntries(params),coverage:"true"}), signal),
};
export function TopicExplorer(props: TopicExplorerProps) {
  return <TopicWorkspace {...props} dataSource={ownerTopics} renderArticle={context =>
    <EventPreviewPane eventId={context.item.id} preview={context.item.preview} onClose={context.close} closeLabel="返回主题结果" backText="返回主题结果" navigationLabel="切换匹配文章"
      relatedCoverage={context.item.coverage} allowedRelatedIds={context.allowedIds} onOpenRelated={context.open}
      onPrevious={context.previous} onNext={context.next} position={{index:context.index,count:context.count,hasMore:context.hasMore}}/>}/>;
}

export function TopicWorkspace<T extends TopicArticle>({ hours, search, tier, topic, asOf, reader, includeEngineering=false, sort="recommended", dataSource, dismissed=[], renderArticle }: TopicExplorerProps & {
  dataSource: TopicDataSource<T>;
  dismissed?: readonly string[];
  renderArticle: (context: TopicReadingContext<T>) => ReactNode;
}) {
  const id = useId();
  const scope = JSON.stringify([dataSource.key, hours, search, tier, topic, asOf, includeEngineering]);
  const [selection, setSelection] = useState<Selection>({ scope, facet: "", eventId: "", mobileView: "map" });
  const current: Selection = selection.scope === scope ? selection : { scope, facet: "", eventId: "", mobileView: "map" };
  const { facet, eventId, mobileView } = current;
  const mapHeading = useRef<HTMLHeadingElement>(null);
  const resultsHeading = useRef<HTMLHeadingElement>(null);
  const rightScroll = useRef<HTMLDivElement>(null);
  const resultButtons = useRef(new Map<string, HTMLButtonElement>());
  const lastOpened = useRef("");
  const lastOpenerWasMaterial=useRef(false);
  const previousActive = useRef("");
  const focusRequest = useRef<"map" | "results" | "return" | null>(null);
  const [expandedCoverage,setExpandedCoverage]=useState<Set<string>>(()=>new Set());

  const query = useQuery({
    queryKey: [dataSource.key ? `${dataSource.key}-explore` : "explore", hours, search, tier, topic, asOf, includeEngineering],
    queryFn: ({signal}) => dataSource.explore(new URLSearchParams({ hours, q: search, asOf, ...(topic ? { topic } : {}), ...(tier ? { tier } : {}), ...(includeEngineering ? {includeEngineering:"true"} : {}) }), signal),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const nodes = useMemo(() => [...(query.data?.nodes ?? [])]
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id)).slice(0, 12), [query.data?.nodes]);
  const edges = useMemo(() => {
    const ids = new Set(nodes.map(node => node.id));
    return (query.data?.edges ?? []).filter(edge => ids.has(edge.source) && ids.has(edge.target) && edge.source !== edge.target && edge.count > 0)
      .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
  }, [nodes, query.data?.edges]);
  const events = useInfiniteQuery({
    queryKey: [dataSource.key ? `${dataSource.key}-topic-events` : "topic-events", facet, hours, search, tier, topic, asOf, includeEngineering, sort, "coverage-v1"],
    initialPageParam: 0,
    queryFn: ({ signal, pageParam }) => dataSource.events(new URLSearchParams({
      limit: "24", offset: String(pageParam), sort, hours, q: search, ...(facet ? {facet} : {}), asOf,
      ...(topic ? { topic } : {}), ...(tier ? { tier } : {}),
      ...(includeEngineering ? {includeEngineering:"true"} : {}),
    }), signal),
    getNextPageParam: page => page.nextOffset != null && page.nextOffset <= (dataSource.maxOffset ?? Infinity) ? page.nextOffset : undefined,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const eventItems = [...new Map((events.data?.pages.flatMap(page=>page.items) ?? []).map(item=>[item.id,item])).values()]
    .map(item=>item.coverage&&dismissed.length?{...item,coverage:{...item.coverage,members:item.coverage.members.map(member=>({...member,hidden:member.hidden||dismissed.includes(member.eventId)}))}}:item)
    .filter(item=>!item.notInterested&&(item.coverage?item.coverage.members.some(member=>member.matchesFilters===true&&!member.hidden):!dismissed.includes(item.id)));
  const readingItems=[...new Map(eventItems.flatMap(event=>{
    const entries:ReadingItem<T>[]=event.coverage
      ?event.coverage.members.filter(member=>member.matchesFilters===true&&!member.hidden).map(member=>({id:member.eventId,parentId:event.id,preview:member.eventId===event.id?event:member,coverage:event.coverage}))
      :[{id:event.id,parentId:event.id,preview:event,coverage:null}];
    return entries;
  }).map(item=>[item.id,item])).values()];
  const requestedEventId = reader ? reader.selectedId : eventId;
  const activeIndex = readingItems.findIndex(event => event.id === requestedEventId);
  const activeId = activeIndex >= 0 ? requestedEventId : "";

  useEffect(() => {
    setSelection(previous => previous.scope === scope ? previous : { scope, facet: "", eventId: "", mobileView: "map" });
    lastOpened.current = "";
    setExpandedCoverage(new Set());
  }, [scope]);

  useEffect(() => {
    if (activeId !== previousActive.current && previousActive.current && !activeId) focusRequest.current ??= "return";
    const request = focusRequest.current;
    const target = request === "map" ? mapHeading.current
      : request === "return" ? (lastOpenerWasMaterial.current?rightScroll.current?.querySelector<HTMLButtonElement>(`[data-coverage-member="${CSS.escape(lastOpened.current)}"] h3 button`):null) ?? resultButtons.current.get(lastOpened.current) ?? resultsHeading.current
      : request === "results" ? resultsHeading.current : null;
    target?.focus({ preventScroll: true });
    if (target && (request === "map" || request === "results") && window.matchMedia("(max-width: 1024px)").matches)
      target.scrollIntoView({block:"start",behavior:"auto"});
    if (request === "return" && target) target.scrollIntoView({block:"nearest",behavior:"auto"});
    focusRequest.current = null;
    previousActive.current = activeId;
  }, [activeId, facet, mobileView, scope]);

  useEffect(() => {
    if (eventId && !activeId && events.data) {
      setSelection(previous => previous.scope === scope && previous.eventId === eventId ? { ...previous, eventId: "" } : previous);
    }
  }, [activeId, eventId, events.data, scope]);

  function select(nextFacet: string) {
    if (rightScroll.current) rightScroll.current.scrollTop = 0;
    focusRequest.current = "results";
    setSelection({ scope, facet: nextFacet, eventId: "", mobileView: "results" });
    if(reader?.selectedId)reader.close();
  }

  function openArticle(nextId: string, opener?: HTMLElement | null) {
    if(!activeId){lastOpened.current = nextId;lastOpenerWasMaterial.current=!!opener?.closest("[data-coverage-member]");}
    setSelection({ ...current, eventId: nextId, mobileView: "results" });
    reader?.open(nextId, opener);
  }

  function returnToResults() {
    focusRequest.current = "return";
    setSelection({ ...current, eventId: "" });
    reader?.close();
  }

  function showPane(next: Selection["mobileView"]) {
    focusRequest.current = next === "map" ? "map" : "results";
    setSelection({ ...current, mobileView: next });
  }

  if (query.isLoading) return <div className="ns-reader-loading"><LoadingStatus>正在读取主题地图…</LoadingStatus><div className="ns-topic-skeleton-layout" aria-busy="true"><ReaderSkeleton variant="map"/><ReaderSkeleton variant="queue" count={3}/></div></div>;
  if (!query.data) return query.error ? <ErrorNotice title="主题探索加载失败" error={query.error} retry={() => void query.refetch()} /> : null;

  const selectedNode = nodes.find(node => node.id === facet);
  const sortLabel = sort==="newest"?"最新优先":sort==="score"?"来源与热点分":"推荐顺序";
  return <section className={`ns-topic-workspace${activeId?" ns-topic-reading":""}`} data-mobile-view={mobileView} aria-labelledby={`${id}-title`}>
    <h2 id={`${id}-title`} className="ns-visually-hidden">主题地图</h2>
    <p id={`${id}-meaning`} className="ns-visually-hidden">连线只表示关键词在同一篇文章中共同出现，不代表语义、因果或观点关联。</p>
    {query.error && <div className="ns-topic-notice"><ErrorNotice title="主题地图暂未更新，以下为上次结果" error={query.error} retry={() => void query.refetch()} /></div>}
    {!nodes.length ? <div className="ns-empty ns-topic-empty"><h3>这个范围还没有主题</h3><p>可扩大时间范围或清除筛选；不会用其他范围的文章填充。</p></div> : <>
      <nav className="ns-topic-mobile-nav" aria-label="主题工作区视图">
        <button type="button" aria-pressed={mobileView === "map"} aria-controls={`${id}-map`} onClick={() => showPane("map")}>主题地图</button>
        <button type="button" aria-pressed={mobileView === "results"} aria-controls={`${id}-results`} onClick={() => showPane("results")}>
          {`文章 · ${readingItems.length}`}
        </button>
      </nav>
      <div className="ns-topic-layout">
        <div className="ns-topic-grid">
          <section className="ns-topic-map" id={`${id}-map`} aria-labelledby={`${id}-map-title`} aria-describedby={`${id}-meaning`}>
            <h3 id={`${id}-map-title`} className="ns-visually-hidden" ref={mapHeading} tabIndex={-1}>主题共现地图 · {nodes.length} 个主题</h3>
            <div className="ns-topic-map-scroll">
              <TopicNetwork key={scope} nodes={nodes} edges={edges} facet={facet} onSelect={select} />
            </div>
          </section>
          <aside className="ns-topic-results" id={`${id}-results`} aria-label="主题文章列表">
            <header className="ns-topic-panel-header">
              <div><span className="ns-kicker">{facet ? "Selected theme" : "All themes"}</span><h3 ref={resultsHeading} tabIndex={-1}>{facet || "全部主题"}</h3></div>
              {facet && <button type="button" className="ns-topic-button" onClick={() => select("")}>清除主题</button>}
            </header>
            <p className="ns-topic-description">
              {selectedNode ? <>当前样本收录 {selectedNode.count} 篇与这个主题相关的内容。</> : <>当前样本共 <span className="ns-topic-sample">{query.data.sampleSize}</span> 篇{query.data.nodes.length > nodes.length ? "，地图显示文章数最多的 12 个主题" : ""}。选择左侧主题可缩小范围。</>}
              连线只表示关键词在同一篇文章中共同出现。
            </p>
            <p className="ns-topic-results-status" role="status">
              {events.isLoading ? "正在加载匹配文章…" : events.error && !events.data ? "文章暂时无法加载。" : `已载入 ${eventItems.length} 组 / 单篇 · ${readingItems.length} 篇匹配材料 · ${sortLabel}`}
            </p>
            <div className="ns-topic-right-scroll" ref={rightScroll}>
              {events.isLoading && <div aria-busy="true"><ReaderSkeleton variant="queue" count={3}/></div>}
              {events.error && <ErrorNotice title="匹配文章加载失败" error={events.error} retry={() => void events.refetch()} />}
              {events.data && <ol className="ns-topic-article-list" role="group" aria-label="关联文章">
                {eventItems.map(event => {const first=readingItems.find(item=>item.parentId===event.id)!;return <li key={event.id}>
                  <button type="button" className="ns-topic-article" aria-current={activeId && readingItems.find(item=>item.id===activeId)?.parentId===event.id ? "true" : undefined}
                    ref={element => { if (element) resultButtons.current.set(first.id, element); else resultButtons.current.delete(first.id); }}
                    onClick={click => openArticle(first.id, click.currentTarget)}>
                    <strong>{readingTitle(first.preview)}</strong>
                    <span className="ns-topic-article-meta"><span>{event.primaryTopic}</span><span>{first.preview.evidence[0]?.sourceName ?? "来源未知"}</span><span>{eventDates({...first.preview,updatedAt:""}).publication}</span></span>
                  </button>
                  <CoverageBundle event={event} matchingOnly expanded={expandedCoverage.has(event.coverage?.key??"")} onExpandedChange={open=>{
                    const key=event.coverage?.key;if(!key)return;
                    setExpandedCoverage(previous=>{if(previous.has(key)===open)return previous;const next=new Set(previous);if(open)next.add(key);else next.delete(key);return next;});
                  }} onOpen={(memberId,opener)=>openArticle(memberId,opener)}/>
                </li>;})}
              </ol>}
              {!events.isLoading && !events.error && !eventItems.length && <div className="ns-topic-empty"><h4>这一批没有可阅读的文章</h4><p>已排除你标记为不感兴趣的条目。可换一个主题或调整筛选。</p></div>}
              {events.hasNextPage&&<ReaderButton className="ns-topic-load-more" disabled={events.isFetchingNextPage} onClick={()=>void events.fetchNextPage()}>{events.isFetchingNextPage?"正在读取…":"加载更多匹配文章"}</ReaderButton>}
              {(events.data?.pages.at(-1)?.nextOffset??0)>(dataSource.maxOffset??Infinity)&&<p className="ns-topic-batch-note" role="note">已达到本次公开浏览上限。可按主题、关键词或时间缩小范围。</p>}
            </div>
          </aside>
        </div>
      </div>
      {activeId && <div className="ns-topic-detail">
        {renderArticle({item:readingItems[activeIndex],allowedIds:readingItems.map(item=>item.id),
          index:activeIndex,count:readingItems.length,hasMore:events.hasNextPage,close:returnToResults,open:openArticle,
          previous:activeIndex>0?()=>openArticle(readingItems[activeIndex-1].id):undefined,
          next:activeIndex<readingItems.length-1?()=>openArticle(readingItems[activeIndex+1].id):undefined})}
      </div>}
    </>}
  </section>;
}
