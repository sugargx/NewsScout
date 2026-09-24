import { ShareRegular } from "@fluentui/react-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useReaderSession } from "../auth";
import { DailyShare } from "../components/DailyShare";
import { EmptyState } from "../components/EmptyState";
import { ErrorNotice } from "../components/Feedback";
import { MetaParts } from "../components/MetaParts";
import { PageHeader } from "../components/PageHeader";
import { ReaderButton } from "../components/ReaderControls";
import { ReaderLoading } from "../components/ReaderLoading";
import { beijingDate, editionDateLabel, editionRefetchInterval } from "../editorial";
import type { Brief } from "../types";

// The Beijing calendar date, updated at midnight so a page left open never keeps calling yesterday "今日".
function useBeijingDate() {
  const [today, setToday] = useState(() => beijingDate());
  useEffect(() => {
    const day = 86_400_000, offset = 8 * 3_600_000, now = Date.now();
    const timer = setTimeout(() => setToday(beijingDate()), Math.floor((now + offset) / day) * day + day - offset - now + 1_000);
    return () => clearTimeout(timer);
  }, [today]);
  return today;
}

export function DailySharePage() {
  const { telemetryConsent } = useReaderSession();
  const today = useBeijingDate();
  const query = useQuery({ queryKey: ["brief", "latest"], queryFn: () => api.brief("latest"), staleTime: Infinity,
    refetchOnWindowFocus: false, refetchOnReconnect: false, refetchOnMount: false, refetchInterval: current => editionRefetchInterval(current.state.data) });
  // Hold the edition the reader is picking from; a newly saved edition is offered, never swapped in under their picks.
  const [held, setHeld] = useState<Brief | null>(null), [switched, setSwitched] = useState(false);
  useEffect(() => { if (query.data && !held) setHeld(query.data); }, [query.data, held]);
  const data = held ?? query.data, latest = query.data;
  const newer = latest && held && latest !== held && latest.isSnapshot
    && (!held.isSnapshot || latest.localDate !== held.localDate || latest.generatedAt !== held.generatedAt) ? latest : null;
  // The image and text only say "今日" for today's current edition; a held or earlier one is named by its date.
  const day = data && !data.refreshPending && !newer && data.localDate === today ? "今日" : data ? editionDateLabel(data.localDate) : "今日";
  const items = useMemo(() => data?.items.filter(item => !item.notInterested) ?? [], [data]);
  const earlier = useMemo(() => {
    const ids = new Set(data?.sections?.filter(section => section.kind === "catch_up").flatMap(section => section.eventIds) ?? []);
    return items.filter(item => ids.has(item.id)).length;
  }, [data, items]);
  const report = (outcome: "success" | "failure", durationMs: number) => {
    if (telemetryConsent) void api.telemetry([{ name: "action", page: "share", outcome, durationMs: Math.round(durationMs) }]).catch(() => undefined);
  };
  return <div className="ns-editorial-page ns-daily-share-page">
    <PageHeader eyebrow="Share today" title="今日分享" subtitle="把今天值得转发的新闻整理成一张长图：每条几句话概述，紧跟原文链接。"/>
    {data?.localDate && <p className="ns-batch-meta ns-share-edition"><MetaParts parts={[
      `来自 ${editionDateLabel(data.localDate)}版今日精选`, `共 ${items.length} 条可选${earlier ? `（其中 ${earlier} 条为补读）` : ""}`,
      ...(data.refreshPending && data.isSnapshot && !newer ? ["今日版正在生成，当前为上一期"] : []),
    ]}/></p>}
    {newer && <p className="ns-refresh-outcome ns-share-newer" role="status">{held?.isSnapshot ? `今日精选已更新为 ${editionDateLabel(newer.localDate)}版。` : `${editionDateLabel(newer.localDate)}版今日精选已生成。`}
      <button type="button" className="ns-share-switch" onClick={() => { setSwitched(true); setHeld(newer); }}>换成新版</button></p>}
    {data && !data.isSnapshot && !newer && <p className="ns-refresh-outcome" role="note">今日版尚未生成，当前按最新内容预览；正式版生成后可以在这里切换。</p>}
    {query.error && <ErrorNotice title="今日精选读取失败" error={query.error} retry={() => void query.refetch()}/>}
    {query.isLoading && <ReaderLoading label="正在读取今日精选…" variant="rows" count={4}/>}
    {data && (items.length ? <DailyShare key={`${data.localDate}:${data.generatedAt}`} date={data.localDate} day={day} items={items} sections={data.sections} onAction={report} focusOnMount={switched}/>
      : <EmptyState icon={<ShareRegular/>} title="今天还没有可分享的精选" actions={<Link className="ns-button-link" to="/">返回今日精选</Link>}>
        今日精选生成后，就可以一键下载分享图。</EmptyState>)}
    <PublishedLinks/>
  </div>;
}

function PublishedLinks() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["share-links"], queryFn: api.shareLinks, staleTime: 60_000 });
  const [confirming, setConfirming] = useState("");
  const revoke = useMutation({ mutationFn: api.revokeShare, onSuccess: async () => {
    setConfirming(""); await client.invalidateQueries({ queryKey: ["share-links"] });
  } });
  const links = query.data?.items.filter(item => item.published && !item.revoked) ?? [];
  if (!links.length) return null;
  return <details className="ns-share-legacy">
    <summary>已公开的分享链接（旧版）· {links.length} 条</summary>
    <p>旧版分享链接仍可访问。新的分享图只在本机生成，不会创建公开链接。</p>
    {revoke.error && <ErrorNotice title="撤回未完成" error={revoke.error}/>}
    <ul>{links.map(link => <li key={link.id}>
      <span>{link.title}<small>{link.date}</small></span>
      <a className="ns-button-link" href={`/p/${encodeURIComponent(link.id)}`} target="_blank" rel="noopener noreferrer">打开 ↗</a>
      {confirming === link.id
        ? <><ReaderButton size="small" variant="danger" disabled={revoke.isPending} onClick={() => revoke.mutate(link.id)}>{revoke.isPending ? "正在撤回…" : "确认撤回"}</ReaderButton>
          <ReaderButton size="small" disabled={revoke.isPending} onClick={() => setConfirming("")}>取消</ReaderButton></>
        : <ReaderButton size="small" onClick={() => { revoke.reset(); setConfirming(link.id); }}>撤回链接</ReaderButton>}
    </li>)}</ul>
  </details>;
}
