import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AuthBoundary, PrivacyPage, SettingsAccess } from "./auth";
import { Layout } from "./components/Layout";
import { ReaderShell } from "./components/ReaderShell";
import { ReaderLoading } from "./components/ReaderLoading";

const BriefPage = lazy(() => import("./pages/BriefPage").then(module => ({ default: module.BriefPage })));
const EventPage = lazy(() => import("./pages/EventPage").then(module => ({ default: module.EventPage })));
const RadarPage = lazy(() => import("./pages/RadarPage").then(module => ({ default: module.RadarPage })));
const SettingsPage = lazy(() => import("./pages/SettingsPage").then(module => ({ default: module.SettingsPage })));
const SourcesPage = lazy(() => import("./pages/SourcesPage").then(module => ({ default: module.SourcesPage })));
const TopicsPage = lazy(() => import("./pages/TopicsPage").then(module => ({ default: module.TopicsPage })));
const ReadingPage = lazy(() => import("./pages/ReadingPage").then(module => ({ default: module.ReadingPage })));
const WeeklyPage = lazy(() => import("./pages/WeeklyPage").then(module => ({ default: module.WeeklyPage })));
const DailySharePage = lazy(() => import("./pages/DailySharePage").then(module => ({ default: module.DailySharePage })));
const PublicReader = lazy(() => import("./pages/PublicReader").then(module => ({ default: module.PublicReader })));
const PublishedSharePage = lazy(() => import("./pages/PublishedSharePage").then(module => ({ default: module.PublishedSharePage })));
const NotFoundPage = lazy(() => import("./pages/NotFoundPage").then(module => ({ default: module.NotFoundPage })));

export function App() {
  const { pathname } = useLocation();
  if (pathname === "/privacy") return <PrivacyPage />;
  if (pathname.startsWith("/p/")) return <Suspense fallback={<ReaderLoading heading label="正在读取分享内容…" />}><Routes><Route path="/p/:id" element={<PublishedSharePage />} /></Routes></Suspense>;
  if(document.documentElement.dataset.publicReader==="true")return <Suspense fallback={
    <ReaderShell badge="公开试读" navigationReady={false} navigation={<div className="ns-reader-nav-skeleton" aria-hidden="true">{Array.from({length:5},(_,index)=><span className="ns-skeleton-line" key={index}/>)}</div>}>
      <ReaderLoading heading label="正在加载公开阅读器…" />
    </ReaderShell>
  }><PublicReader/></Suspense>;
  return <AuthBoundary><Routes><Route element={<Layout />}><Route index element={<BriefPage />} /><Route path="radar" element={<RadarPage key="radar" />} /><Route path="events/:id" element={<EventPage />} /><Route path="topics" element={<TopicsPage />} /><Route path="sources" element={<SourcesPage />} /><Route path="saved" element={<RadarPage key="library" savedOnly />} /><Route path="settings" element={<SettingsAccess><SettingsPage /></SettingsAccess>} /><Route path="reading" element={<ReadingPage/>}/><Route path="weekly" element={<WeeklyPage/>}/><Route path="share" element={<DailySharePage/>}/><Route path="share/:id" element={<Navigate to="/share" replace/>}/><Route path="shares" element={<Navigate to="/share" replace/>}/><Route path="*" element={<NotFoundPage/>}/></Route></Routes></AuthBoundary>;
}
