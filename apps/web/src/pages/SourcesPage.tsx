import { AddRegular, ArrowSyncRegular, DismissRegular } from "@fluentui/react-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { Link as RouterLink, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { ErrorNotice, Notice } from "../components/Feedback";
import { FormField, Toggle } from "../components/FormControls";
import { PageHeader } from "../components/PageHeader";
import { ReaderButton, ReaderTabs } from "../components/ReaderControls";
import { LoadingStatus } from "../components/ReaderLoading";
import { formatDate, httpsUrl, invalidateIngestion } from "../reader";
import type { IngestionResult, NewSource, Source } from "../types";
import { watchPlatforms, watchStatuses, watchStatus, watchStatusLabel } from "../source-watchlist";
import "../tool-pages.css";
const sourceAdapters: { value: NewSource["adapter"]; label: string; contentType: NewSource["contentType"] }[] = [
  { value: "rss", label: "RSS", contentType: "blog" },
  { value: "atom", label: "Atom", contentType: "blog" },
  { value: "github_release_atom", label: "GitHub Release Atom", contentType: "release" },
  { value: "podcast_rss", label: "Podcast RSS", contentType: "podcast" },
  { value: "arxiv_atom", label: "arXiv API（Atom）", contentType: "paper" },
  { value: "huggingface_models", label: "Hugging Face 公开模型 API", contentType: "model" },
  { value: "github_repository", label: "GitHub 仓库元数据 API", contentType: "repository" },
  { value: "github_search", label: "GitHub 项目发现（观察）", contentType: "repository" },
  { value: "anthropic_news", label: "Anthropic News 官方索引", contentType: "blog" },
  { value: "anthropic_research", label: "Anthropic Research 研究索引", contentType: "blog" },
  { value: "anthropic_engineering", label: "Anthropic Engineering 工程索引", contentType: "blog" },
  { value: "x_public_preview", label: "X 原帖预览（登记链接）", contentType: "blog" },
];

function parseXPostUrls(value:string,profile:string) {
  const entries=value.split(/\r?\n/).map(item=>item.trim()).filter(Boolean);
  if(!entries.length||entries.length>20)return {error:"请登记 1–20 条同一账号的 X 原帖链接。"};
  const author=profile.match(/^https:\/\/x\.com\/([A-Za-z0-9_]{1,15})$/)?.[1];
  if(!author)return {error:"X 来源主页必须是 https://x.com/账号，不含额外路径或参数。"};
  const urls:string[]=[],seen=new Set<string>();
  for(const value of entries) {
    const safe=httpsUrl(value);
    if(!safe||new TextEncoder().encode(value).length>2048)return {error:"每行都必须是有效的 HTTPS X 原帖链接（最多2048字节）。"};
    const url=new URL(safe),parts=url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)$/);
    if(url.hostname!=="x.com"||url.port||url.hash||!parts)
      return {error:"仅支持 x.com/账号/status/数字 形式的原帖链接。"};
    if([...url.searchParams.keys()].some(key=>!["s","t","ref_src","ref_url"].includes(key)))
      return {error:"原帖链接包含不支持的参数；请保留原始帖子地址。"};
    if(author!==parts[1])return {error:"登记链接必须属于来源主页指定的 X 账号。"};
    const canonical=`https://x.com/${author}/status/${parts[2]}`;
    if(!seen.has(canonical)){seen.add(canonical);urls.push(canonical);}
  }
  return {urls};
}

function isXProfileUrl(value:string) {
  return /^https:\/\/x\.com\/[A-Za-z0-9_]{1,15}$/.test(value);
}

