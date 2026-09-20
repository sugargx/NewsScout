import { BookOpenRegular, CalendarRegular, bundleIcon, DatabaseFilled, DatabaseRegular, HomeFilled, HomeRegular, NewsFilled, NewsRegular, RadarFilled, RadarRegular, SettingsFilled, SettingsRegular, StarFilled, StarRegular } from "@fluentui/react-icons";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useStyles } from "../styles";
import { Badge, mergeClasses } from "@fluentui/react-components";
import { Suspense } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { ErrorNotice, Notice } from "./Feedback";
import { FeedbackUndo } from "./FeedbackUndo";
import { ReaderShell } from "./ReaderShell";
import { ReaderLoading } from "./ReaderLoading";
import { ReaderNavigation } from "./ReaderNavigation";
import "../editorial-reader.css";

const Home = bundleIcon(HomeFilled, HomeRegular), Radar = bundleIcon(RadarFilled, RadarRegular), Sources = bundleIcon(DatabaseFilled, DatabaseRegular), Star = bundleIcon(StarFilled, StarRegular), Settings = bundleIcon(SettingsFilled, SettingsRegular), News = bundleIcon(NewsFilled, NewsRegular);
const readingLinks = [
  {to:"/", label:"晨间简报", shortLabel:"精选", icon:Home},
  {to:"/radar",label:"新闻雷达",shortLabel:"雷达",icon:Radar},
  {to:"/reading",label:"深度阅读",shortLabel:"深读",icon:BookOpenRegular},
  {to:"/weekly",label:"每周回顾",shortLabel:"回顾",icon:CalendarRegular},
  {to:"/saved",label:"阅读清单",shortLabel:"收藏",icon:Star},
];
const managementLinks = [{to:"/shares",label:"分享工作台",icon:News},{to:"/topics",label:"兴趣主题",icon:News}, {to:"/sources",label:"来源与采集",icon:Sources}, {to:"/settings",label:"设置",icon:Settings}];

export function Layout() {
  const styles = useStyles();
  const {pathname}=useLocation();
  const runtime = useQuery({ queryKey: ["runtime"], queryFn: api.runtime });
  return <ReaderShell navigation={
      <><ReaderNavigation label="主导航" items={readingLinks.map(({to,label,shortLabel,icon:Icon}) => ({key:to,href:to,label,shortLabel,icon:<Icon/>}))}/>
        <details className="ns-owner-management" onKeyDown={event=>{if(event.key==="Escape"&&event.currentTarget.open){event.preventDefault();event.currentTarget.open=false;event.currentTarget.querySelector("summary")?.focus();}}}>
          <summary aria-label="管理与分享" title="管理与分享"><Settings/><span className="ns-owner-management-label">管理与分享</span></summary>
          <nav aria-label="管理导航" className={styles.nav}>{managementLinks.map(({to,label,icon:Icon}) => <NavLink key={to} to={to}
            onClick={event=>{const menu=event.currentTarget.closest("details");if(menu)menu.open=false;}}
            className={({isActive}) => mergeClasses(styles.navLink, (isActive || to==="/shares"&&pathname.startsWith("/share/")) && styles.navActive)}><Icon />{label}</NavLink>)}</nav>
        </details></>
    }>
      {runtime.isLoading && <div role="status">正在确认运行模式…</div>}
      {runtime.error && <ErrorNotice title="无法确认运行模式，来源修改暂不可用" error={runtime.error} busy={runtime.isFetching} retry={() => void runtime.refetch()} />}
      {runtime.data?.mode === "demo" && <Notice><Badge color="warning">演示模式</Badge> 当前展示演示数据，不代表实时新闻；阅读状态与简报不保证重启后保留。来源采集和修改不可用，请启动本地 PostgreSQL 模式使用真实订阅。</Notice>}
      <Suspense fallback={<ReaderLoading heading label="正在加载阅读视图…" />}><Outlet /></Suspense><FeedbackUndo/>
  </ReaderShell>;
}
