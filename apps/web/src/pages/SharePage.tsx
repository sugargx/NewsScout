import { Button, Checkbox, Field, Input, Select, Spinner, Textarea } from "@fluentui/react-components";
import { ArrowDownloadRegular, CopyRegular, SaveRegular } from "@fluentui/react-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import { ErrorNotice } from "../components/Feedback";
import { downloadBundle, downloadCard, initialEditor, postCaption, renderCards } from "../sharing";
import type { Card } from "../sharing";
import type { SharedEdition, ShareEditor } from "../types";
import "../share-studio.css";

export function SharePage() {
  const {id=""}=useParams();
  const query=useQuery({queryKey:["share",id],queryFn:()=>api.share(id),enabled:!!id});
  if(query.error)return <ErrorNotice title="分享草稿未能打开" error={query.error} retry={()=>void query.refetch()}/>;
  if(!query.data)return <Spinner label="正在布置分享工作台…" />;
  return <ShareStudio key={id} share={query.data}/>;
}
function ShareStudio({share}:{share:SharedEdition}) {
  const client=useQueryClient(),document=share.document;
  const [editor,setEditor]=useState(()=>share.editor??initialEditor(document));
  const [tab,setTab]=useState("cover"),[slide,setSlide]=useState(0),[cards,setCards]=useState<Card[]>([]),[renderError,setRenderError]=useState<unknown>(null);
  const [operationError,setOperationError]=useState<unknown>(null),[notice,setNotice]=useState(""),[exporting,setExporting]=useState(false);
  const palette=useRef<HTMLDivElement>(null),preview=useRef<HTMLDivElement>(null),renderGeneration=useRef(0);
  const [rendering,setRendering]=useState(true);
  const saved=share.editor??initialEditor(document),dirty=!share.editor||JSON.stringify(editor)!==JSON.stringify(saved);
  const save=useMutation({mutationFn:(draft:ShareEditor)=>api.saveShareDraft(share.id,draft),
    onSuccess:async updated=>{
      client.setQueryData(["share",share.id],updated);
      await client.invalidateQueries({queryKey:["share-drafts"]});
      setNotice("草稿已保存到本地阅读库。");
    }});
  const update=<K extends keyof ShareEditor>(key:K,value:ShareEditor[K])=>setEditor(old=>{
    const next={...old,[key]:value};
    return key!=="caption" && old.caption===postCaption(document,old)?{...next,caption:postCaption(document,next)}:next;
  });
  useEffect(()=>{
    setRendering(true);const generation=++renderGeneration.current;
    const timer=setTimeout(()=>{
      void window.document.fonts.ready.then(()=>{
        if(generation!==renderGeneration.current||!palette.current)return;
        try {
          const result=renderCards(document,editor,getComputedStyle(palette.current));
          setCards(result);setSlide(current=>Math.min(current,result.length-1));setRenderError(null);
        } catch(error) {setRenderError(error);setCards([]);}
        setRendering(false);
      });
    },160);
    return ()=>{clearTimeout(timer);renderGeneration.current++;};
  },[document,editor]);
  useEffect(()=>{const canvas=cards[slide]?.canvas;if(canvas&&preview.current)preview.current.replaceChildren(canvas);else preview.current?.replaceChildren();},[cards,slide]);
  async function exportImages(all:boolean) {
    setExporting(true);setOperationError(null);setNotice("");
    try {
      await save.mutateAsync(editor);
      if(all)await downloadBundle(cards,editor,document.date);else await downloadCard(cards[slide],slide);
      setNotice(all?"整套素材已下载：按编号排列的 PNG 图片 + post.txt 文案。尚未发布到任何平台。":"当前卡片已下载为 PNG。");
    } catch(error){setOperationError(error);}
    finally{setExporting(false);}
  }
  async function copyCaption() {
    setOperationError(null);
    try {await navigator.clipboard.writeText(editor.caption);setNotice("文案已复制；请检查原文与表述后粘贴发布。");}
    catch(error){setOperationError(error);}
  }
  const selected=editor.items.filter(item=>item.selected).length;
  const busy=exporting||save.isPending;
  return <div className="ns-studio">
    <div className="ns-studio-heading"><div><Link to="/shares" className="ns-studio-back">← 本地草稿库</Link><p className="ns-studio-kicker">CREATE SOMETHING WORTH SHARING</p><h1>让好内容，<span>被更多人看见。</span></h1><p>把一篇报道或一份简报，整理成小红书图文。先预览，再导出，由你决定发布。</p></div><span className="ns-local-badge">LOCAL STUDIO · 本地草稿</span></div>
    <div className="ns-studio-command"><div><span className="ns-studio-dot"/><strong>{selected} 篇选文</strong><span>→</span><span>{cards.length||"—"} 张卡片</span><span className="ns-save-state">{dirty?"有未保存修改":"草稿已同步"}</span></div>
      <div><Button icon={<SaveRegular/>} disabled={busy||!dirty} onClick={()=>save.mutate(editor)}>保存草稿</Button><Button appearance="primary" icon={<ArrowDownloadRegular/>} disabled={busy||rendering||!cards.length} onClick={()=>void exportImages(true)}>{exporting?"正在打包…":"导出整套素材"}</Button></div></div>
    {notice&&<div role="status" className="ns-studio-status">{notice}</div>}
    {save.error&&<ErrorNotice title="草稿未保存" error={save.error}/>}
    {operationError!==null&&<ErrorNotice title="操作未完成" error={operationError}/>}
    <div className="ns-studio-layout">
      <section className="ns-studio-editor" aria-label="分享内容编辑">
        <div className="ns-studio-tabs" role="tablist" aria-label="分享编辑步骤">{[["cover","01 封面"],["stories","02 选文"],["caption","03 文案"]].map(([value,label])=><button type="button" role="tab" aria-selected={tab===value} key={value} onClick={()=>setTab(value)}>{label}</button>)}</div>
        {tab==="cover"&&<div className="ns-studio-fields">
          <div><h2>第一眼，就想继续读。</h2><p>封面不是摘要的缩小版。用一个清晰的标题，让读者知道为什么值得点开。</p></div>
          <Field label="封面标题" hint={`${Array.from(editor.title).length} / 120`}><Textarea value={editor.title} maxLength={120} resize="vertical" rows={3} onChange={(_,data)=>update("title",data.value)}/></Field>
          <Field label="一句话副标题"><Textarea value={editor.subtitle} maxLength={120} rows={2} onChange={(_,data)=>update("subtitle",data.value)}/></Field>
          <div className="ns-studio-two"><Field label="画面比例"><Select value={editor.format} onChange={(_,data)=>update("format",data.value==="square"?"square":"portrait")}><option value="portrait">竖版 3:4 · 1080 × 1440</option><option value="square">方形 1:1 · 1080 × 1080</option></Select></Field><Field label="卡片主题"><Select value={editor.theme} onChange={(_,data)=>update("theme",data.value==="dark"?"dark":"light")}><option value="light">暖白编辑部</option><option value="dark">炭黑夜读</option></Select></Field></div>
          <Field label="尾页引导语" hint="这个 POC 不放二维码，也不会声称产品已有公网入口。"><Textarea value={editor.cta} maxLength={100} rows={3} onChange={(_,data)=>update("cta",data.value)}/></Field>
          <div className="ns-studio-tip"><strong>一套可以直接使用的素材</strong><p>封面 → 原文摘要卡 → 产品尾页。长摘要会自动续页，不把文字挤成看不清的小字。</p></div>
        </div>}
        {tab==="stories"&&<div className="ns-studio-fields"><div><h2>少一点堆砌，多一点判断。</h2><p>默认选前五篇。取消不需要的内容，也可以修改卡片标题和正文；原始出处会保留。</p></div>
          {editor.items.map((item,index)=><section className="ns-studio-story" key={item.index}><Checkbox checked={item.selected} label={`${String(index+1).padStart(2,"0")} · ${document.items[index].title}`} onChange={(_,data)=>update("items",editor.items.map((entry,i)=>i===index?{...entry,selected:data.checked===true}:entry))}/>
            {item.selected&&<><Field label={`第 ${index+1} 篇标题`}><Input value={item.title} maxLength={200} onChange={(_,data)=>update("items",editor.items.map((entry,i)=>i===index?{...entry,title:data.value}:entry))}/></Field><Field label={`第 ${index+1} 篇卡片正文`}><Textarea value={item.summary} maxLength={4000} rows={6} resize="vertical" onChange={(_,data)=>update("items",editor.items.map((entry,i)=>i===index?{...entry,summary:data.value}:entry))}/></Field></>}
            <div className="ns-studio-source">{document.items[index].sources.map(source=><a key={source.url} href={source.url} target="_blank" rel="noopener noreferrer">{source.name} ↗</a>)}</div></section>)}
        </div>}
        {tab==="caption"&&<div className="ns-studio-fields"><div><h2>图文之外，也留下你的声音。</h2><p>按当前选文生成一版文案，然后改成自己的表达。图片不会自动发帖，账号也不需要授权。</p></div>
          <Button onClick={()=>{update("caption",postCaption(document,editor));setNotice("已按当前选文重新生成文案。");}}>按当前选文重新生成文案</Button>
          <Field label="小红书发帖文案" hint={`${Array.from(editor.caption).length} 字 · 包含原始出处；发布前请自行调整标题、字数和标签。`}><Textarea value={editor.caption} maxLength={12000} rows={19} resize="vertical" onChange={(_,data)=>update("caption",data.value)}/></Field>
          <Button appearance="primary" icon={<CopyRegular/>} onClick={()=>void copyCaption()}>复制发帖文案</Button>
        </div>}
      </section>
      <section className="ns-studio-preview" aria-label="分享卡片预览">
        <div className="ns-studio-preview-heading"><span>LIVE PREVIEW</span><span>{rendering?"正在排版…":`${editor.format==="portrait"?"1080 × 1440":"1080 × 1080"} · PNG`}</span></div>
        <div className="ns-card-stage">
          {renderError!==null&&<ErrorNotice title="卡片需要调整" error={renderError}/>}
          <div ref={palette} className={`ns-export-palette ns-export-${editor.theme}`} aria-hidden="true"/>
          <div ref={preview} className="ns-card-canvas" role="img" aria-label={`分享卡片预览：${cards[slide]?.label??"排版中"}`} aria-busy={rendering}/>
        </div>
        <div className="ns-slide-navigation"><Button size="small" aria-label="上一张卡片" disabled={slide===0} onClick={()=>setSlide(slide-1)}>←</Button><strong>{cards[slide]?.label??"预览"} <span>{cards.length?`${slide+1} / ${cards.length}`:""}</span></strong><Button size="small" aria-label="下一张卡片" disabled={slide>=cards.length-1} onClick={()=>setSlide(slide+1)}>→</Button></div>
        <div className="ns-card-thumbnails" aria-label="卡片导航">{cards.map((card,index)=><button type="button" key={index} aria-label={`预览第 ${index+1} 张：${card.label}`} aria-pressed={slide===index} onClick={()=>setSlide(index)}><span>{String(index+1).padStart(2,"0")}</span>{card.label}</button>)}</div>
        <Button icon={<ArrowDownloadRegular/>} disabled={busy||rendering||!cards.length} onClick={()=>void exportImages(false)}>下载当前卡片</Button>
        <p className="ns-studio-footnote">导出 ZIP 内含有序 PNG 与文案文本；不会包含账户、收藏、推荐分，也不会自动发布。公网链接与二维码留到后续 devtunnel 阶段。</p>
      </section>
    </div>
  </div>;
}