function XPostUrlsEditor({source,disabled}:{source:Source;disabled:boolean}) {
  const client=useQueryClient();
  const [open,setOpen]=useState(false),[value,setValue]=useState(""),[validation,setValidation]=useState("");
  const registered=useQuery({queryKey:["x-post-urls",source.id],queryFn:()=>api.xPostUrls(source.id),enabled:open,
    staleTime:Infinity,refetchOnWindowFocus:false,refetchOnReconnect:false});
  useEffect(()=>{if(registered.data)setValue(registered.data.urls.join("\n"));},[registered.data]);
  const save=useMutation({mutationFn:(urls:string[])=>api.saveXPostUrls(source.id,urls),onSuccess:data=>{
    setValue(data.urls.join("\n"));setValidation("");client.setQueryData(["x-post-urls",source.id],data);
  }});
  function submit(event:FormEvent) {
    event.preventDefault();
    const parsed=parseXPostUrls(value,source.endpoint);
    if("error" in parsed){setValidation(parsed.error ?? "登记链接无效。");return;}
    save.mutate(parsed.urls);
  }
  return <details className="ns-source-disclosure" onToggle={event=>setOpen((event.currentTarget as HTMLDetailsElement).open)}>
    <summary>登记的 X 原帖预览</summary>
    <p>仅按登记链接读取公开原帖预览；不会自动发现主页新帖或完整时间线。保存后保留当前列表，需明确刷新该来源才会读取新登记项。</p>
    {registered.isLoading&&<LoadingStatus>正在读取登记链接…</LoadingStatus>}
    {registered.error&&<ErrorNotice title="登记链接读取失败" error={registered.error} retry={()=>void registered.refetch()}/>}
    {registered.data&&<form className="ns-settings-form" onSubmit={submit} noValidate>
      <FormField label="X 原帖预览（登记链接）" hint="1–20 条 · 同一账号 · 仅原帖链接" error={validation}>
        <textarea value={value} required disabled={disabled||save.isPending} rows={5} placeholder="https://x.com/handle/status/1234567890" onChange={event=>{setValue(event.currentTarget.value);setValidation("");}}/>
      </FormField>
      <div className="ns-save-row"><ReaderButton type="submit" disabled={disabled||save.isPending}>{save.isPending?"正在保存…":"保存登记链接"}</ReaderButton></div>
    </form>}
    {save.isSuccess&&value===save.data.urls.join("\n")&&<Notice tone="success">登记链接已保存；刷新来源后读取新登记项。</Notice>}
    {save.error&&<ErrorNotice title="登记链接保存失败" error={save.error} retry={()=>save.variables&&save.mutate(save.variables)}/>}
  </details>;
}

function RefreshResult({ result }: { result: IngestionResult }) {
  return <Notice tone={result.failed || !result.attempted ? "info" : "success"}><strong>{result.failed ? result.succeeded ? "部分来源刷新失败" : "来源刷新失败" : result.attempted ? "来源刷新完成" : "没有可刷新的来源"}</strong>：尝试 {result.attempted}，成功 {result.succeeded}，失败 {result.failed}，入库 {result.ingested} 条。{result.failed > 0 && "请查看下方来源的错误记录；已成功入库的内容仍可阅读。"}</Notice>;
}

function sourceStatus(source: Source) {
  if (source.lifecycleStatus === "paused") return { label: "已暂停", tone: "muted" };
  if (source.consecutiveFailures > 0) return { label: "采集失败", tone: "warn" };
  return source.lifecycleStatus === "stable" ? { label: "采集中", tone: "ok" } : { label: "观察中", tone: "warn" };
}

