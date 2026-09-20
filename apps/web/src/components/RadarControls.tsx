import { Checkbox, Field, Input, Select } from "@fluentui/react-components";
import { SearchRegular } from "@fluentui/react-icons";
import { useId } from "react";
import { ReaderButton, ReaderTabBar } from "./ReaderControls";

export const radarViews = [
  { value: "compact", label: "紧凑列表" },
  { value: "cards", label: "摘要卡片" },
  { value: "topics", label: "主题关联" },
] as const;
export type RadarView = typeof radarViews[number]["value"];
export function radarView(value: string | null): RadarView {
  return value === "cards" || value === "topics" ? value : "compact";
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
export function RadarFilterChips({filters, onChange, reset, defaultHours="72"}: {filters: RadarFilterState; onChange: FilterChange; reset: () => void; defaultHours?: string}) {
  const active = [
    ...(filters.search ? [{label:`搜索：${filters.search}`,clear:()=>onChange("search","")}] : []),
    ...(filters.topic ? [{label:filters.topic,clear:()=>onChange("topic","")}] : []),
    ...(filters.tier ? [{label:filters.tier,clear:()=>onChange("tier","")}] : []),
    ...(filters.hours !== defaultHours ? [{label:filters.hours==="0"?"全部历史":`${Number(filters.hours)/24} 天`,clear:()=>onChange("hours",defaultHours)}] : []),
    ...(filters.sort !== "recommended" ? [{label:filters.sort==="newest"?"最新优先":"来源与热点分",clear:()=>onChange("sort","recommended")}] : []),
    ...(filters.includeEngineering ? [{label:"开发构建",clear:()=>onChange("includeEngineering",false)}] : []),
  ];
  return active.length ? <div className="ns-active-filters" aria-label="当前筛选">
    {active.map(filter=><ReaderButton size="small" key={filter.label} aria-label={`清除筛选：${filter.label}`} onClick={filter.clear}>{filter.label} ×</ReaderButton>)}
    <ReaderButton size="small" variant="ghost" onClick={reset}>清除筛选</ReaderButton>
  </div> : null;
}

export function RadarControls({ id, filters, topics, onChange, view, onViewChange, refresh, busy, savedOnly = false, shared = false, personalized = false }: {
  id: string;
  filters: RadarFilterState;
  topics: string[];
  onChange: FilterChange;
  view: RadarView;
  onViewChange: (view: RadarView) => void;
  refresh: () => void;
  busy: boolean;
  savedOnly?: boolean;
  shared?: boolean;
  personalized?: boolean;
}) {
  const filterId = useId();
  return <>
    <div className="ns-radar-primary" data-ui="radar-filters">
      <Input className="ns-radar-search" aria-label="搜索事件" value={filters.search} onChange={(_, data) => onChange("search", data.value)}
        contentBefore={<SearchRegular/>} placeholder="搜索标题、摘要或主题"/>
      <Select aria-label="主题筛选" value={filters.topic} onChange={(_, data) => onChange("topic", data.value)}>
        <option value="">全部主题</option>{topics.map(topic => <option key={topic} value={topic}>{topic}</option>)}
      </Select>
      <Select aria-label="时间范围" value={filters.hours} onChange={(_, data) => onChange("hours", data.value)}>
        <option value="24">近24小时</option><option value="72">近3天</option><option value="168">近7天</option><option value="720">近30天</option><option value="0">全部历史</option>
      </Select>
    </div>
    <details className="ns-advanced-filters"><summary>更多筛选 · 来源等级 / T1 / 排序</summary><div id={`${filterId}-advanced`}>
      <Field label="来源等级"><Select value={filters.tier} onChange={(_, data) => onChange("tier", data.value)}>
        <option value="">全部等级</option><option value="T1">T1 · 一手发布者</option><option value="T1.5">T1.5 · 专业作者 / 项目</option><option value="T2">T2 · 媒体与其他</option>
      </Select></Field>
      <Field label="排序"><Select value={filters.sort} onChange={(_, data) => onChange("sort", data.value)}>
        <option value="recommended">{shared ? personalized?"你的兴趣推荐":"共享推荐" : "为你推荐"}</option><option value="newest">来源时间 · 最新优先</option><option value="score">来源与热点分</option>
      </Select></Field>
      {!savedOnly && <Checkbox checked={filters.includeEngineering} label="包含开发构建" onChange={(_, data) => onChange("includeEngineering", data.checked === true)}/>}
      <p>仅浏览已收录内容，阅读顺序保持到手动应用更新。已打开不等于读完。{shared ? personalized?"兴趣主题用于本次推荐；收藏和隐藏不会用于训练。":"可用页面上方的兴趣主题调整推荐；未设置时使用共享推荐。" : ""}</p>
    </div></details>
    <div className="ns-radar-viewbar">
      <ReaderTabBar id={id} label="新闻排列方式" value={view} onChange={onViewChange} options={savedOnly ? radarViews.filter(option => option.value !== "topics") : radarViews}/>
      <ReaderButton size="small" disabled={busy} title="更新已有内容的排序，不采集来源" onClick={refresh}>应用更新</ReaderButton>
    </div>
  </>;
}
