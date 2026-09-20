import { Badge, Button, Field, Input, Link, Select, Spinner, Switch, Tab, TabList, Text, Textarea } from "@fluentui/react-components";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api";
import { ErrorNotice, Notice } from "../components/Feedback";
import { PageHeader } from "../components/PageHeader";
import { formatDate, httpsUrl, invalidateIngestion } from "../reader";
import { useStyles } from "../styles";
import type { IngestionResult, NewSource, Source } from "../types";
import {watchPlatforms,watchStatuses,watchStatus,watchStatusLabel} from "../source-watchlist";

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
  const styles=useStyles(),client=useQueryClient();
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
  return <details className={styles.disclosure} onToggle={event=>setOpen((event.currentTarget as HTMLDetailsElement).open)}>
    <summary>登记的 X 原帖预览</summary>
    <p className={styles.muted}>仅按登记链接读取公开原帖预览；不会自动发现主页新帖或完整时间线。保存后保留当前列表，需明确刷新该来源才会读取新登记项。</p>
    {registered.isLoading&&<Spinner size="tiny" label="正在读取登记链接…" />}
    {registered.error&&<ErrorNotice title="登记链接读取失败" error={registered.error} retry={()=>void registered.refetch()}/>}
    {registered.data&&<form onSubmit={submit} noValidate>
      <Field label="X 原帖预览（登记链接）" required validationMessage={validation} validationState={validation?"error":"none"}>
        <Textarea value={value} disabled={disabled||save.isPending} rows={5} placeholder="https://x.com/handle/status/1234567890" onChange={(_,data)=>{setValue(data.value);setValidation("");}}/>
      </Field>
      <div className={styles.actions}><Button type="submit" disabled={disabled||save.isPending}>{save.isPending?"正在保存…":"保存登记链接"}</Button><Text size={200}>1–20 条 · 同一账号 · 仅原帖链接</Text></div>
    </form>}
    {save.isSuccess&&value===save.data.urls.join("\n")&&<Notice>登记链接已保存；刷新来源后读取新登记项。</Notice>}
    {save.error&&<ErrorNotice title="登记链接保存失败" error={save.error} retry={()=>save.variables&&save.mutate(save.variables)}/>}
  </details>;
}

function RefreshResult({ result }: { result: IngestionResult }) {
  return <Notice><strong>{result.failed ? result.succeeded ? "部分来源刷新失败" : "来源刷新失败" : result.attempted ? "来源刷新完成" : "没有可刷新的来源"}</strong>：尝试 {result.attempted}，成功 {result.succeeded}，失败 {result.failed}，入库 {result.ingested} 条。{result.failed > 0 && "请查看下方来源的错误记录；已成功入库的内容仍可阅读。"}</Notice>;
}