function SourceCard({ source, disabled }: { source: Source; disabled: boolean }) {
  const client = useQueryClient();
  const [interval, setInterval] = useState(String(source.scheduleMinutes));
  const [validation, setValidation] = useState("");
  useEffect(() => setInterval(String(source.scheduleMinutes)), [source.scheduleMinutes]);
  const update = useMutation({
    mutationFn: (value: { enabled?: boolean; scheduleMinutes?: number; confirmed?: boolean }) => api.updateSource(source.id, value),
    onSuccess: () => invalidateIngestion(client),
    onError: () => { void client.invalidateQueries({ queryKey: ["sources"] }); },
  });
  const refresh = useMutation({ mutationFn: () => api.refreshSource(source.id), onSuccess: () => invalidateIngestion(client), onError: () => { void invalidateIngestion(client); } });
  const busy = disabled || update.isPending || refresh.isPending;
  const paused = source.lifecycleStatus === "paused";
  const endpoint = httpsUrl(source.endpoint);
  const isXPreview = source.adapter === "x_public_preview";
  const status = sourceStatus(source);
  const adapterLabel = sourceAdapters.find(item => item.value === source.adapter)?.label ?? source.adapter;
  const intervalChanged = interval !== String(source.scheduleMinutes);
  function saveInterval(event: FormEvent) {
    event.preventDefault();
    const value = Number(interval);
    if (!Number.isInteger(value) || value < 15 || value > 1440) { setValidation("采集间隔必须是 15–1440 分钟的整数。"); return; }
    setValidation("");
    update.mutate({ scheduleMinutes: value });
  }
  return <section className="ns-source-card" aria-label={source.name} aria-busy={update.isPending || refresh.isPending}
    data-source-id={source.id} data-source-tier={source.tier} data-source-adapter={source.adapter} data-source-status={source.lifecycleStatus}>
    <div className="ns-source-head">
      <div className="ns-source-title">
        <h3>{source.name}</h3>
        <div className="ns-meta"><span className="ns-pill">{source.tier}</span><span className="ns-pill">{adapterLabel}</span><span>{source.topics.join(" · ") || "未指定主题"}</span></div>
      </div>
      <span className={`ns-status is-${status.tone}`}>{status.label}</span>
    </div>
    <p>{source.publisher ? `${source.publisher} · ` : ""}上次成功：{formatDate(source.lastSuccessAt)}（北京时间） · 连续失败 {source.consecutiveFailures ?? 0} 次</p>
    {isXPreview && <p>仅覆盖明确登记的公开原帖预览；不会自动发现主页新帖，也不代表完整时间线。</p>}
    {source.lastError && <div className="ns-error-note"><strong>最近采集错误</strong><span>{source.lastError}</span></div>}
    <div className="ns-source-actions">
      <form className="ns-source-schedule" onSubmit={saveInterval} noValidate>
        <Toggle checked={!paused} label={`${source.name}：启用采集`} text={paused ? "已暂停采集" : "启用采集"} disabled={busy} onChange={enabled => update.mutate({ enabled })}/>
        <label className="ns-source-interval"><span>每</span>
          <input type="number" inputMode="numeric" min={15} max={1440} step={1} value={interval} disabled={busy} aria-label={`采集间隔（分钟） · ${source.name}`} aria-invalid={validation ? true : undefined}
            onChange={event => { setInterval(event.currentTarget.value); setValidation(""); }}/><span>分钟</span></label>
        {intervalChanged && <ReaderButton type="submit" size="small" disabled={busy} aria-label={`保存采集间隔：${source.name}`}>{update.isPending ? "正在保存…" : "保存间隔"}</ReaderButton>}
      </form>
      <div>
        {endpoint ? <a className="ns-text-link" href={endpoint} target="_blank" rel="noopener noreferrer">{isXPreview ? "X 主页（仅身份识别）↗" : "订阅地址 ↗"}</a> : <span className="ns-source-invalid">订阅地址不是有效的 HTTPS 链接</span>}
        {source.lifecycleStatus === "observing" && source.adapter !== "github_search" && <ReaderButton
          disabled={busy || !source.lastSuccessAt || source.consecutiveFailures > 0}
          aria-label={`确认来源：${source.name}`} onClick={() => update.mutate({ confirmed: true })}>确认来源为稳定</ReaderButton>}
        <ReaderButton disabled={busy || paused} aria-label={`刷新来源：${source.name}`} onClick={() => refresh.mutate()}>{refresh.isPending ? "正在刷新…" : "刷新来源"}</ReaderButton>
      </div>
    </div>
    {validation && <p className="ns-field-error" role="alert">{validation}</p>}
    {isXPreview && <XPostUrlsEditor source={source} disabled={busy}/>}
    {update.error && <ErrorNotice title={`${source.name} 修改失败`} error={update.error} busy={busy} retry={() => update.variables && update.mutate(update.variables)}/>}
    {refresh.error && <ErrorNotice title={`${source.name} 刷新请求失败`} error={refresh.error} busy={busy || paused} retry={() => refresh.mutate()}/>}
    {refresh.data && <RefreshResult result={refresh.data}/>}
  </section>;
}

