import { ArrowSyncRegular, PlugConnectedRegular } from "@fluentui/react-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api } from "../api";
import { ErrorNotice, Notice } from "../components/Feedback";
import { FormField, Toggle } from "../components/FormControls";
import { PageHeader } from "../components/PageHeader";
import { ProcessingSettings } from "../components/ProcessingSettings";
import { ReaderButton } from "../components/ReaderControls";
import { LoadingStatus } from "../components/ReaderLoading";
import { formatDate, useProcessing } from "../reader";
import type { Provider, ReaderSettings, ReaderStatus } from "../types";
import "../tool-pages.css";

const morningRunLabels = { collecting: "采集中", summarizing: "准备摘要", ready: "已就绪", partial: "部分就绪", failed: "失败" } as const;

function ReadingSchedule({ disabled }: { disabled: boolean }) {
  const client = useQueryClient();
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
  const copy = <div className="ns-settings-copy">
    <h2>晨间阅读节奏</h2>
    <p>固定使用上海时区，每天早上准备一批候选。手动刷新来源不改变定时周期。</p>
  </div>;
  if (status.isLoading) return <section className="ns-settings-panel" aria-label="晨间阅读节奏">{copy}<div className="ns-settings-form"><LoadingStatus>正在读取晨间采集设置…</LoadingStatus></div></section>;
  if (!form) return status.error ? <section className="ns-settings-panel" aria-label="晨间阅读节奏">{copy}<div className="ns-settings-form"><ErrorNotice title="晨间采集设置读取失败" error={status.error} busy={status.isFetching} retry={() => void status.refetch()}/></div></section> : null;
  const readerSettings = form;
  const dirty = !saved || readerSettings.mode !== saved.mode || readerSettings.hour !== saved.hour || readerSettings.includeObserving !== saved.includeObserving || readerSettings.briefLimit !== saved.briefLimit;
  const locked = disabled || save.isPending;
  function submit(event: FormEvent) { event.preventDefault(); if (!disabled && dirty && !save.isPending) save.mutate(readerSettings); }
  const run = status.data?.morningRun;
  return <section className="ns-settings-panel" aria-label="晨间阅读节奏">
    {copy}
    <form className="ns-settings-form" onSubmit={submit} aria-busy={save.isPending}>
      {status.error && <ErrorNotice title="采集日程暂未更新，以下为上次读取的状态" error={status.error} busy={status.isFetching} retry={() => void status.refetch()}/>}
      <div className="ns-setting-toggle"><Toggle checked={readerSettings.includeObserving} label="包含健康的观察来源" text="包含健康的观察来源（明确标识，非已确认信源）" disabled={locked} onChange={includeObserving => setDraft({ ...readerSettings, includeObserving })}/></div>
      <div className="ns-form-grid">
        <FormField label="采集方式"><select value={readerSettings.mode} disabled={locked} onChange={event => { const mode = event.currentTarget.value; if (mode === "daily" || mode === "interval") setDraft({ ...readerSettings, mode }); }}><option value="daily">每日晨间采集</option><option value="interval">按来源间隔采集</option></select></FormField>
        {readerSettings.mode === "daily" && <FormField label="每日时间（上海）"><select value={String(readerSettings.hour)} disabled={locked} onChange={event => setDraft({ ...readerSettings, hour: Number(event.currentTarget.value) })}>{Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{String(hour).padStart(2, "0")}:00</option>)}</select></FormField>}
        <FormField label="精选条数上限"><select value={String(readerSettings.briefLimit)} disabled={locked} onChange={event => setDraft({ ...readerSettings, briefLimit: Number(event.currentTarget.value) })}>{[5, 10, 15, 20, 25, 30].map(value => <option key={value} value={value}>{value} 条</option>)}</select></FormField>
      </div>
      <p className="ns-settings-note">错过时点会在服务恢复后补采；今天时点已过才首次启用或修改日程，首轮从明天开始。</p>
      <dl className="ns-settings-facts">
        <div><dt>下次计划</dt><dd>{status.data?.nextCollectionAt ? formatDate(status.data.nextCollectionAt) : "按来源间隔或尚未排定"}</dd></div>
        <div><dt>上次成功采集</dt><dd>{formatDate(status.data?.lastCollectionAt)}</dd></div>
        <div><dt>最新来源时间</dt><dd>{formatDate(status.data?.latestPublishedAt)}</dd></div>
        {run && <div><dt>本日运行</dt><dd>{morningRunLabels[run.status]} · 成功来源 {run.sourceSucceeded} · 失败来源 {run.sourceFailed} · 计划 {formatDate(run.scheduledAt)} · 实际开始 {formatDate(run.startedAt)}{run.message ? ` · ${run.message}` : ""}</dd></div>}
      </dl>
      <div className="ns-save-row">
        <ReaderButton type="submit" variant="primary" disabled={disabled || !dirty || save.isPending}>{save.isPending ? "正在保存…" : "保存晨间设置"}</ReaderButton>
        {draft && <ReaderButton disabled={save.isPending} onClick={() => setDraft(null)}>放弃修改</ReaderButton>}
        {save.isSuccess && !draft && <Notice tone="success">晨间设置已保存。</Notice>}
      </div>
      {save.error && <ErrorNotice title="晨间设置保存失败" error={save.error} busy={save.isPending} retry={() => save.mutate(readerSettings)}/>}
    </form>
  </section>;
}

