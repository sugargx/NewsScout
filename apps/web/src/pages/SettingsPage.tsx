import { Badge, Button, Checkbox, Field, Select, Spinner } from "@fluentui/react-components";
import { ArrowSyncRegular, PlugConnectedRegular } from "@fluentui/react-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api } from "../api";
import { ErrorNotice, Notice } from "../components/Feedback";
import { PageHeader } from "../components/PageHeader";
import { ProcessingSettings } from "../components/ProcessingSettings";
import { formatDate, useProcessing } from "../reader";
import { useStyles } from "../styles";
import type { ReaderSettings, ReaderStatus } from "../types";

function ReadingSchedule({ disabled }: { disabled: boolean }) {
  const styles = useStyles(), client = useQueryClient();
  const status = useQuery({ queryKey: ["reader-status"], queryFn: api.readerStatus, refetchInterval: 30_000 });
  const [draft, setDraft] = useState<ReaderSettings | null>(null);
  const saved = status.data?.settings;
  const form = draft ?? saved;
  const save = useMutation({
    mutationFn: api.saveReaderSettings,
    onSuccess: async savedSettings => {
      client.setQueryData<ReaderStatus>(["reader-status"], current => current ? { ...current, settings: savedSettings } : current);
      setDraft(null);
      await client.invalidateQueries({ queryKey: ["reader-status"] });
    },
  });
  if (status.isLoading) return <Spinner label="正在读取晨间采集设置…" />;
  if (!form) return status.error ? <ErrorNotice title="晨间采集设置读取失败" error={status.error} busy={status.isFetching} retry={() => void status.refetch()} /> : null;
  const readerSettings = form;
  const dirty = !saved || readerSettings.mode !== saved.mode || readerSettings.hour !== saved.hour || readerSettings.includeObserving!==saved.includeObserving || readerSettings.briefLimit!==saved.briefLimit;
  function submit(event: FormEvent) { event.preventDefault(); if (!disabled && dirty && !save.isPending) save.mutate(readerSettings); }
  return <section className={styles.card}><h2>晨间阅读节奏</h2><p className={styles.summary}>固定使用上海时区。每日模式会在设定时点进行一次晨间采集；按来源间隔模式保留每个来源的采集频率。手动刷新来源始终可用。</p>
    <p className={styles.muted}>需保持电脑和应用运行，错过时点会在恢复后补采。今天时点已过才首次启用或修改日程，首轮从明天开始。</p>
    {status.error && <ErrorNotice title="采集日程暂未更新，以下为上次读取的状态" error={status.error} busy={status.isFetching} retry={() => void status.refetch()} />}
    <form onSubmit={submit} className={styles.compactToolbar} aria-busy={save.isPending}>
      <Field label="采集方式"><Select value={readerSettings.mode} disabled={disabled || save.isPending} onChange={(_, data) => { if (data.value === "daily" || data.value === "interval") setDraft({ ...readerSettings, mode: data.value }); }}><option value="daily">每日晨间采集</option><option value="interval">按来源间隔采集</option></Select></Field>
      {readerSettings.mode === "daily" && <Field label="每日时间（上海）"><Select value={String(readerSettings.hour)} disabled={disabled || save.isPending} onChange={(_, data) => setDraft({ ...readerSettings, hour: Number(data.value) })}>{Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{String(hour).padStart(2, "0")}:00</option>)}</Select></Field>}
      <Field label="精选条数上限"><Select value={String(readerSettings.briefLimit)} disabled={disabled||save.isPending} onChange={(_,data)=>setDraft({...readerSettings,briefLimit:Number(data.value)})}>{[5,10,15,20,25,30].map(value=><option key={value} value={value}>{value}条</option>)}</Select></Field>
      <Checkbox label="包含健康的观察来源（明确标识，非已确认信源）" checked={readerSettings.includeObserving} disabled={disabled||save.isPending} onChange={(_,data)=>setDraft({...readerSettings,includeObserving:data.checked===true})} />
      <Button type="submit" appearance="primary" disabled={disabled || !dirty || save.isPending}>{save.isPending ? "正在保存…" : "保存晨间设置"}</Button>
      {draft && <Button type="button" disabled={save.isPending} onClick={() => setDraft(null)}>放弃修改</Button>}
    </form>
    <p className={styles.muted}>下次计划：{status.data?.nextCollectionAt ? formatDate(status.data.nextCollectionAt) : "按来源间隔或尚未排定"} · 上次成功采集：{formatDate(status.data?.lastCollectionAt)} · 最新来源时间：{formatDate(status.data?.latestPublishedAt)}</p>
    {status.data?.morningRun && <p className={styles.muted}>本日运行：{{ collecting: "采集中", summarizing: "准备摘要", ready: "已就绪", partial: "部分就绪", failed: "失败" }[status.data.morningRun.status]} · 成功来源 {status.data.morningRun.sourceSucceeded} · 失败来源 {status.data.morningRun.sourceFailed}<br />计划 {formatDate(status.data.morningRun.scheduledAt)} · 实际开始 {formatDate(status.data.morningRun.startedAt)}{status.data.morningRun.message ? ` · ${status.data.morningRun.message}` : ""}</p>}
    {save.error && <ErrorNotice title="晨间设置保存失败" error={save.error} busy={save.isPending} retry={() => save.mutate(readerSettings)} />}
  </section>;
}

