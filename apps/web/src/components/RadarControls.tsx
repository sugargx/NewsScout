import { Checkbox } from "@fluentui/react-components";
import { ArrowSyncRegular, DismissRegular, OrganizationRegular, SearchRegular, TextBulletListLtrRegular } from "@fluentui/react-icons";
import { useId } from "react";
import { ReaderButton, ReaderTabBar } from "./ReaderControls";

export const radarViews = [
  { value: "compact", label: "列表", icon: <TextBulletListLtrRegular/> },
  { value: "cards", label: "摘要卡片" },
  { value: "topics", label: "主题地图", icon: <OrganizationRegular/> },
] as const;
export type RadarView = typeof radarViews[number]["value"];
const visibleViews = radarViews.filter(option => option.value !== "cards");
export function radarView(value: string | null): RadarView {
  return value === "topics" ? value : "compact";
}
export interface RadarFilterState {
  search: string;
  topic: string;
  tier: string;
  hours: string;
  sort: string;
  includeEngineering: boolean;
}
type FilterChange = <K extends keyof RadarFilterState>(key: K, value: RadarFilterState[K]) => void;
const tierLabels: Record<string, string> = { T1: "一手来源 · T1", "T1.5": "专业作者与项目 · T1.5", T2: "媒体与其他 · T2" };
export function RadarFilterChips({filters, onChange, defaultHours="72"}: {filters: RadarFilterState; onChange: FilterChange; defaultHours?: string}) {
  const active = [
    ...(filters.search ? [{label:`搜索：${filters.search}`,clear:()=>onChange("search","")}] : []),
    ...(filters.topic ? [{label:filters.topic,clear:()=>onChange("topic","")}] : []),
    ...(filters.tier ? [{label:tierLabels[filters.tier] ?? filters.tier,clear:()=>onChange("tier","")}] : []),
    ...(filters.hours !== defaultHours ? [{label:filters.hours==="0"?"全部历史":Number(filters.hours)===24?"24 小时":`${Number(filters.hours)/24} 天`,clear:()=>onChange("hours",defaultHours)}] : []),
    ...(filters.sort !== "recommended" ? [{label:filters.sort==="newest"?"最新优先":"来源与热点分",clear:()=>onChange("sort","recommended")}] : []),
    ...(filters.includeEngineering ? [{label:"开发构建",clear:()=>onChange("includeEngineering",false)}] : []),
  ];
  return active.length ? <div className="ns-active-filters" aria-label="当前筛选">
    {active.map(filter=><button type="button" className="ns-filter-chip" key={filter.label} aria-label={`清除筛选：${filter.label}`} onClick={filter.clear}>{filter.label}<DismissRegular aria-hidden="true"/></button>)}
  </div> : null;
}

export function RadarControls({ id, filters, topics, onChange, view, onViewChange, refresh, reset, busy, savedOnly = false, shared = false, personalized = false }: {
  id: string;
  filters: RadarFilterState;
  topics: string[];
  onChange: FilterChange;
  view: RadarView;
  onViewChange: (view: RadarView) => void;
  refresh: () => void;
  reset: () => void;
  busy: boolean;
  savedOnly?: boolean;
  shared?: boolean;
  personalized?: boolean;
}) {
  const filterId = useId();
  const latest = filters.hours === "24" && filters.sort === "newest";
  const worth = filters.hours === "72" && filters.sort === "recommended";
  return <>
    {!savedOnly && <div className="ns-task-row">
      <div className="ns-segmented" role="group" aria-label="雷达浏览任务">
        <button type="button" aria-pressed={worth} title={shared && !personalized ? "近 3 天内容，按共享推荐排序" : "近 3 天内容，按价值与兴趣排序"}
          onClick={() => { onChange("hours", "72"); onChange("sort", "recommended"); }}>值得阅读</button>
        <button type="button" aria-pressed={latest} title="按来源时间，看看最近发生了什么"
          onClick={() => { onChange("hours", "24"); onChange("sort", "newest"); }}>最近 24 小时</button>
      </div>
      <div className="ns-segmented ns-view-switch">
        <ReaderTabBar id={id} label="新闻排列方式" value={view} onChange={onViewChange} options={visibleViews}/>
      </div>
    </div>}
    <div className="ns-filters" data-ui="radar-filters">
      <label className="ns-filter-search"><SearchRegular aria-hidden="true"/>
        <input aria-label="搜索事件" value={filters.search} onChange={event => onChange("search", event.currentTarget.value)} placeholder="搜索标题、摘要或主题"/></label>
      <select aria-label="主题筛选" value={filters.topic} onChange={event => onChange("topic", event.currentTarget.value)}>
        <option value="">全部主题</option>{topics.map(topic => <option key={topic} value={topic}>{topic}</option>)}
      </select>
      <select aria-label="来源筛选" value={filters.tier} onChange={event => onChange("tier", event.currentTarget.value)}>
        <option value="">全部来源</option><option value="T1">一手来源 · T1</option><option value="T1.5">专业作者与项目 · T1.5</option><option value="T2">媒体与其他 · T2</option>
      </select>
    </div>
    <div className="ns-radar-options">
      <details className="ns-advanced-filters"><summary>更多筛选 · 时间与排序</summary><div id={`${filterId}-advanced`}>
        <div className="ns-field"><label className="ns-field-label" htmlFor={`${filterId}-hours`}>时间范围</label><select id={`${filterId}-hours`} value={filters.hours} onChange={event => onChange("hours", event.currentTarget.value)}>
          <option value="24">近 24 小时</option><option value="72">近 3 天</option><option value="168">近 7 天</option><option value="720">近 30 天</option><option value="0">全部历史</option>
        </select></div>
        <div className="ns-field"><label className="ns-field-label" htmlFor={`${filterId}-sort`}>排序</label><select id={`${filterId}-sort`} value={filters.sort} onChange={event => onChange("sort", event.currentTarget.value)}>
          <option value="recommended">{shared ? personalized?"你的兴趣推荐":"共享推荐" : "为你推荐"}</option><option value="newest">来源时间 · 最新优先</option><option value="score">来源与热点分</option>
        </select></div>
        {!savedOnly && <Checkbox checked={filters.includeEngineering} label="包含开发构建" onChange={(_, data) => onChange("includeEngineering", data.checked === true)}/>}
        <p>仅浏览已收录内容，阅读顺序保持到手动应用更新。已打开不等于读完。{shared ? personalized?"兴趣主题用于本次推荐；收藏和隐藏不会用于训练。":"可用页面上方的兴趣主题调整推荐；未设置时使用共享推荐。" : ""}</p>
      </div></details>
      <div className="ns-radar-option-actions">
        <ReaderButton variant="ghost" className="ns-radar-clear" size="small" onClick={reset}>清除筛选</ReaderButton>
        <ReaderButton size="small" icon={<ArrowSyncRegular/>} disabled={busy} title="按当前兴趣重新排序已收录内容，不采集来源" onClick={refresh}>{busy ? "正在读取…" : "应用更新"}</ReaderButton>
      </div>
    </div>
  </>;
}
