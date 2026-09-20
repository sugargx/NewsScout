import { ArrowClockwiseRegular, ArrowLeftRegular, ChevronLeftRegular, ChevronRightRegular } from "@fluentui/react-icons";
import { useEffect, useState, type ReactNode, type RefObject } from "react";
import { publicDate, type PublicArticle } from "../public-reader";
import { contentLabel, readingTitle } from "../editorial";
import type { CoverageMember } from "../types";
import { ReaderButton, ReaderProgress, ReaderTabs } from "./ReaderControls";
import { LoadingStatus, ReaderSkeleton } from "./ReaderLoading";
import { SummaryContent } from "./SummaryContent";
import { ReadingValue } from "./ReadingValue";
import { hasDetailSourceContent, SourceReading } from "./SourceReading";
import { useReaderDialog } from "./useReaderDialog";

export function PublicArticlePane({ item, preview, containerRef, loading, error, refreshing, refresh, close, previous, next, nextPending, position, archived, actions, coverage }: {
  item?: PublicArticle; preview?: PublicArticle | CoverageMember; containerRef: RefObject<HTMLElement | null>;
  loading: boolean; error: Error | null; refreshing: boolean; refresh: () => void; close: () => void;
  previous?: () => void; next?: () => void; nextPending?: boolean;
  position?: {index: number; count: number; hasMore?: boolean}; archived?: boolean;
  actions?: ReactNode; coverage?: ReactNode;
}) {
  const [detailView, setDetailView] = useState<"summary" | "source">("summary");
  useEffect(() => setDetailView("summary"), [item?.id]);
  useReaderDialog(containerRef);
  const hasRichSourceContent = item ? hasDetailSourceContent(item.evidence, item.summary) : false;
  return <aside className="ns-beta-reader ns-preview" ref={containerRef} tabIndex={-1} aria-label="公开文章阅读区">
    <div className="ns-beta-reader-top"><div className="ns-reader-return">
      <ReaderButton variant="ghost" size="small" icon={<ArrowLeftRegular/>} aria-label="返回列表" onClick={close}><span className="ns-reader-back-label">返回列表</span></ReaderButton>
      {position && <ReaderProgress {...position}/>}
    </div><div className="ns-beta-reader-nav">
      <ReaderButton variant="ghost" size="small" icon={<ArrowClockwiseRegular/>} aria-label="重新读取" disabled={refreshing} onClick={refresh}><span className="ns-reader-refresh-label">重新读取</span></ReaderButton>
      <ReaderButton variant="ghost" size="small" icon={<ChevronLeftRegular/>} aria-label="上一篇" disabled={!previous || nextPending} onClick={previous}><span className="ns-reader-sequence-label">上一篇</span></ReaderButton>
      <ReaderButton variant="secondary" size="small" icon={<ChevronRightRegular/>} aria-label="下一篇" aria-busy={nextPending} disabled={!next || nextPending} onClick={next}><span className="ns-reader-sequence-label">{nextPending ? "正在寻找下一篇…" : "下一篇"}</span></ReaderButton>
    </div></div>
    {archived && <p className="ns-beta-archive-note" role="note">历史简报保留当时的标题、摘要与顺序；此处展示当前已收录的文章详情。</p>}
    {loading && !item && <section className="ns-beta-reader-loading" aria-label="正在读取详情">
      {preview && <p className="ns-beta-meta">{"primaryTopic" in preview && preview.primaryTopic} · {contentLabel(preview)} · {preview.evidence[0]?.sourceName} · {publicDate(preview.publishedAt, preview.publicationPrecision)}</p>}
      <h2 className="ns-preview-title">{preview ? readingTitle(preview) : "正在读取详情"}</h2>
      {preview?.displayTitle && preview.displayTitle !== preview.title && <p className="ns-original-title">原始标题：{preview.title}</p>}
      <LoadingStatus>{preview?.summary ? "正在读取详情，已载入的要点可先阅读…" : "正在读取文章详情…"}</LoadingStatus>
      {preview?.summary && <SummaryContent event={preview} compact/>}<ReaderSkeleton variant="detail"/>
    </section>}
    {error && <div role="alert" className="ns-beta-error">{error.message}<ReaderButton size="small" onClick={refresh}>重试</ReaderButton></div>}
    {item && <>
      <p className="ns-beta-meta">{item.primaryTopic} · {contentLabel(item)} · {item.evidence[0]?.sourceName} · {publicDate(item.publishedAt, item.publicationPrecision)}</p>
      <h2 className="ns-preview-title">{readingTitle(item)}</h2>
      {item.displayTitle && item.displayTitle !== item.title && <p className="ns-original-title">原始标题：{item.title}</p>}{actions}
      {hasRichSourceContent ? <section className="ns-beta-detail-switch">
        <ReaderTabs label="详情内容" value={detailView} onChange={setDetailView} options={[{value: "summary", label: "要点"}, {value: "source", label: "已收录原文 / 来源内容"}]}>
          {detailView === "summary" ? item.summaryKind !== "feed" ? <SummaryContent event={item}/> : <p className="ns-beta-source-note">这篇只保留了来源摘录；请在“已收录原文 / 来源内容”中查看。</p>
            : <><h3 className="ns-beta-source-title">已收录原文 / 来源内容</h3>{item.evidence.map(source => <section key={source.id} className="ns-beta-source">
              <span className="ns-beta-meta">{source.sourceTier} · {source.sourceName} · {publicDate(source.publishedAt, source.publicationPrecision)}</span>
              <SourceReading evidence={source} eventType={item.eventType}/>
            </section>)}</>}
        </ReaderTabs>
      </section> : <>
        {item.summaryKind !== "feed" && <><h3 className="ns-beta-summary-label">要点</h3><SummaryContent event={item}/></>}
        <h3 className="ns-beta-source-title">已收录原文 / 来源内容</h3>
        {item.evidence.map(source => <section key={source.id} className="ns-beta-source">
          <span className="ns-beta-meta">{source.sourceTier} · {source.sourceName} · {publicDate(source.publishedAt, source.publicationPrecision)}</span>
          <SourceReading evidence={source} eventType={item.eventType}/>
        </section>)}
      </>}
      {coverage}<ReadingValue event={item} expanded/>
    </>}
  </aside>;
}