export function SettingsPage() {
  const styles = useStyles(), client = useQueryClient();
  const query = useQuery({ queryKey: ["providers"], queryFn: api.providers });
  const runtime = useQuery({ queryKey: ["runtime"], queryFn: api.runtime });
  const processing = useProcessing();
  const invalidate = () => Promise.all(["providers", "processing"].map(key => client.invalidateQueries({ queryKey: [key] })));
  const connectLocal = useMutation({ mutationFn: api.connectLocalCopilot, onSettled: invalidate });
  const refresh = useMutation({ mutationFn: api.probeCopilot, onSettled: invalidate });
  const disconnect = useMutation({ mutationFn: api.disconnectCopilot, onSettled: invalidate });
  const busy = connectLocal.isPending || refresh.isPending || disconnect.isPending;
  const canConnect = runtime.data?.mode === "postgres" && !runtime.error && !!processing.data && processing.data.blockedReason !== "isolated" && processing.data.blockedReason !== "demo";
  return <>
    <PageHeader eyebrow="Settings" title="阅读与模型设置" subtitle="阅读原文不需要模型账户。晨间采集和摘要队列各自可见；模型仍精确使用已选择的 GitHub Copilot 配置，不会静默回退。" />
    {query.error && <ErrorNotice title="模型账户读取失败" error={query.error} busy={query.isFetching} retry={() => void query.refetch()} />}
    {runtime.error && <ErrorNotice title="运行环境读取失败" error={runtime.error} busy={runtime.isFetching} retry={() => void runtime.refetch()} />}
    {runtime.data?.mode === "demo" && <Notice>演示模式不会访问本机账户或生成真实摘要。</Notice>}
    {connectLocal.error && <ErrorNotice title="本机账户连接失败" error={connectLocal.error} busy={busy || !canConnect} retry={() => connectLocal.mutate()} />}
    {refresh.error && <ErrorNotice title="Copilot 能力探测失败" error={refresh.error} busy={busy || !canConnect} retry={() => refresh.mutate()} />}
    {disconnect.error && <ErrorNotice title="断开 Copilot 失败" error={disconnect.error} busy={busy || !canConnect} retry={() => disconnect.mutate()} />}
    {refresh.isSuccess && <Notice>能力探测已完成，请查看下方最新状态与可用模型。</Notice>}
    {connectLocal.isSuccess && <Notice>已接入本机登录账户。开启的自动摘要会在模型与额度可用时继续处理队列并消耗此账户用量；也可在事件详情手动生成。</Notice>}
    {disconnect.isSuccess && <Notice>ScoutNews 已断开并记住此选择，仍可阅读原文。本机 GitHub/Copilot 登录未退出。</Notice>}
    <div className={styles.grid}>
      <ReadingSchedule disabled={runtime.data?.mode !== "postgres" || !!runtime.error} />
      {processing.error && <ErrorNotice title="自动摘要状态读取失败" error={processing.error} busy={processing.isFetching} retry={() => void processing.refetch()} />}
      {processing.isLoading && <Spinner label="正在读取摘要用量与队列…" />}
      {processing.data && <ProcessingSettings data={processing.data} provider={query.data?.items.find(item => item.provider === "github-copilot")} disabled={!canConnect || busy} />}
    {query.isLoading ? <Spinner label="正在读取模型与账户…" /> : <>
      {query.data?.items.map(provider => {
        const copilot = provider.provider === "github-copilot";
        return <section className={styles.card} key={provider.provider}>
          <div className={styles.cardTop}><div><h2>{copilot ? "GitHub Copilot" : provider.provider === "azure-openai" ? "Azure OpenAI" : provider.provider}</h2><p className={styles.summary}>{copilot ? provider.message : "此版本尚不支持调用此提供方。即使服务端检测到配置，也不表示能够生成摘要。"}</p></div><Badge color={!copilot ? "informative" : provider.connected && provider.eligible ? "success" : "warning"}>{!copilot ? "暂不支持" : provider.connected ? provider.eligible ? "已连接 · 可用" : "已连接 · 不可用" : "未连接"}</Badge></div>
          {copilot && <>
            <p>最近验证：{formatDate(provider.verifiedAt)}</p>
            <p>登录方式：{provider.authMode === "local" ? "本机 GitHub/Copilot 登录" : provider.authMode === "oauth" ? "OAuth App 授权" : "尚未连接"}{provider.accountLogin ? ` · ${provider.accountLogin}` : ""}</p>
            <p>默认模型：{provider.preferredModel}{provider.connected && !provider.model ? "（当前账户不可用，不会自动替换）" : ""}</p>
            <p>可用模型：{provider.models?.length ? provider.models.join(" · ") : "暂无，请连接账户或重新探测"}</p>
            <div className={styles.buttonGroup}>
              {(!provider.connected || provider.authMode !== "local") && <Button appearance="primary" icon={<PlugConnectedRegular />} disabled={busy || !canConnect} onClick={() => { refresh.reset(); disconnect.reset(); connectLocal.mutate(); }}>{connectLocal.isPending ? "正在连接…" : "连接本机 GitHub/Copilot"}</Button>}
              <Button icon={<ArrowSyncRegular />} disabled={busy || !canConnect || !provider.authMode} onClick={() => { connectLocal.reset(); disconnect.reset(); refresh.mutate(); }}>{refresh.isPending ? "正在探测…" : "重新探测"}</Button>
              {provider.authMode && <Button appearance="secondary" disabled={busy || !canConnect} onClick={() => { connectLocal.reset(); refresh.reset(); disconnect.mutate(); }}>{disconnect.isPending ? "正在断开…" : "断开"}</Button>}
              {provider.oauthConfigured && <Button disabled={busy || !canConnect} onClick={() => { location.href = "/api/v1/auth/github/start"; }}>改用 OAuth App 授权</Button>}
            </div>
            <p className={styles.summary}>直接复用本机登录，无需复制 token 或配置 OAuth App。更换本机账号后请重新探测；断开只影响 ScoutNews，不退出全局登录。</p>
          </>}
        </section>;
      })}
      {query.data && !query.data.items.some(provider => provider.provider === "azure-openai") && <section className={styles.card}><h2>Azure OpenAI</h2><Badge appearance="outline">暂不支持</Badge><p>当前版本不提供 Azure 调用或浏览器密钥配置，也不会自动回退到 Azure。</p></section>}
      {query.data?.items.length === 0 && <Notice>服务端没有返回可用的模型提供方。请检查本地 API 配置后重新读取。</Notice>}
    </>}
    </div>
  </>;
}
