import { DeleteRegular } from "@fluentui/react-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState, type FormEvent } from "react";
import { api } from "../api";
import { ErrorNotice, Notice } from "../components/Feedback";
import { FormField, Toggle, WeightField } from "../components/FormControls";
import { LoadingStatus } from "../components/ReaderLoading";
import { PageHeader } from "../components/PageHeader";
import { ReaderButton } from "../components/ReaderControls";
import { invalidateReader } from "../reader";
import type { Topic } from "../types";
import "../tool-pages.css";

const contexts = [
  { value: "long_term", label: "长期兴趣" },
  { value: "current_project", label: "当前项目" },
  { value: "work", label: "工作领域" },
] as const;

export function TopicsPage() {
  const client = useQueryClient(), errorId = useId();
  const query = useQuery({ queryKey: ["topics"], queryFn: api.topics });
  const [draft, setDraft] = useState<Topic[] | null>(null);
  const [label, setLabel] = useState(""), [context, setContext] = useState<string>("long_term"), [validation, setValidation] = useState("");
  const topics = draft ?? query.data?.items ?? [];
  const save = useMutation({
    mutationFn: api.saveTopics,
    onSuccess: async data => { client.setQueryData(["topics"], data); setDraft(null); await invalidateReader(client); },
  });
  const busy = save.isPending || query.isLoading || !query.data;
  const change = (id: string, patch: Partial<Topic>) => {
    save.reset();
    setDraft(topics.map(item => item.id === id ? { ...item, ...patch } : item));
  };
  function add(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const name = label.trim(), id = name.toLowerCase().replace(/\s+/g, "-");
    if (!name) { setValidation("请输入主题名称。"); return; }
    if (topics.some(topic => topic.id === id || topic.label.toLowerCase() === name.toLowerCase())) { setValidation("该主题已经存在。"); return; }
    const group = contexts.find(item => item.value === context)?.label ?? "长期兴趣";
    setDraft([...topics, { id, label: name, group, weight: 50, context, enabled: true }]);
    setLabel(""); setValidation(""); save.reset();
  }
  return <div className="ns-admin-page">
    <PageHeader eyebrow="Interest profile" title="你关心什么" subtitle="为每个主题设置影响精选排序的权重，范围 0–100；关闭主题不会丢失原权重。"
      action={<ReaderButton variant="primary" disabled={busy || draft === null} onClick={() => save.mutate(topics)}>{save.isPending ? "正在保存…" : "保存权重"}</ReaderButton>}/>
    {query.error && <ErrorNotice title="兴趣配置读取失败" error={query.error} busy={query.isFetching} retry={() => void query.refetch()}/>}
    {save.error && <ErrorNotice title="兴趣保存失败，修改仍保留在此页面" error={save.error} busy={busy} retry={() => save.mutate(topics)}/>}
    {query.isLoading ? <LoadingStatus>正在读取兴趣配置…</LoadingStatus> : query.data && <>
      <form className="ns-panel ns-add-topic" onSubmit={add} noValidate>
        <FormField label="新主题名称" className={validation ? "has-error" : undefined}>
          <input value={label} disabled={busy} placeholder="例如 Rust" aria-invalid={validation ? true : undefined} aria-describedby={validation ? errorId : undefined}
            onChange={event => { setLabel(event.currentTarget.value); setValidation(""); }}/>
        </FormField>
        <FormField label="兴趣分类">
          <select value={context} disabled={busy} onChange={event => setContext(event.currentTarget.value)}>
            {contexts.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </FormField>
        <ReaderButton type="submit" disabled={busy}>添加主题</ReaderButton>
        {validation && <p className="ns-add-topic-error" id={errorId} role="alert">{validation}</p>}
      </form>
      {!topics.length && <Notice>尚未设置兴趣主题。添加主题并保存后开始个性化排序；仍可浏览全部新闻。</Notice>}
      <div className="ns-weight-list">{topics.map(topic => <div className={`ns-weight-row${topic.enabled ? "" : " is-disabled"}`} key={topic.id}>
        <div className="ns-weight-name"><strong>{topic.label}</strong><span>{topic.group}</span></div>
        <WeightField topic={topic.label} value={topic.weight} disabled={busy || !topic.enabled} onChange={weight => change(topic.id, { weight })}/>
        <div className="ns-weight-controls">
          <Toggle checked={topic.enabled} label={`启用主题：${topic.label}`} disabled={busy} onChange={enabled => change(topic.id, { enabled })}/>
          <ReaderButton variant="ghost" className="ns-icon-button" icon={<DeleteRegular/>} aria-label={`移除主题：${topic.label}`} title="移除主题" disabled={busy}
            onClick={() => { setDraft(topics.filter(item => item.id !== topic.id)); save.reset(); }}/>
        </div>
      </div>)}</div>
      {save.isSuccess && <Notice tone="success">权重已保存。新闻雷达会按新权重重新排序，已生成的简报保持不变。</Notice>}
      {draft !== null && <Notice>有尚未保存的修改。离开本页前请点击“保存权重”。</Notice>}
    </>}
  </div>;
}