function SourceRow({ source, disabled }: { source: Source; disabled: boolean }) {
  const styles = useStyles(), client = useQueryClient();
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
  const isXPreview=source.adapter==="x_public_preview";
  function saveInterval(event: FormEvent) {
    event.preventDefault();
    const value = Number(interval);
    if (!Number.isInteger(value) || value < 15 || value > 1440) { setValidation("采集间隔必须是 15–1440 分钟的整数。"); return; }
    setValidation("");
    update.mutate({ scheduleMinutes: value });
  }
  return <section className={styles.card} aria-label={source.name} aria-busy={update.isPending || refresh.isPending}
    data-source-id={source.id} data-source-tier={source.tier} data-source-adapter={source.adapter} data-source-status={source.lifecycleStatus}>
    <div className={styles.cardTop}>
      <div><h2 className={styles.sourceHeading}>{source.name}</h2><Text size={200}>{source.publisher}</Text></div>
      <Badge color={paused ? "informative" : source.consecutiveFailures > 0 ? "danger" : source.lifecycleStatus === "stable" ? "success" : "warning"}>{paused ? "已暂停" : source.lifecycleStatus === "stable" ? "稳定" : "观察中"}</Badge>
    </div>
    <div className={styles.meta}><Badge appearance="outline">{source.tier}</Badge><Badge appearance="tint">{source.adapter}</Badge><Badge appearance="outline">{source.contentType}</Badge><Text>{source.topics.join(" · ") || "未指定主题"}</Text></div>
    <p className={styles.summary}>{endpoint ? <Link href={endpoint} target="_blank" rel="noopener noreferrer">{isXPreview?"查看 X 主页（仅身份识别）":"查看订阅地址"}</Link> : "订阅地址不是有效的 HTTPS 链接"}</p>
    {isXPreview&&<p className={styles.summary}>仅覆盖明确登记的公开原帖预览；不会自动发现主页新帖，也不代表完整时间线。</p>}
    <p>上次成功：{formatDate(source.lastSuccessAt)}（北京时间） · 连续失败 {source.consecutiveFailures ?? 0} 次</p>
    {source.lastError && <div className={styles.error}><strong>最近采集错误</strong><span>{source.lastError}</span></div>}
    <div className={styles.actions}>
      <Switch label={paused ? "恢复采集" : "启用采集"} aria-label={`${source.name}：启用采集`} checked={!paused} disabled={busy} onChange={(_, data) => update.mutate({ enabled: data.checked })} />
      <Button disabled={busy || paused} aria-label={`刷新来源：${source.name}`} onClick={() => refresh.mutate()}>{refresh.isPending ? "正在刷新…" : "刷新来源"}</Button>
      {source.lifecycleStatus === "observing" && source.adapter !== "github_search" && <Button
        disabled={busy || !source.lastSuccessAt || source.consecutiveFailures > 0}
        aria-label={`确认来源：${source.name}`} onClick={() => update.mutate({ confirmed: true })}>确认来源为稳定</Button>}
    </div>
    <form className={styles.compactToolbar} onSubmit={saveInterval} noValidate>
      <Field label={`采集间隔（分钟） · ${source.name}`} validationMessage={validation} validationState={validation ? "error" : "none"} className={styles.field}><Input type="number" min={15} max={1440} step={1} value={interval} disabled={busy} onChange={(_, data) => { setInterval(data.value); setValidation(""); }} /></Field>
      <Button type="submit" disabled={busy || interval === String(source.scheduleMinutes)} aria-label={`保存采集间隔：${source.name}`}>{update.isPending ? "正在保存…" : "保存间隔"}</Button>
    </form>
    {isXPreview&&<XPostUrlsEditor source={source} disabled={busy}/>}
    {update.error && <ErrorNotice title={`${source.name} 修改失败`} error={update.error} busy={busy} retry={() => update.variables && update.mutate(update.variables)} />}
    {refresh.error && <ErrorNotice title={`${source.name} 刷新请求失败`} error={refresh.error} busy={busy || paused} retry={() => refresh.mutate()} />}
    {refresh.data && <RefreshResult result={refresh.data} />}
  </section>;
}

