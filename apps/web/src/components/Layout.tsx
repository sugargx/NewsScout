import { BookmarkRegular, BookOpenRegular, CalendarRegular, HomeRegular, OptionsRegular, RadarRegular, RssRegular, SettingsRegular, ShareRegular } from "@fluentui/react-icons";
import { Outlet, useLocation } from "react-router-dom";
import { Badge } from "@fluentui/react-components";
import { Suspense } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { AccountControls, useReaderSession } from "../auth";
import { ErrorNotice, Notice } from "./Feedback";
import { FeedbackUndo } from "./FeedbackUndo";
import { QuickInterestProvider, useQuickInterests } from "./QuickInterests";
import { ReaderShell } from "./ReaderShell";
import { ReaderLoading } from "./ReaderLoading";
import { ReaderNavigation } from "./ReaderNavigation";
import "../editorial-reader.css";

const readingLinks = [
  { to: "/", label: "今日精选", icon: HomeRegular },
  { to: "/radar", label: "新闻雷达", icon: RadarRegular },
  { to: "/reading", label: "深度阅读", icon: BookOpenRegular },
  { to: "/weekly", label: "每周回顾", icon: CalendarRegular },
  { to: "/saved", label: "收藏", icon: BookmarkRegular },
];
const toolLinks = [
  { to: "/topics", label: "兴趣权重", icon: OptionsRegular },
  { to: "/sources", label: "来源采集", icon: RssRegular },
  { to: "/share", label: "今日分享", icon: ShareRegular },
  { to: "/settings", label: "设置", icon: SettingsRegular },
];

function QuickInterestButton() {
  const open = useQuickInterests();
  return <button type="button" className="ns-sidebar-quick" aria-haspopup="dialog" onClick={() => open?.()}>
    <OptionsRegular aria-hidden="true"/><span>快速调整兴趣</span>
  </button>;
}

export function Layout() {
  const { pathname } = useLocation();
  const { capabilities } = useReaderSession();
  const visibleTools = toolLinks.filter(({ to }) => to !== "/settings" || capabilities.manageReadingSettings);
  const runtime = useQuery({ queryKey: ["runtime"], queryFn: api.runtime });
  return <QuickInterestProvider><ReaderShell
    navigation={<ReaderNavigation label="主导航" items={readingLinks.map(({ to, label, icon: Icon }) => ({ key: to, href: to, label, shortLabel: label, icon: <Icon/> }))}/>}
    tools={<ReaderNavigation label="工具"
      items={visibleTools.map(({ to, label, icon: Icon }) => ({ key: to, href: to, label, shortLabel: label, icon: <Icon/> }))}/>}
    footer={<><QuickInterestButton/><AccountControls/><p className="ns-reader-local-note">兴趣与收藏已同步保存</p></>}>
    {runtime.isLoading && <div role="status" className="ns-runtime-status">正在确认运行模式…</div>}
    {runtime.error && <ErrorNotice title="无法确认运行模式，来源修改暂不可用" error={runtime.error} busy={runtime.isFetching} retry={() => void runtime.refetch()} />}
    {runtime.data?.mode === "demo" && <Notice><Badge color="warning">演示模式</Badge> 当前展示演示数据，不代表实时新闻；阅读状态与简报不保证重启后保留。来源采集和修改不可用，请启动本地 PostgreSQL 模式使用真实订阅。</Notice>}
    <Suspense fallback={<ReaderLoading heading label="正在加载阅读视图…" />}><Outlet /></Suspense><FeedbackUndo/>
  </ReaderShell></QuickInterestProvider>;
}