function AddSourceForm({ disabled, onClose }: { disabled: boolean; onClose: () => void }) {
  const client = useQueryClient();
  const [name, setName] = useState(""), [endpoint, setEndpoint] = useState(""), [topic, setTopic] = useState("");
  const [interval, setInterval] = useState("60");
  const [adapter, setAdapter] = useState<NewSource["adapter"]>("rss");
  const [contentType, setContentType] = useState<NewSource["contentType"]>("blog");
  const [originalPostUrls, setOriginalPostUrls] = useState("");
  const [validation, setValidation] = useState("");
  const add = useMutation({
    mutationFn: api.addSource,
    onSuccess: async () => {
      setName(""); setEndpoint(""); setTopic(""); setOriginalPostUrls(""); setValidation("");
      await Promise.all(["sources", "source-coverage"].map(key => client.invalidateQueries({ queryKey: [key] })));
    },
    onError: () => { void client.invalidateQueries({ queryKey: ["sources"] }); },
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    const url = httpsUrl(endpoint.trim()), scheduleMinutes = Number(interval);
    if (!name.trim()) { setValidation("请输入来源名称。"); return; }
    if (!url) { setValidation("请输入有效的 HTTPS 订阅地址，不支持 HTTP 或包含用户名密码的地址。"); return; }
    const xPreview = adapter === "x_public_preview";
    if (xPreview && !isXProfileUrl(url)) { setValidation("X 来源主页仅作身份识别，请填写 https://x.com/账号。"); return; }
    const parsed = xPreview ? parseXPostUrls(originalPostUrls, url) : undefined;
    if (parsed && "error" in parsed) { setValidation(parsed.error ?? "登记链接无效。"); return; }
    if (!Number.isInteger(scheduleMinutes) || scheduleMinutes < 15 || scheduleMinutes > 1440) { setValidation("采集间隔必须是 15–1440 分钟的整数。"); return; }
    setValidation("");
    add.mutate({ name: name.trim(), endpoint: url, adapter, contentType, tier: "T2", scheduleMinutes, ...(parsed ? { originalPostUrls: parsed.urls } : {}), ...(topic.trim() ? { topic: topic.trim() } : {}) });
  }
  const busy = disabled || add.isPending;
  const xPreview = adapter === "x_public_preview";
  return <section className="ns-panel ns-add-source" id="ns-add-source" aria-labelledby="ns-add-source-title">
    <div className="ns-panel-head">
      <h2 id="ns-add-source-title">添加订阅来源</h2>
      <ReaderButton variant="ghost" className="ns-icon-button" icon={<DismissRegular/>} aria-label="收起新增来源" title="收起" onClick={onClose}/>
    </div>
    <p>{xPreview ? "X 仅支持手动登记的公开原帖预览：主页只作身份识别，不自动发现新帖或读取完整时间线。" : "新来源默认归为 T2 并进入观察状态；确认来源只改变生命周期，不提升等级或授予官方身份。仅填写公开 Feed / API 地址，不要填写密钥、密码或私有访问令牌。"}</p>
    <form onSubmit={submit} noValidate aria-busy={add.isPending}>
      <div className="ns-form-grid ns-form-grid-3">
        <FormField label="来源名称"><input required value={name} disabled={busy} onChange={event => setName(event.currentTarget.value)}/></FormField>
        <FormField label={xPreview ? "X 主页（仅作身份识别）" : "HTTPS 订阅地址"}><input type="url" required value={endpoint} disabled={busy} placeholder={xPreview ? "https://x.com/handle" : "https://example.com/feed.xml"} onChange={event => setEndpoint(event.currentTarget.value)}/></FormField>
        <FormField label="采集适配器"><select value={adapter} disabled={busy} onChange={event => { const selected = sourceAdapters.find(item => item.value === event.currentTarget.value); if (selected) { setAdapter(selected.value); setContentType(selected.contentType); if (selected.value === "x_public_preview") setInterval("1440"); } }}>{sourceAdapters.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></FormField>
        <FormField label="内容类型"><select value={contentType} disabled={busy || xPreview} onChange={event => setContentType(event.currentTarget.value as NewSource["contentType"])}><option value="blog">{xPreview ? "帖子预览（文章存储）" : "博客 / 文章"}</option><option value="release">版本发布</option><option value="podcast">播客</option><option value="paper">论文</option><option value="model">模型元数据</option><option value="repository">仓库 / 发现候选</option></select></FormField>
        <FormField label="采集间隔（分钟）"><input type="number" inputMode="numeric" required min={15} max={1440} step={1} value={interval} disabled={busy} onChange={event => setInterval(event.currentTarget.value)}/></FormField>
        <FormField label="主题（可选）"><input value={topic} disabled={busy} onChange={event => setTopic(event.currentTarget.value)}/></FormField>
        {xPreview && <FormField className="ns-field-wide" label="X 原帖预览（登记链接）" hint="每行一条；仅登记链接，不自动发现新帖。"><textarea required value={originalPostUrls} disabled={busy} rows={5} placeholder={"https://x.com/handle/status/1234567890\nhttps://x.com/handle/status/1234567891"} onChange={event => setOriginalPostUrls(event.currentTarget.value)}/></FormField>}
      </div>
      {validation && <div role="alert" className="ns-error-note"><span>{validation}</span></div>}
      <div className="ns-save-row"><ReaderButton type="submit" variant="primary" disabled={busy}>{add.isPending ? "正在添加…" : "添加来源"}</ReaderButton><span className="ns-pill">默认 T2 · 非官方认证</span></div>
    </form>
    {add.error && <ErrorNotice title="添加来源失败，请检查输入后重试" error={add.error}/>}
    {add.isSuccess && <Notice tone="success">来源已添加。点击“刷新来源”或“采集启用的来源”开始采集。</Notice>}
  </section>;
}

type SourceTab = "sources" | "watchlist" | "gaps";

export function SourcesPage() {
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [adding, setAdding] = useState(false);
  const latestParams = useRef(params);
  useLayoutEffect(() => { latestParams.current = params; }, [params]);
  const requestedTab = params.get("tab");
  const tab: SourceTab = requestedTab === "watchlist" ? "watchlist" : requestedTab === "gaps" || requestedTab === "manage" ? "gaps" : "sources";
  const search = params.get("q") ?? "", adapter = params.get("adapter") ?? "", lifecycle = params.get("status") ?? "", tier = params.get("tier") ?? "";
  // Controls can still hold an earlier change handler while URL navigation is committing.
  function updateFilters(changes: Record<string, string>) {
    const next = new URLSearchParams(latestParams.current);
    for (const [key, value] of Object.entries(changes)) { if (value) next.set(key, value); else next.delete(key); }
    latestParams.current = next;
    setParams(next, { replace: true });
  }
  function setFilter(key: string, value: string) {
    updateFilters({ [key]: value });
  }
  function clearFilters() {
    updateFilters({ q: "", adapter: "", status: "", tier: "" });
  }
  const query = useQuery({ queryKey: ["sources"], queryFn: api.sources });
  const coverage = useQuery({ queryKey: ["source-coverage"], queryFn: api.sourceCoverage });
  const watchlist = useQuery({ queryKey: ["source-watchlist"], queryFn: api.sourceWatchlist });
  const runtime = useQuery({ queryKey: ["runtime"], queryFn: api.runtime });
  const refresh = useMutation({ mutationFn: api.refreshSources, onSuccess: () => invalidateIngestion(client), onError: () => { void invalidateIngestion(client); } });
  const readOnly = runtime.data?.mode !== "postgres" || !!runtime.error;
  const sources = query.data?.items ?? [];
  const text = search.trim().toLocaleLowerCase();
  const matchingControls = sources.filter(source => (!adapter || source.adapter === adapter) && (!lifecycle || source.lifecycleStatus === lifecycle) && (!text || [source.name, source.publisher, source.endpoint, source.contentType, ...source.topics].join(" ").toLocaleLowerCase().includes(text)));
  const filtered = matchingControls.filter(source => !tier || source.tier === tier);
  const tierCount = (value: string) => matchingControls.filter(source => source.tier === value).length;
  const adapters = [...new Set([...sources.map(source => source.adapter), ...(adapter ? [adapter] : [])])].sort();
  const lifecycles = [...new Set([...sources.map(source => source.lifecycleStatus), ...(lifecycle ? [lifecycle] : [])])].sort();
  const filtersActive = !!(search || adapter || lifecycle || tier);
  const watchSearch = params.get("wq") ?? "", watchPlatform = params.get("platform") ?? "", watchFilter = params.get("watchStatus") ?? "";
  const sourceById = new Map(sources.map(source => [source.id, source]));
  const followed = watchlist.data?.items ?? [];
  const watchRows = followed.map(item => ({ item, source: sourceById.get(item.sourceId ?? ""), status: watchStatus(item, sourceById.get(item.sourceId ?? "")) }));
  const watchText = watchSearch.trim().toLocaleLowerCase();
  const filteredWatch = watchRows.filter(({ item, status, source }) => (!watchPlatform || item.platform === watchPlatform) && (!watchFilter || status === watchFilter)
    && (!watchText || [item.name, item.handle, item.profileUrl, item.note, source?.name].join(" ").toLocaleLowerCase().includes(watchText)));
  const platforms = [...new Set(followed.map(item => item.platform))].sort();
  const statuses = [...new Set(watchRows.map(row => row.status))].sort();
  const coverageItems = coverage.data?.items ?? [];
  const gaps = coverageItems.filter(item => item.status !== "active"), covered = coverageItems.filter(item => item.status === "active");
  const tabs = [
    { value: "sources", label: query.data ? `已接入来源 · ${sources.length}` : "已接入来源" },
    { value: "watchlist", label: watchlist.data ? `关注名单 · ${followed.length}` : "关注名单" },
    { value: "gaps", label: coverage.data && gaps.length ? `覆盖盲区 · ${gaps.length}` : "覆盖盲区" },
  ] as const;
  return <div className="ns-admin-page ns-sources-page">
    <PageHeader eyebrow="Source registry" title="来源与采集状态" subtitle="登记公开 Feed 或 API，管理采集频率与生命周期。采集时间均为北京时间。"
      action={<>
        <ReaderButton icon={<ArrowSyncRegular/>} disabled={readOnly || refresh.isPending} onClick={() => refresh.mutate()}>{refresh.isPending ? "正在采集来源…" : "采集启用的来源"}</ReaderButton>
        <ReaderButton variant="primary" icon={<AddRegular/>} aria-expanded={adding} aria-controls={adding ? "ns-add-source" : undefined} disabled={readOnly} onClick={() => setAdding(value => !value)}>新增来源</ReaderButton>
      </>}/>
    {readOnly && <Notice>{runtime.data?.mode === "demo" ? "演示模式不能添加、修改或刷新来源。请使用本地 PostgreSQL 模式。" : "正在确认运行模式；确认本地数据库可用前，来源修改和刷新暂不可用。"}</Notice>}
    {refresh.error && <ErrorNotice title="刷新全部来源失败" error={refresh.error} busy={readOnly || refresh.isPending} retry={() => refresh.mutate()}/>}
    {runtime.error && <ErrorNotice title="运行环境读取失败" error={runtime.error} busy={runtime.isFetching} retry={() => void runtime.refetch()}/>}
    {refresh.isPending && <Notice>采集正在进行，请稍候。云端试用版每批最多处理100个久未刷新的来源，未包含的来源可单独刷新或稍后再采集一批。新内容将进入摘要队列；自动摘要开启且额度可用时，会消耗共享额度生成摘要。</Notice>}
    {refresh.data && <RefreshResult result={refresh.data}/>}
    {adding && <AddSourceForm disabled={readOnly || refresh.isPending} onClose={() => setAdding(false)}/>}
    <ReaderTabs label="来源管理视图" value={tab} options={tabs} onChange={value => setFilter("tab", value === "sources" ? "" : value)}>
      {tab === "sources" && <>
        <section aria-label="筛选来源" className="ns-source-filter-region">
          <div className="ns-source-filters ns-source-filters-4">
            <input aria-label="搜索来源" value={search} onChange={event => setFilter("q", event.currentTarget.value)} placeholder="名称、发布方、域名或主题"/>
            <select aria-label="来源等级" value={tier} onChange={event => setFilter("tier", event.currentTarget.value)}><option value="">全部等级 · {matchingControls.length}</option><option value="T1">T1 · {tierCount("T1")}</option><option value="T1.5">T1.5 · {tierCount("T1.5")}</option><option value="T2">T2 · {tierCount("T2")}</option></select>
            <select aria-label="适配器筛选" value={adapter} onChange={event => setFilter("adapter", event.currentTarget.value)}><option value="">全部类型</option>{adapters.map(value => <option value={value} key={value}>{sourceAdapters.find(item => item.value === value)?.label ?? value}</option>)}</select>
            <select aria-label="采集状态筛选" value={lifecycle} onChange={event => setFilter("status", event.currentTarget.value)}><option value="">全部状态</option>{lifecycles.map(value => <option value={value} key={value}>{value === "stable" ? "稳定采集" : value === "paused" ? "已暂停" : `观察中（${value}）`}</option>)}</select>
          </div>
          {query.data && <div className="ns-source-summary">
            <p role="status" aria-live="polite">{filtersActive ? "已应用筛选" : "全部已接入来源"} · 显示 {filtered.length} / {sources.length} 个来源{tier ? ` · 仅 ${tier}` : ""}{adapter ? ` · ${sourceAdapters.find(item => item.value === adapter)?.label ?? adapter}` : ""}{search ? ` · “${search}”` : ""}</p>
            {filtersActive && <ReaderButton variant="ghost" size="small" onClick={clearFilters}>清除筛选</ReaderButton>}
          </div>}
        </section>
        {query.error && <ErrorNotice title="来源列表读取失败" error={query.error} busy={query.isFetching} retry={() => void query.refetch()}/>}
        <section aria-label="来源筛选结果" className="ns-source-list">
          {query.isLoading ? <LoadingStatus>正在读取来源…</LoadingStatus> : filtered.map(source => <SourceCard key={source.id} source={source} disabled={readOnly || refresh.isPending}/>)}
          {!!sources.length && !filtered.length && !query.error && <div className="ns-empty">没有匹配的来源。可清除搜索或筛选条件。</div>}
          {query.data?.items.length === 0 && !query.error && <div className="ns-empty">尚无来源。点击“新增来源”登记一个公开的 HTTPS 订阅，刷新后即可开始阅读。</div>}
        </section>
      </>}
      {tab === "watchlist" && <section className="ns-panel" aria-label="待接入名单">
        <div className="ns-panel-head"><h2>关注名单与接入状态</h2><span className="ns-pill">{followed.length} 项</span></div>
        <p>关注意向与实际采集分开记录。关联订阅会显示真实健康状态；关注名单本身不授予 T1 / T2 等级，接入博客或节目 RSS 也不代表已监听其全部社交 / 视频内容。</p>
        <div className="ns-source-filters">
          <input aria-label="搜索关注名单" value={watchSearch} onChange={event => setFilter("wq", event.currentTarget.value)} placeholder="名称、账号、链接或接入说明"/>
          <select aria-label="关注平台" value={watchPlatform} onChange={event => setFilter("platform", event.currentTarget.value)}><option value="">全部平台</option>{platforms.map(value => <option key={value} value={value}>{watchPlatforms[value]}</option>)}</select>
          <select aria-label="关注接入状态" value={watchFilter} onChange={event => setFilter("watchStatus", event.currentTarget.value)}><option value="">全部接入状态</option>{statuses.map(value => <option key={value} value={value}>{watchStatuses[value] ?? value}</option>)}</select>
        </div>
        {!!watchlist.data && <div className="ns-source-summary">
          <p role="status">显示 {filteredWatch.length} / {followed.length} 个关注项 · {watchRows.filter(row => row.status === "active").length} 项关联订阅已采集 · 状态按实际采集结果显示</p>
          {(watchSearch || watchPlatform || watchFilter) && <ReaderButton variant="ghost" size="small" onClick={() => updateFilters({ wq: "", platform: "", watchStatus: "" })}>清除关注筛选</ReaderButton>}
        </div>}
        {watchlist.isLoading && <LoadingStatus>正在读取待接入名单…</LoadingStatus>}
        {watchlist.error && <ErrorNotice title="待接入名单读取失败" error={watchlist.error} retry={() => void watchlist.refetch()}/>}
        {query.error && <ErrorNotice title="关联订阅状态读取失败" error={query.error} retry={() => void query.refetch()}/>}
        <div className="ns-line-list">{filteredWatch.map(({ item, source, status }) => <div className="ns-line-item" key={item.id} data-watch-id={item.id} data-watch-platform={item.platform} data-watch-status={status}>
          <div>
            <strong>{item.name}{item.handle && <small> · {item.handle}</small>}</strong>
            <span>{watchPlatforms[item.platform]} · {watchStatusLabel(item, status)}{item.note ? ` · ${item.note}` : ""}</span>
            {source && <span>关联订阅：<RouterLink to={`/sources?q=${encodeURIComponent(source.name)}`}>{source.name}</RouterLink> · {source.tier} · 最近成功 {formatDate(source.lastSuccessAt)}</span>}
            {item.platform !== "x" && !!(item.documentUrls ?? []).length && <span className="ns-line-links">{(item.documentUrls ?? []).filter(url => url !== item.profileUrl && httpsUrl(url)).map((url, index) =>
              <a key={url} href={httpsUrl(url)} target="_blank" rel="noopener noreferrer">文档原始入口 {index + 1} ↗</a>)}</span>}
          </div>
          {httpsUrl(item.profileUrl ?? "") && <a className="ns-link-button" href={httpsUrl(item.profileUrl ?? "")} target="_blank" rel="noopener noreferrer">公开主页 / 入口 ↗</a>}
        </div>)}</div>
        {!!followed.length && !filteredWatch.length && <p className="ns-panel-note">没有匹配的关注项，可清除关注筛选。</p>}
        {watchlist.data?.items.length === 0 && <p className="ns-panel-note">目前没有待接入记录。</p>}
      </section>}
      {tab === "gaps" && <section className="ns-panel" aria-label="来源与领域覆盖">
        <h2>当前覆盖盲区</h2>
        <p>覆盖状态来自服务端的实际来源登记与配置检查。需要 API 授权或明确监看列表的渠道须完成相应配置；缺失凭据或未配置的渠道不会被算作已连接。</p>
        {coverage.isLoading && <LoadingStatus>正在读取来源覆盖…</LoadingStatus>}
        {coverage.error && <ErrorNotice title="来源覆盖读取失败，不能确认未配置渠道的状态" error={coverage.error} busy={coverage.isFetching} retry={() => void coverage.refetch()}/>}
        <div className="ns-line-list">{gaps.map(item => <div className="ns-line-item" key={item.id} data-coverage-status={item.status}>
          <div><strong>{item.label}</strong><span>{item.message}</span></div>
          <span className="ns-status is-warn">{item.status === "partial" ? "部分覆盖" : "待配置 / 授权"} · {item.sourceCount} 个来源</span>
        </div>)}</div>
        {coverage.data && !gaps.length && !!covered.length && <p className="ns-panel-note">当前登记的领域都已有接入来源。</p>}
        {!!covered.length && <p className="ns-coverage-covered"><strong>已覆盖</strong>{covered.map(item => `${item.label}（${item.sourceCount}）`).join("、")}</p>}
        {coverage.data?.items.length === 0 && <p className="ns-panel-note">暂未返回领域覆盖记录；不据此推断任何渠道已连接。</p>}
      </section>}
    </ReaderTabs>
  </div>;
}