import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router-dom";
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
const SharePage = lazy(() => import("./pages/SharePage").then(module => ({ default: module.SharePage })));
const ShareLibraryPage = lazy(() => import("./pages/ShareLibraryPage").then(module => ({ default: module.ShareLibraryPage })));
const PublicReader = lazy(() => import("./pages/PublicReader").then(module => ({ default: module.PublicReader })));

export function App() {
  if(document.documentElement.dataset.publicReader==="true")return <Suspense fallback={
    <ReaderShell badge="公开试读" navigation={<div className="ns-reader-nav-skeleton" aria-hidden="true">{Array.from({length:5},(_,index)=><span className="ns-skeleton-line" key={index}/>)}</div>}>
      <ReaderLoading heading label="正在加载公开阅读器…" />
    </ReaderShell>
  }><PublicReader/></Suspense>;
  return <Routes><Route element={<Layout />}><Route index element={<BriefPage />} /><Route path="radar" element={<RadarPage key="radar" />} /><Route path="events/:id" element={<EventPage />} /><Route path="topics" element={<TopicsPage />} /><Route path="sources" element={<SourcesPage />} /><Route path="saved" element={<RadarPage key="library" savedOnly />} /><Route path="settings" element={<SettingsPage />} /><Route path="reading" element={<ReadingPage/>}/><Route path="weekly" element={<WeeklyPage/>}/><Route path="share/:id" element={<SharePage/>}/><Route path="shares" element={<ShareLibraryPage/>}/></Route></Routes>;
}