function AddSourceForm({ disabled }: { disabled: boolean }) {
  const styles = useStyles(), client = useQueryClient();
  const [name, setName] = useState(""), [endpoint, setEndpoint] = useState(""), [topic, setTopic] = useState("");
  const [interval, setInterval] = useState("60");
  const [adapter, setAdapter] = useState<NewSource["adapter"]>("rss");
  const [contentType, setContentType] = useState<NewSource["contentType"]>("blog");
  const [originalPostUrls,setOriginalPostUrls]=useState("");
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
    const xPreview=adapter==="x_public_preview";
    if(xPreview&&!isXProfileUrl(url)){setValidation("X 来源主页仅作身份识别，请填写 https://x.com/账号。");return;}
    const parsed=xPreview?parseXPostUrls(originalPostUrls,url):undefined;
    if(parsed&&"error" in parsed){setValidation(parsed.error ?? "登记链接无效。");return;}
    if (!Number.isInteger(scheduleMinutes) || scheduleMinutes < 15 || scheduleMinutes > 1440) { setValidation("采集间隔必须是 15–1440 分钟的整数。"); return; }
    setValidation("");
    add.mutate({ name: name.trim(), endpoint: url, adapter, contentType, tier: "T2", scheduleMinutes, ...(parsed?{originalPostUrls:parsed.urls}:{}), ...(topic.trim() ? { topic: topic.trim() } : {}) });
  }
  const busy = disabled || add.isPending;
  const xPreview=adapter==="x_public_preview";
  return <section className={styles.card}><h2>添加订阅来源</h2><p>{xPreview?"X 仅支持手动登记的公开原帖预览：主页只作身份识别，不自动发现新帖或读取完整时间线。":"新来源默认归为 T2，进入观察状态；健康的观察来源是否参与简报由设置决定。确认来源只改变生命周期，不提升等级或自动授予官方身份。仅填写受支持的公开 Feed / API 地址，不要填写密钥、密码或私有访问令牌。实际调度还受适配器最低间隔和上游退避限制。"}</p>
    <form onSubmit={submit} noValidate aria-busy={add.isPending}>
      <div className={styles.formGrid}>
        <Field label="来源名称" required><Input value={name} disabled={busy} onChange={(_, data) => setName(data.value)} /></Field>
        <Field label={xPreview?"X 主页（仅作身份识别）":"HTTPS 订阅地址"} required><Input type="url" value={endpoint} disabled={busy} placeholder={xPreview?"https://x.com/handle":"https://example.com/feed.xml"} onChange={(_, data) => setEndpoint(data.value)} /></Field>
        <Field label="采集适配器"><Select value={adapter} disabled={busy} onChange={(_, data) => { const selected = sourceAdapters.find(item => item.value === data.value); if (selected) { setAdapter(selected.value); setContentType(selected.contentType); if(selected.value==="x_public_preview")setInterval("1440"); } }}>{sourceAdapters.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</Select></Field>
        <Field label="内容类型"><Select value={contentType} disabled={busy||xPreview} onChange={(_, data) => setContentType(data.value as NewSource["contentType"])}><option value="blog">{xPreview?"帖子预览（文章存储）":"博客 / 文章"}</option><option value="release">版本发布</option><option value="podcast">播客</option><option value="paper">论文</option><option value="model">模型元数据</option><option value="repository">仓库 / 发现候选</option></Select></Field>
        <Field label="采集间隔（分钟）" required><Input type="number" min={15} max={1440} step={1} value={interval} disabled={busy} onChange={(_, data) => setInterval(data.value)} /></Field>
        <Field label="主题（可选）"><Input value={topic} disabled={busy} onChange={(_, data) => setTopic(data.value)} /></Field>
        {xPreview&&<Field label="X 原帖预览（登记链接）" required hint="每行一条；仅登记链接，不自动发现新帖。"><Textarea value={originalPostUrls} disabled={busy} rows={5} placeholder={"https://x.com/handle/status/1234567890\nhttps://x.com/handle/status/1234567891"} onChange={(_,data)=>setOriginalPostUrls(data.value)} /></Field>}
      </div>
      {validation && <div role="alert" className={styles.error}>{validation}</div>}
      <div className={styles.actions}><Button type="submit" appearance="primary" disabled={busy}>{add.isPending ? "正在添加…" : "添加来源"}</Button><Badge appearance="outline">默认 T2 · 非官方认证</Badge></div>
    </form>
    {add.error && <ErrorNotice title="添加来源失败，请检查输入后重试" error={add.error} />}
    {add.isSuccess && <Notice>来源已添加。点击“刷新来源”或“刷新全部来源”开始采集。</Notice>}
  </section>;
}

