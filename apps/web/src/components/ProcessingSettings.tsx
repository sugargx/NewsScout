import { Badge, Button, Field, Input, Select, Switch } from "@fluentui/react-components";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { DEFAULT_SUMMARY_MODEL, formatDate, processingBlocker, summaryStatusLabel } from "../reader";
import { useStyles } from "../styles";
import type { Processing, Provider } from "../types";
import { ErrorNotice, Notice } from "./Feedback";

interface Draft { enabled: boolean; model: string; dailyLimit: string }

export function ProcessingSettings({ data, provider, disabled }: { data: Processing; provider?: Provider; disabled: boolean }) {
  const styles = useStyles(), client = useQueryClient();
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
  return <section className={styles.card} aria-label="自动摘要设置">
    <h2>自动摘要与用量</h2>
    <p className={styles.summary}>自动摘要会使用所选账户的 GitHub Copilot 用量，优先处理近期内容并兼顾不同主题，分批补齐旧摘录。默认模型为 {DEFAULT_SUMMARY_MODEL}，当前保存的上限为 {data.settings.dailyLimit} 次 / 滚动 24 小时；不会静默换模型、提供方或提高预算。手动生成与自动任务共用上限，失败调用也计入。</p>
    {blocker && <Notice>{blocker}</Notice>}
    <form onSubmit={submit} noValidate aria-busy={save.isPending}>
      <Switch label="启用自动中文摘要" checked={form.enabled} disabled={busy} onChange={(_, value) => change({ enabled: value.checked })} />
      <p className={styles.summary}>关闭并保存后不再启动新任务；正在运行的任务仍会完成。暂停不删除已有摘要或队列。</p>
      <div className={styles.formGrid}>
        <Field label="自动摘要模型（精确选择）">
          <Select value={form.model} disabled={busy} onChange={(_, value) => change({ model: value.value })}>
            {models.map(model => <option key={model} value={model}>{model}{!provider?.models.includes(model) ? "（当前未探测到）" : ""}</option>)}
          </Select>
        </Field>
        <Field label="滚动 24 小时调用上限" validationMessage={validation} validationState={validation ? "error" : "none"}>
          <Input type="number" min={1} max={5000} step={1} value={form.dailyLimit} disabled={busy} onChange={(_, value) => change({ dailyLimit: value.value })} />
        </Field>
      </div>
      {!available && <p className={styles.summary}>所选模型尚不可用。可以保存设置，待账户连接且模型可用后继续；不会自动选择列表中的其他模型。</p>}
      <div className={styles.actions}>
        <div className={styles.buttonGroup}>
          <Button type="submit" appearance="primary" disabled={busy || !dirty}>{save.isPending ? "正在保存…" : "保存自动摘要设置"}</Button>
          {draft && <Button type="button" disabled={busy} onClick={() => { setDraft(null); setValidation(""); save.reset(); }}>放弃修改</Button>}
        </div>
        {dirty && <Badge color="warning" appearance="tint">有未保存的修改</Badge>}
      </div>
    </form>
    {save.error && <ErrorNotice title="自动摘要设置保存失败，请检查后重新保存" error={save.error} />}
    {save.isSuccess && <Notice>设置已保存。不会改写已完成的摘要或历史简报快照。</Notice>}
    <h3>实际调用用量与全局队列</h3>
    <p>滚动 24 小时已使用 <strong>{data.usage.used} / {data.usage.limit}</strong> 次（包含失败调用）。最早额度恢复：{data.usage.resetsAt ? `${formatDate(data.usage.resetsAt)}（北京时间）` : "暂无恢复时间记录"}。滚动窗口不是每天零点重置。</p>
    <p>已生成 AI 摘要 {data.aiCount} 条 · 待本地处理的来源内容 {data.feedCount} 条</p>
    <div className={styles.meta} aria-label="全局摘要队列">
      <Badge appearance="tint" color="informative">排队中 {data.counts.pending}</Badge>
      <Badge appearance="tint" color="warning">生成中 {data.counts.running}</Badge>
      <Badge appearance="tint" color="danger">已失败 {data.counts.failed}</Badge>
      <Badge appearance="tint" color="success">已完成 {data.counts.completed}</Badge>
    </div>
    <div className={styles.actions}><Button disabled={busy || !data.counts.failed} onClick={() => retry.mutate()}>{retry.isPending ? "正在重新排队…" : "重试失败任务"}</Button></div>
    <p className={styles.summary}>仅将失败任务重新排队；仍需自动摘要开启、账户和模型可用且有剩余额度，不会提高调用上限。</p>
    {retry.error && <ErrorNotice title="失败任务重新排队失败" error={retry.error} busy={busy || !data.counts.failed} retry={() => retry.mutate()} />}
    {retry.data && <Notice>{retry.data.queued ? `已将 ${retry.data.queued} 个失败任务重新排队，尚未生成完成。` : "没有失败任务需要重新排队。"}</Notice>}
    <h3>最近任务</h3>
    <p className={styles.summary}>以下为服务端返回的有限条近期记录，不是完整队列；上方数量为全局统计。</p>
    {data.jobs.length ? <ul className={styles.jobList}>{data.jobs.map(job => <li key={job.eventId} className={styles.evidence}>
      <div className={styles.meta}>
        <Badge appearance="tint" color={job.status === "completed" ? "success" : job.status === "failed" && !job.nextAttemptAt ? "danger" : "warning"}>{summaryStatusLabel(job.status, job.nextAttemptAt, job.lastError)}</Badge>
        <Link to={"/events/" + encodeURIComponent(job.eventId)}>{job.title}</Link>
      </div>
      <p>模型：{job.model ?? "尚未分配"} · 已尝试 {job.attempts} 次{job.nextAttemptAt && job.status !== "completed" ? ` · 下次尝试不早于：${formatDate(job.nextAttemptAt)}（北京时间）` : ""}</p>
      {job.lastError && <div className={styles.error}><strong>最近错误</strong><span>{job.lastError}</span></div>}
    </li>)}</ul> : <p>暂无近期任务记录。</p>}
  </section>;
}
