import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { api } from "./api";
import type { Brief, Event, Processing, Provider, SummaryStatus } from "./types";
import type { InfiniteData } from "@tanstack/react-query";

export const DEFAULT_SUMMARY_MODEL = "gpt-5.6-terra";

export function summaryModel(provider: (Pick<Provider, "model" | "models"> & Partial<Pick<Provider, "preferredModel">>) | undefined, selected: string): string {
  const requested = selected || provider?.model || provider?.preferredModel;
  return requested && provider?.models.includes(requested) ? requested : "";
}

export function summaryStatusLabel(status: SummaryStatus | null | undefined, nextAttemptAt?: string | null, lastError?: string | null): string {
  if (status === "running") return "生成中";
  if (status === "completed") return "已完成";
  if (status === "failed") return nextAttemptAt ? "等待重试" : "失败";
  if (status === "pending") return nextAttemptAt && lastError ? "等待重试" : "排队中";
  return "尚未生成";
}

export function aggregatedOnly(event: Partial<Pick<Event,"evidence">>): boolean {
  return !!event.evidence?.length && event.evidence.every(item=>!!item.aggregation);
}

export function summaryLabel(event: Pick<Event, "summaryKind"> & Partial<Pick<Event,"evidence">>): string {
  if(aggregatedOnly(event)) return event.summaryKind==="copilot" ? "要点 · 聚合材料" : "聚合站摘录";
  return event.summaryKind === "copilot" ? "要点" : event.summaryKind === "demo" ? "演示摘要 · 非实时新闻" : "原文摘录";
}

export function processingBlocker(reason: Processing["blockedReason"]): string {
  switch (reason) {
    case "disabled": return "自动摘要已暂停；正在生成的任务会完成，不再启动新任务。";
    case "demo": return "演示模式：不会读取本机凭据或调用真实模型。";
    case "isolated": return "隔离测试模式：不会读取本机凭据或调用真实模型。";
    case "account": return "等待连接可用的 GitHub Copilot 账户，请在设置中连接或重新探测。";
    case "model": return "所选模型当前不可用，请在设置中检查；不会静默切换模型。";
    case "quota": return "已达到滚动 24 小时调用上限；等待额度恢复，不会自动提高预算。";
    default: return "";
  }
}

export function useProcessing() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ["processing"],
    queryFn: api.processing,
    staleTime: 5_000,
    refetchInterval: query => {
      const data = query.state.data;
      return data && (data.counts.pending > 0 || data.counts.running > 0) ? 10_000 : 30_000;
    },
  });
  const data = query.data;
  const revision = data ? `${data.counts.completed}:${data.counts.pending}:${data.counts.running}:${data.counts.failed}:${data.aiCount}:${data.feedCount}` : undefined;
  const previous = useRef(revision);
  useEffect(() => {
    if (revision === undefined) return;
    const changed = previous.current !== undefined && previous.current !== revision;
    previous.current = revision;
    if (changed) void invalidateReader(client);
  }, [client, revision]);
  return query;
}

export function invalidateReader(client: QueryClient) {
  return Promise.all([
    client.invalidateQueries({queryKey:["event"],refetchType:"none"}),
    ...["events","brief","briefs","explore","topic-events","reading","weekly"].map(key =>
      client.invalidateQueries({queryKey:[key],refetchType:"none"})),
  ]);
}

export function updateReaderState(client:QueryClient,event:Event) {
  const patch=(item:Event,grouped=false)=>{
    const updated=item.id===event.id?{...item,saved:event.saved,notInterested:event.notInterested,notInterestedReason:event.notInterestedReason,
      read:event.read,later:event.later,opened:event.opened,seen:event.seen}:item;
    if(!updated.coverage?.members.some(member=>member.eventId===event.id))return updated;
    const members=updated.coverage.members.map(member=>
      member.eventId===event.id?{...member,hidden:event.notInterested}:member);
    return {...updated,notInterested:grouped&&updated.coverage.relation==="release_family"
      ?members.every(member=>member.hidden):updated.notInterested,coverage:{...updated.coverage,members}};
  };
  const patchGroup=(item:Event)=>patch(item,true);
  client.setQueryData<Event>(["event",event.id],previous=>previous?patch(previous):event);
  client.setQueriesData<Event>({queryKey:["event"]},previous=>previous?patch(previous):previous);
  for(const key of ["brief","weekly"]) {
    client.setQueriesData<Brief>({queryKey:[key]},data=>data?{...data,items:data.items.map(patchGroup)}:data);
  }
  for(const key of ["events","reading"]) {
    client.setQueriesData<InfiniteData<{items:Event[];nextOffset:number|null}>>({queryKey:[key]},data=>data?
      {...data,pages:data.pages.map(page=>({...page,items:page.items.map(patchGroup)}))}:data);
  }
  type EventPage={items:Event[];nextOffset:number|null};
  client.setQueriesData<EventPage|InfiniteData<EventPage>>({queryKey:["topic-events"]},data=>{
    if(!data)return data;
    return "pages" in data?{...data,pages:data.pages.map(page=>({...page,items:page.items.map(patchGroup)}))}
      :{...data,items:data.items.map(patchGroup)};
  });
}

export function invalidateIngestion(client: QueryClient) {
  return Promise.all([invalidateReader(client), ...["sources", "source-coverage", "processing", "reader-status"].map(key => client.invalidateQueries({ queryKey: [key] }))]);
}

export function httpsUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !!url.hostname && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "尚无记录";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
}

export function formatPublicationDate(value: string | null | undefined, precision?: "day" | "time" | null): string {
  if (!value) return "发布时间未提供";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return precision === "day"
    ? date.toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" })
    : date.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
}

export function eventDates(event: Pick<Event, "publishedAt" | "publicationPrecision" | "collectedAt" | "updatedAt">): { publication: string; collection?: string } {
  if (event.publishedAt) return { publication: `发布 / 更新 ${formatPublicationDate(event.publishedAt, event.publicationPrecision)}`, ...(event.collectedAt ? { collection: `采集 / 收录 ${formatDate(event.collectedAt)}` } : {}) };
  return { publication: event.publishedAt === undefined && event.updatedAt ? `历史记录时间 ${formatDate(event.updatedAt)}` : "来源未提供发布 / 更新时间", ...(event.collectedAt ? { collection: `采集 / 收录 ${formatDate(event.collectedAt)}` } : {}) };
}