export function SourcesPage() {
  const styles = useStyles(), client = useQueryClient();
  const [params,setParams]=useSearchParams();
  const latestParams=useRef(params);
  useLayoutEffect(()=>{latestParams.current=params;},[params]);
  const tab=params.get("tab")==="watchlist"?"watchlist":params.get("tab")==="manage"?"manage":"sources";
  const search=params.get("q")??"",adapter=params.get("adapter")??"",lifecycle=params.get("status")??"",tier=params.get("tier")??"";
  // Controls can still hold an earlier change handler while URL navigation is committing.
  function updateFilters(changes:Record<string,string>) {
    const next=new URLSearchParams(latestParams.current);
    for(const [key,value] of Object.entries(changes)){if(value)next.set(key,value);else next.delete(key);}
    latestParams.current=next;
    setParams(next,{replace:true});
  }
  function setFilter(key:string,value:string) {
    updateFilters({[key]:value});
  }
  function clearFilters() {
    updateFilters({q:"",adapter:"",status:"",tier:""});
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
  const watchSearch=params.get("wq")??"",watchPlatform=params.get("platform")??"",watchFilter=params.get("watchStatus")??"";
  const sourceById=new Map(sources.map(source=>[source.id,source]));
  const followed=watchlist.data?.items??[];
  const watchRows=followed.map(item=>({item,source:sourceById.get(item.sourceId??""),status:watchStatus(item,sourceById.get(item.sourceId??""))}));
  const watchText=watchSearch.trim().toLocaleLowerCase();
  const filteredWatch=watchRows.filter(({item,status,source})=>(!watchPlatform||item.platform===watchPlatform)&&(!watchFilter||status===watchFilter)
    &&(!watchText||[item.name,item.handle,item.profileUrl,item.note,source?.name].join(" ").toLocaleLowerCase().includes(watchText)));
  const platforms=[...new Set(followed.map(item=>item.platform))].sort();
  const statuses=[...new Set(watchRows.map(row=>row.status))].sort();
  return <>
    <PageHeader eyebrow="Source Registry" title="来源与采集状态" subtitle="仅登记原始发布者、作者或项目的公开 Feed / API；不接入第三方聚合改写。这里显示真实订阅与采集状态，所有采集时间均为北京时间。" action={<Button appearance="primary" disabled={readOnly || refresh.isPending} onClick={() => refresh.mutate()}>{refresh.isPending ? "正在刷新全部来源…" : "刷新全部来源"}</Button>} />
    {readOnly && <Notice>{runtime.data?.mode === "demo" ? "演示模式不能添加、修改或刷新来源。请使用本地 PostgreSQL 模式。" : "正在确认运行模式；确认本地数据库可用前，来源修改和刷新暂不可用。"}</Notice>}
    {refresh.error && <ErrorNotice title="刷新全部来源失败" error={refresh.error} busy={readOnly || refresh.isPending} retry={() => refresh.mutate()} />}
    {runtime.error && <ErrorNotice title="运行环境读取失败" error={runtime.error} busy={runtime.isFetching} retry={() => void runtime.refetch()} />}
    {refresh.isPending && <Notice>采集正在进行，请稍候。新内容将进入摘要队列；自动摘要开启且账户、模型和额度可用时，会消耗所选账户的 Copilot 用量生成摘要。</Notice>}
    {refresh.data && <RefreshResult result={refresh.data} />}
    <TabList aria-label="来源管理视图" selectedValue={tab} onTabSelect={(_,data)=>setFilter("tab",String(data.value)==="sources"?"":String(data.value))}>
      <Tab value="sources">已接入来源{query.data?` · ${sources.length}`:""}</Tab>
      <Tab value="watchlist">关注名单</Tab>
      <Tab value="manage">覆盖与管理</Tab>
    </TabList>
    <div className={styles.grid}>
      {tab==="sources"&&<>
      <section aria-label="筛选来源">
        <div className={styles.toolbar}>
          <Field className={styles.filterControl} label="搜索来源"><Input value={search} onChange={(_, data) => setFilter("q",data.value)} placeholder="名称、发布方、域名或主题" /></Field>
          <Field className={styles.filterControl} label="来源等级"><Select value={tier} onChange={(_, data) => setFilter("tier",data.value)}><option value="">全部等级 · {matchingControls.length}</option><option value="T1">T1 · {tierCount("T1")}</option><option value="T1.5">T1.5 · {tierCount("T1.5")}</option><option value="T2">T2 · {tierCount("T2")}</option></Select></Field>
          <Field className={styles.filterControl} label="适配器筛选"><Select value={adapter} onChange={(_, data) => setFilter("adapter",data.value)}><option value="">全部适配器</option>{adapters.map(value => <option value={value} key={value}>{sourceAdapters.find(item => item.value === value)?.label ?? value}</option>)}</Select></Field>
          <Field className={styles.filterControl} label="采集状态筛选"><Select value={lifecycle} onChange={(_, data) => setFilter("status",data.value)}><option value="">全部状态</option>{lifecycles.map(value => <option value={value} key={value}>{value === "stable" ? "稳定" : value === "paused" ? "已暂停" : `观察中（${value}）`}</option>)}</Select></Field>
          {(search || adapter || lifecycle || tier) && <Button className={styles.filterButton} onClick={clearFilters}>清除筛选</Button>}
        </div>
        {query.data && <p role="status" aria-live="polite">{search||tier||adapter||lifecycle?"已应用筛选":"全部已接入来源"} · 显示 {filtered.length} / {sources.length} 个来源{tier?` · 仅 ${tier}`:""}{adapter?` · ${sourceAdapters.find(item=>item.value===adapter)?.label??adapter}`:""}{search?` · “${search}”`:""}</p>}
      </section>
      {query.error && <ErrorNotice title="来源列表读取失败" error={query.error} busy={query.isFetching} retry={() => void query.refetch()} />}
      <section aria-label="来源筛选结果" className={styles.grid}>
        {query.isLoading ? <Spinner label="正在读取来源…" /> : filtered.map(source => <SourceRow key={source.id} source={source} disabled={readOnly || refresh.isPending} />)}
        {!!sources.length && !filtered.length && !query.error && <div className={styles.empty}>没有匹配的来源。可清除搜索或筛选条件。</div>}
        {query.data?.items.length === 0 && !query.error && <div className={styles.empty}>尚无来源。添加一个公开的 HTTPS 订阅后刷新，即可开始阅读。</div>}
      </section>
      </>}
      {tab==="watchlist"&&
      <section className={styles.watchlist} aria-label="待接入名单">
        <div className={styles.sectionHeader}><div><h2>关注名单与接入状态</h2><p className={styles.muted}>关注意向与实际采集分开记录。关联订阅会显示真实健康状态；关注名单本身不授予 T1 / T2 等级，接入博客或节目 RSS 也不代表已监听其全部社交 / 视频内容。资料目录仅作参考，不把聚合整理当作原始新闻。</p></div><Badge className={styles.watchlistCount} appearance="outline">{followed.length} 项</Badge></div>
        <div className={styles.toolbar}>
          <Field className={styles.filterControl} label="搜索关注名单"><Input value={watchSearch} onChange={(_,data)=>setFilter("wq",data.value)} placeholder="名称、账号、链接或接入说明"/></Field>
          <Field className={styles.filterControl} label="关注平台"><Select value={watchPlatform} onChange={(_,data)=>setFilter("platform",data.value)}><option value="">全部平台</option>{platforms.map(value=><option key={value} value={value}>{watchPlatforms[value]}</option>)}</Select></Field>
          <Field className={styles.filterControl} label="关注接入状态"><Select value={watchFilter} onChange={(_,data)=>setFilter("watchStatus",data.value)}><option value="">全部接入状态</option>{statuses.map(value=><option key={value} value={value}>{watchStatuses[value]??value}</option>)}</Select></Field>
          {(watchSearch||watchPlatform||watchFilter)&&<Button className={styles.filterButton} onClick={()=>updateFilters({wq:"",platform:"",watchStatus:""})}>清除关注筛选</Button>}
        </div>
        {!!watchlist.data&&<p role="status">显示 {filteredWatch.length} / {followed.length} 个关注项 · {watchRows.filter(row=>row.status==="active").length} 项关联订阅已采集 · 状态按实际采集结果显示</p>}
        {watchlist.isLoading && <Spinner size="small" label="正在读取待接入名单…" />}
        {watchlist.error && <ErrorNotice title="待接入名单读取失败" error={watchlist.error} retry={() => void watchlist.refetch()} />}
        {query.error&&<ErrorNotice title="关联订阅状态读取失败" error={query.error} retry={()=>void query.refetch()}/>}
        {filteredWatch.map(({item,source,status}) => <div className={styles.watchlistItem} key={item.id} data-watch-id={item.id} data-watch-platform={item.platform} data-watch-status={status}>
          <div><strong>{item.name}</strong>{item.handle && <Text size={200}> · {item.handle}</Text>}
            <div className={styles.muted}>{watchPlatforms[item.platform]} · {watchStatusLabel(item,status)}{item.note ? ` · ${item.note}` : ""}</div>
            {source&&<div className={styles.muted}>关联订阅：<Link href={`/sources?q=${encodeURIComponent(source.name)}`}>{source.name}</Link> · {source.tier} · 最近成功 {formatDate(source.lastSuccessAt)}</div>}
            {item.platform!=="x"&&<div className={styles.actions}>{(item.documentUrls??[]).filter(url=>url!==item.profileUrl&&httpsUrl(url)).map((url,index)=>
              <Link key={url} href={httpsUrl(url)} target="_blank" rel="noopener noreferrer">文档原始入口 {index+1} ↗</Link>)}</div>}
          </div>
          {httpsUrl(item.profileUrl ?? "") && <Link href={httpsUrl(item.profileUrl ?? "")} target="_blank" rel="noopener noreferrer">公开主页 / 入口 ↗</Link>}
        </div>)}
        {!!followed.length&&!filteredWatch.length&&<p className={styles.muted}>没有匹配的关注项，可清除关注筛选。</p>}
        {watchlist.data?.items.length === 0 && <p className={styles.muted}>目前没有待接入记录。</p>}
      </section>}
      {tab==="manage"&&<>
        <section className={styles.card} aria-label="来源与领域覆盖">
          <h2>来源与领域覆盖</h2>
          <p className={styles.summary}>覆盖状态来自服务端的实际来源登记与配置检查，不代表所有渠道均已接入。需要 API 授权或明确监看列表的渠道，仍须完成相应配置；不会把缺失凭据或未配置的渠道算作已连接。</p>
          {coverage.isLoading && <Spinner size="small" label="正在读取来源覆盖…" />}
          {coverage.error && <ErrorNotice title="来源覆盖读取失败，不能确认未配置渠道的状态" error={coverage.error} busy={coverage.isFetching} retry={() => void coverage.refetch()} />}
          {coverage.data?.items.map(item => <div key={item.id} className={styles.evidence}>
            <div className={styles.meta}><strong>{item.label}</strong><Badge color={item.status === "active" ? "success" : "warning"} appearance="tint">{item.status === "active" ? "已覆盖" : item.status === "partial" ? "部分覆盖" : "待配置 / 授权"}</Badge><Text size={200}>{item.sourceCount} 个登记来源</Text></div>
            <p className={styles.summary}>{item.message}</p>
          </div>)}
          {coverage.data?.items.length === 0 && <p>暂未返回领域覆盖记录；不据此推断任何渠道已连接。</p>}
        </section>
        <AddSourceForm disabled={readOnly || refresh.isPending} />
      </>}
    </div>
  </>;
}
