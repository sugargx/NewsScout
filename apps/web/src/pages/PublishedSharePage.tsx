import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { api, ApiError } from "../api";
import { httpsUrl } from "../reader";
import { ErrorNotice } from "../components/Feedback";
import { ReaderLoading } from "../components/ReaderLoading";
import "../published-share.css";

export function PublishedSharePage() {
  const { id = "" } = useParams();
  const query = useQuery({
    queryKey: ["published-share", id],
    queryFn: () => api.publicShare(id),
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
  return <main className="ns-published-share">
    <header><Link to="/">NewsScout</Link><span>公开分享</span></header>
    {query.isPending && <ReaderLoading heading label="正在读取分享内容…" />}
    {query.error && (query.error instanceof ApiError && [403, 404, 410].includes(query.error.status)
      ? <section><h1>这份分享暂不可访问</h1><p>链接可能已被撤回，或尚未公开发布。</p><Link to="/">进入 NewsScout</Link></section>
      : <ErrorNotice title="分享内容读取失败" error={query.error} retry={() => void query.refetch()} />)}
    {!query.error && query.data && <>
      <div className="ns-published-intro"><p>{query.data.date} · {query.data.items.length} 篇选文</p><h1>{query.data.title}</h1><p>发布者确认公开的阅读摘选。摘要与编辑内容不替代原文，请结合来源判断。</p></div>
      {query.data.items.map((item, index) => <article key={index}>
        <h2>{item.title}</h2><p className="ns-published-summary">{item.summary}</p>
        <div className="ns-published-sources">{item.sources.map((source, sourceIndex) => {
          const url = httpsUrl(source.url);
          return url ? <a key={sourceIndex} href={url} target="_blank" rel="noopener noreferrer">{source.name} ↗</a> : <span key={sourceIndex}>{source.name}</span>;
        })}</div>
      </article>)}
      <footer><p>{query.data.note}</p><Link to="/">进入 NewsScout，建立自己的阅读空间</Link></footer>
    </>}
  </main>;
}
