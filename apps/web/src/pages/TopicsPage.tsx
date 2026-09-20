import { Button, Card, CardHeader, Field, Input, Slider, Spinner, Switch, Text } from "@fluentui/react-components";
import { SaveRegular } from "@fluentui/react-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { api } from "../api";
import { ErrorNotice, Notice } from "../components/Feedback";
import { PageHeader } from "../components/PageHeader";
import { invalidateReader } from "../reader";
import { useStyles } from "../styles";
import type { Topic } from "../types";

export function TopicsPage() {
  const styles = useStyles(), client = useQueryClient();
  const query = useQuery({ queryKey: ["topics"], queryFn: api.topics });
  const [draft, setDraft] = useState<Topic[] | null>(null);
  const [label, setLabel] = useState(""), [validation, setValidation] = useState("");
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
    const name = label.trim(), id = name.toLowerCase().replace(/\s+/g, "-");
    if (!name) { setValidation("请输入主题名称。"); return; }
    if (topics.some(topic => topic.id === id || topic.label.toLowerCase() === name.toLowerCase())) { setValidation("该主题已经存在。"); return; }
    setDraft([...topics, { id, label: name, group: "自定义", weight: 50, context: "", enabled: true }]);
    setLabel(""); setValidation(""); save.reset();
  }
  return <>
    <PageHeader eyebrow="Interest Profile" title="你关心什么" subtitle="选择启用的主题并调整权重，服务端据此计算个人相关度。权重 0–100；关闭主题后不再计入你的兴趣偏好。" action={<Button appearance="primary" icon={<SaveRegular />} disabled={busy || draft === null} onClick={() => save.mutate(topics)}>{save.isPending ? "正在保存…" : "保存"}</Button>} />
    {query.error && <ErrorNotice title="兴趣配置读取失败" error={query.error} busy={query.isFetching} retry={() => void query.refetch()} />}
    {save.error && <ErrorNotice title="兴趣保存失败，修改仍保留在此页面" error={save.error} busy={busy} retry={() => save.mutate(topics)} />}
    {save.isSuccess && <Notice>兴趣偏好已保存，Radar 与简报预览将重新读取。已保存快照内容保持不变。</Notice>}
    {draft !== null && <Notice>有尚未保存的修改。离开本页前请点击“保存”。</Notice>}
    {query.isLoading ? <Spinner label="正在读取兴趣配置…" /> : query.data && <>
      <form className={styles.toolbar} onSubmit={add} noValidate><Field label="新主题名称" className={styles.field} validationMessage={validation} validationState={validation ? "error" : "none"}><Input value={label} disabled={busy} onChange={(_, data) => { setLabel(data.value); setValidation(""); }} placeholder="例如 Rust" /></Field><Button type="submit" disabled={busy}>添加主题</Button></form>
      {!topics.length && <Notice>尚未设置兴趣主题。添加主题并保存后开始个性化排序；仍可浏览全部新闻。</Notice>}
      <div className={styles.grid}>{topics.map(topic => <Card key={topic.id}>
        <CardHeader header={<Text weight="semibold">{topic.label}</Text>} description={<Text>{topic.group}</Text>} action={<Switch aria-label={`启用主题：${topic.label}`} checked={topic.enabled} disabled={busy} onChange={(_, data) => change(topic.id, { enabled: data.checked })} />} />
        <div style={{ padding: "0 16px 16px" }}>
          <Field label={`权重 · ${topic.label}：${topic.weight}`}><Slider min={0} max={100} step={1} value={topic.weight} disabled={busy || !topic.enabled} onChange={(_, data) => change(topic.id, { weight: data.value })} /></Field>
          <Button size="small" appearance="subtle" disabled={busy} aria-label={`移除主题：${topic.label}`} onClick={() => { setDraft(topics.filter(item => item.id !== topic.id)); save.reset(); }}>移除主题</Button>
        </div>
      </Card>)}</div>
    </>}
  </>;
}
