import { Button, Field, Select, Spinner } from "@fluentui/react-components";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { DEFAULT_SUMMARY_MODEL, formatDate, invalidateReader, processingBlocker, summaryModel } from "../reader";
import { useStyles } from "../styles";
import type { Processing, SummaryStatus } from "../types";
import { ErrorNotice, Notice } from "./Feedback";

export function SummaryAction({ eventId, summaryStatus, processing }: { eventId: string; summaryStatus?: SummaryStatus | null; processing?: Processing }) {
  const styles = useStyles(), client = useQueryClient();
  const providers = useQuery({ queryKey: ["providers"], queryFn: api.providers });
  const runtime = useQuery({ queryKey: ["runtime"], queryFn: api.runtime });
  const [selectedModel, setSelectedModel] = useState("");
  const provider = providers.data?.items.find(item => item.provider === "github-copilot");
  const models = provider?.models ?? [];
  const model = summaryModel(provider, selectedModel);
  const isolated = processing?.blockedReason === "isolated" || processing?.blockedReason === "demo";
  const readOnly = runtime.data?.mode !== "postgres" || !!runtime.error || !processing || isolated;
  const canSelect = !readOnly && !!provider?.connected && !!provider.eligible && !!models.length && !providers.error;
  const quotaReached = !!processing && (processing.usage.used >= processing.usage.limit || processing.blockedReason === "quota");
  const running = summaryStatus === "running" || !!processing?.counts.running;
  const canGenerate = canSelect && !!model && !running && !quotaReached;
  const generate = useMutation({
    mutationFn: (selected: string) => api.summarize(eventId, selected),
    onSuccess: async data => {
      client.setQueryData(["event", eventId], data);
      await Promise.all([invalidateReader(client), ...["providers", "processing"].map(key => client.invalidateQueries({ queryKey: [key] }))]);
    },
    onError: () => { void Promise.all(["providers", "processing"].map(key => client.invalidateQueries({ queryKey: [key] }))); },
  });
  return <section className={styles.card} aria-label="生成中文摘要" aria-busy={generate.isPending}>
    <h2>按需生成中文摘要</h2>
    <p className={styles.summary}>也可手动为当前事件排队生成中文摘要。它与自动队列共用已选模型和滚动 24 小时上限，不会静默切换模型或提供方；请以原文为准。</p>
    {providers.isLoading && <Spinner size="small" label="正在读取可用模型…" />}
    {!processing && <Notice>尚未确认摘要队列与调用额度，手动生成暂不可用。</Notice>}
    {providers.error && <ErrorNotice title="无法读取模型连接状态" error={providers.error} busy={providers.isFetching} retry={() => void providers.refetch()} />}
    {runtime.error && <ErrorNotice title="无法确认运行模式，暂不可手动生成" error={runtime.error} busy={runtime.isFetching} retry={() => void runtime.refetch()} />}
    {(runtime.data?.mode === "demo" || isolated) && <Notice>{processingBlocker(isolated ? processing?.blockedReason ?? "isolated" : "demo")}</Notice>}
    {!providers.isLoading && !providers.error && !provider?.connected && <Notice>尚未连接 GitHub Copilot。<Link to="/settings">前往设置连接账户</Link>后才能生成摘要；原文摘录仍可直接阅读。</Notice>}
    {provider?.connected && (!provider.eligible || !models.length) && <Notice>{provider.message || "当前订阅不可用，或未探测到可用模型。"} <Link to="/settings">前往设置重新探测</Link></Notice>}
    {canSelect && !model && <Notice>{selectedModel ? `所选模型 ${selectedModel}` : `默认模型 ${provider?.preferredModel ?? DEFAULT_SUMMARY_MODEL}`} 当前不可用，请明确选择其他模型；不会自动替换。</Notice>}
    {running && <Notice>已有摘要正在生成，请等待完成；原文和现有摘要仍可阅读。</Notice>}
    {quotaReached && <Notice>已达到滚动 24 小时调用上限。最早额度恢复：{formatDate(processing?.usage.resetsAt)}（北京时间）。<Link to="/settings">查看用量</Link></Notice>}
    <div className={styles.toolbar}>
      <Field className={styles.field} label="摘要模型"><Select value={model} disabled={!canSelect || generate.isPending} onChange={(_, data) => setSelectedModel(data.value)}>{!model && <option value="">{models.length ? "请选择可用模型" : "暂无可用模型"}</option>}{models.map(value => <option key={value} value={value}>{value}</option>)}</Select></Field>
      <Button appearance="primary" disabled={!canGenerate || generate.isPending} onClick={() => generate.mutate(model)}>{generate.isPending ? "正在生成中文摘要…" : "生成中文摘要"}</Button>
    </div>
    {generate.isPending && <Notice>正在等待 Copilot 返回结果，现有摘录仍保留。请勿重复提交。</Notice>}
    {generate.error && <ErrorNotice title="摘要生成失败，未用演示内容替换" error={generate.error} busy={generate.isPending || !canGenerate} retry={() => generate.mutate(model)} />}
    {generate.isSuccess && <Notice>中文摘要已保存到此事件。已保存的每日简报快照不会被改写。</Notice>}
  </section>;
}