function providerState(provider: Provider) {
  if (provider.provider !== "github-copilot") return { label: "暂不支持", tone: "muted" };
  if (!provider.connected) return { label: "未连接", tone: "warn" };
  return provider.eligible ? { label: "已连接 · 可用", tone: "ok" } : { label: "已连接 · 不可用", tone: "warn" };
}

export function SettingsPage() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ["providers"], queryFn: api.providers });
  const runtime = useQuery({ queryKey: ["runtime"], queryFn: api.runtime });
  const processing = useProcessing();
  const invalidate = () => Promise.all(["providers", "processing"].map(key => client.invalidateQueries({ queryKey: [key] })));
  const connectLocal = useMutation({ mutationFn: api.connectLocalCopilot, onSettled: invalidate });
  const refresh = useMutation({ mutationFn: api.probeCopilot, onSettled: invalidate });
  const disconnect = useMutation({ mutationFn: api.disconnectCopilot, onSettled: invalidate });
  const busy = connectLocal.isPending || refresh.isPending || disconnect.isPending;
  const canConnect = runtime.data?.mode === "postgres" && !runtime.error && !!processing.data && processing.data.blockedReason !== "isolated" && processing.data.blockedReason !== "demo";
  return <div className="ns-admin-page ns-settings-page">
    <PageHeader eyebrow="Settings" title="阅读与模型设置" subtitle="阅读原文不需要模型账户。周期采集与摘要队列使用可用额度，失败时保留原文入口。"/>
    {query.error && <ErrorNotice title="模型账户读取失败" error={query.error} busy={query.isFetching} retry={() => void query.refetch()}/>}
    {runtime.error && <ErrorNotice title="运行环境读取失败" error={runtime.error} busy={runtime.isFetching} retry={() => void runtime.refetch()}/>}
    {runtime.data?.mode === "demo" && <Notice>演示模式不会访问本机账户或生成真实摘要。</Notice>}
    <ReadingSchedule disabled={runtime.data?.mode !== "postgres" || !!runtime.error}/>
    {processing.error && <ErrorNotice title="自动摘要状态读取失败" error={processing.error} busy={processing.isFetching} retry={() => void processing.refetch()}/>}
    {processing.isLoading && <section className="ns-settings-panel"><div className="ns-settings-copy"><h2>自动摘要与用量</h2></div><div className="ns-settings-form"><LoadingStatus>正在读取摘要用量与队列…</LoadingStatus></div></section>}
    {processing.data && <ProcessingSettings data={processing.data} provider={query.data?.items.find(item => item.provider === "github-copilot")} disabled={!canConnect || busy}/>}
    <section className="ns-settings-panel" aria-label="模型账户">
      <div className="ns-settings-copy">
        <h2>模型账户</h2>
        <p>摘要精确使用已选择的 GitHub Copilot 配置，不会静默回退到其他模型或提供方。断开只影响 ScoutNews。</p>
      </div>
      <div className="ns-settings-form">
        {connectLocal.error && <ErrorNotice title="本机账户连接失败" error={connectLocal.error} busy={busy || !canConnect} retry={() => connectLocal.mutate()}/>}
        {refresh.error && <ErrorNotice title="Copilot 能力探测失败" error={refresh.error} busy={busy || !canConnect} retry={() => refresh.mutate()}/>}
        {disconnect.error && <ErrorNotice title="断开 Copilot 失败" error={disconnect.error} busy={busy || !canConnect} retry={() => disconnect.mutate()}/>}
        {refresh.isSuccess && <Notice tone="success">能力探测已完成，请查看最新状态与可用模型。</Notice>}
        {connectLocal.isSuccess && <Notice tone="success">已接入本机登录账户。开启的自动摘要会在模型与额度可用时继续处理队列；也可在文章中手动生成。</Notice>}
        {disconnect.isSuccess && <Notice>ScoutNews 已断开并记住此选择，仍可阅读原文。本机 GitHub/Copilot 登录未退出。</Notice>}
        {query.isLoading ? <LoadingStatus>正在读取模型与账户…</LoadingStatus> : <>
          {query.data?.items.map(provider => {
            const copilot = provider.provider === "github-copilot", state = providerState(provider);
            return <div className="ns-provider" key={provider.provider}>
              <div className="ns-provider-head"><h3>{copilot ? "GitHub Copilot" : provider.provider === "azure-openai" ? "Azure OpenAI" : provider.provider}</h3><span className={`ns-status is-${state.tone}`}>{state.label}</span></div>
              <p>{copilot ? provider.message : "此版本尚不支持调用此提供方。即使服务端检测到配置，也不表示能够生成摘要。"}</p>
              {copilot && <>
                <dl className="ns-settings-facts">
                  <div><dt>最近验证</dt><dd>{formatDate(provider.verifiedAt)}</dd></div>
                  <div><dt>登录方式</dt><dd>{provider.authMode === "local" ? "本机 GitHub/Copilot 登录" : provider.authMode === "oauth" ? "OAuth App 授权" : "尚未连接"}{provider.accountLogin ? ` · ${provider.accountLogin}` : ""}</dd></div>
                  <div><dt>默认模型</dt><dd>{provider.preferredModel}{provider.connected && !provider.model ? "（当前账户不可用，不会自动替换）" : ""}</dd></div>
                  <div><dt>可用模型</dt><dd>{provider.models?.length ? provider.models.join(" · ") : "暂无，请连接账户或重新探测"}</dd></div>
                </dl>
                <div className="ns-save-row">
                  {(!provider.connected || provider.authMode !== "local") && <ReaderButton variant="primary" icon={<PlugConnectedRegular/>} disabled={busy || !canConnect} onClick={() => { refresh.reset(); disconnect.reset(); connectLocal.mutate(); }}>{connectLocal.isPending ? "正在连接…" : "连接本机 GitHub/Copilot"}</ReaderButton>}
                  <ReaderButton icon={<ArrowSyncRegular/>} disabled={busy || !canConnect || !provider.authMode} onClick={() => { connectLocal.reset(); disconnect.reset(); refresh.mutate(); }}>{refresh.isPending ? "正在探测…" : "重新探测"}</ReaderButton>
                  {provider.authMode && <ReaderButton disabled={busy || !canConnect} onClick={() => { connectLocal.reset(); refresh.reset(); disconnect.mutate(); }}>{disconnect.isPending ? "正在断开…" : "断开"}</ReaderButton>}
                  {provider.oauthConfigured && <ReaderButton disabled={busy || !canConnect} onClick={() => { location.href = "/api/v1/auth/github/start"; }}>改用 OAuth App 授权</ReaderButton>}
                </div>
                <p className="ns-settings-note">直接复用本机登录，无需复制 token。更换本机账号后请重新探测；断开不会退出全局登录。</p>
              </>}
            </div>;
          })}
          {query.data && !query.data.items.some(provider => provider.provider === "azure-openai") && <div className="ns-provider">
            <div className="ns-provider-head"><h3>Azure OpenAI</h3><span className="ns-status is-muted">暂不支持</span></div>
            <p>当前版本不提供 Azure 调用或浏览器密钥配置，也不会自动回退到 Azure。</p>
          </div>}
          {query.data?.items.length === 0 && <Notice>服务端没有返回可用的模型提供方。请检查 API 配置后重新读取。</Notice>}
        </>}
      </div>
    </section>
  </div>;
}