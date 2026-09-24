import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { DEFAULT_SUMMARY_MODEL, formatDate, processingBlocker, summaryStatusLabel } from "../reader";
import type { Processing, Provider } from "../types";
import { ErrorNotice, Notice } from "./Feedback";
import { FormField, Toggle } from "./FormControls";
import { ReaderButton } from "./ReaderButton";

interface Draft { enabled: boolean; model: string; dailyLimit: string }

export function ProcessingSettings({ data, provider, disabled }: { data: Processing; provider?: Provider; disabled: boolean }) {
  const client = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [validation, setValidation] = useState("");
  const saved = { ...data.settings, dailyLimit: String(data.settings.dailyLimit) };
  const form = draft ?? saved;
  const dirty = form.enabled !== saved.enabled || form.model !== saved.model || form.dailyLimit !== saved.dailyLimit;
  const models = [...new Set([DEFAULT_SUMMARY_MODEL, saved.model, form.model, ...(provider?.models ?? [])])].filter(Boolean);
  const available = !!provider?.connected && !!provider.eligible && !!provider.models.includes(form.model);
  const invalidate = () => Promise.all(["processing", "providers"].map(key => client.invalidateQueries({ queryKey: [key] })));
  const save = useMutation({
    mutationFn: api.saveProcessingSettings,
    onSuccess: async settings => {
      client.setQueryData<Processing>(["processing"], current => current ? { ...current, settings } : current);
      setDraft(null);
      await invalidate();
    },
  });
  const retry = useMutation({ mutationFn: api.retryProcessing, onSuccess: invalidate });
  const busy = disabled || save.isPending || retry.isPending;
  function change(value: Partial<Draft>) {
    setDraft({ ...form, ...value });
    setValidation("");
    save.reset();
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !dirty) return;
    const dailyLimit = Number(form.dailyLimit);
    if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 5000) {
      setValidation("滚动 24 小时调用上限必须是 1–5000 的整数。");
      return;
    }
    if (!form.model) { setValidation("请明确选择模型，不会自动使用其他模型。"); return; }
    setValidation("");
    save.mutate({ enabled: form.enabled, model: form.model, dailyLimit });
  }
  const blocker = processingBlocker(data.blockedReason) || (!data.settings.enabled ? processingBlocker("disabled") : "");
  const latestError = data.jobs.find(job => job.lastError);
  return <section className="ns-settings-panel" aria-label="自动摘要设置">
    <div className="ns-settings-copy">
      <h2>自动摘要与用量</h2>
      <p>暂停不会删除已保存内容，现有阅读路径不受影响。手动生成与自动任务共用调用上限，失败调用也计入。</p>
    </div>
    <div className="ns-settings-form">
      {blocker && <Notice>{blocker}</Notice>}
      <form className="ns-settings-form" onSubmit={submit} noValidate aria-busy={save.isPending}>
        <div className="ns-setting-toggle"><Toggle checked={form.enabled} label="启用自动中文摘要" text="启用自动中文摘要" disabled={busy} onChange={enabled => change({ enabled })}/></div>
        <div className="ns-form-grid">
          <FormField label="自动摘要模型（精确选择）">
            <select value={form.model} disabled={busy} onChange={event => change({ model: event.currentTarget.value })}>
              {models.map(model => <option key={model} value={model}>{model}{!provider?.models.includes(model) ? "（当前未探测到）" : ""}</option>)}
            </select>
          </FormField>
          <FormField label="滚动 24 小时调用上限" error={validation}>
            <input type="number" inputMode="numeric" min={1} max={5000} step={1} value={form.dailyLimit} disabled={busy} onChange={event => change({ dailyLimit: event.currentTarget.value })}/>
          </FormField>
        </div>
        {!available && <p className="ns-settings-note">所选模型尚不可用。可以保存设置，待账户连接且模型可用后继续；不会自动选择其他模型。</p>}
        <div className="ns-save-row">
          <ReaderButton type="submit" variant="primary" disabled={busy || !dirty}>{save.isPending ? "正在保存…" : "保存自动摘要设置"}</ReaderButton>
          {draft && <ReaderButton disabled={busy} onClick={() => { setDraft(null); setValidation(""); save.reset(); }}>放弃修改</ReaderButton>}
          {dirty && <span className="ns-status is-warn">有未保存的修改</span>}
        </div>
      </form>
      {save.error && <ErrorNotice title="自动摘要设置保存失败，请检查后重新保存" error={save.error}/>}
      {save.isSuccess && <Notice tone="success">设置已保存。不会改写已完成的摘要或历史简报快照。</Notice>}
      <div className="ns-usage">
        <p>滚动 24 小时已使用 <strong>{data.usage.used} / {data.usage.limit}</strong> 次（包含失败调用）· 最早额度恢复：{data.usage.resetsAt ? `${formatDate(data.usage.resetsAt)}（北京时间）` : "暂无记录"}</p>
        <p>已生成 AI 摘要 {data.aiCount} 条 · 待处理的来源内容 {data.feedCount} 条</p>
        <div className="ns-meta ns-queue-pills" role="group" aria-label="全局摘要队列">
          <span className="ns-pill">排队中 {data.counts.pending}</span>
          <span className="ns-pill is-amber">生成中 {data.counts.running}</span>
          <span className={`ns-pill${data.counts.failed ? " is-danger" : ""}`}>已失败 {data.counts.failed}</span>
          <span className="ns-pill is-green">已完成 {data.counts.completed}</span>
        </div>
      </div>
      {latestError && <div className="ns-error-note"><strong>最近错误</strong><span>{latestError.title} · {latestError.lastError}</span></div>}
      <div className="ns-save-row">
        <ReaderButton disabled={busy || !data.counts.failed} onClick={() => retry.mutate()}>{retry.isPending ? "正在重新排队…" : "重试失败任务"}</ReaderButton>
        <span className="ns-settings-note">仅将失败任务重新排队，不会提高调用上限。</span>
      </div>
      {retry.error && <ErrorNotice title="失败任务重新排队失败" error={retry.error} busy={busy || !data.counts.failed} retry={() => retry.mutate()}/>}
      {retry.data && <Notice>{retry.data.queued ? `已将 ${retry.data.queued} 个失败任务重新排队，尚未生成完成。` : "没有失败任务需要重新排队。"}</Notice>}
      <details className="ns-source-disclosure">
        <summary>最近任务 · {data.jobs.length}</summary>
        <p>以下为服务端返回的有限条近期记录，不是完整队列；上方数量为全局统计。</p>
        {data.jobs.length ? <div className="ns-line-list">{data.jobs.map(job => <div className="ns-line-item" key={job.eventId}>
          <div>
            <strong><Link to={"/events/" + encodeURIComponent(job.eventId)}>{job.title}</Link></strong>
            <span>模型：{job.model ?? "尚未分配"} · 已尝试 {job.attempts} 次{job.nextAttemptAt && job.status !== "completed" ? ` · 下次尝试不早于：${formatDate(job.nextAttemptAt)}（北京时间）` : ""}</span>
            {job.lastError && <span className="ns-line-error">最近错误：{job.lastError}</span>}
          </div>
          <span className={`ns-status ${job.status === "completed" ? "is-ok" : "is-warn"}`}>{summaryStatusLabel(job.status, job.nextAttemptAt, job.lastError)}</span>
        </div>)}</div> : <p>暂无近期任务记录。</p>}
      </details>
    </div>
  </section>;
}