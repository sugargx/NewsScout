import { zipSync, strToU8 } from "fflate";
import type { ShareDocument, ShareEditor } from "./types";

export interface Card { canvas:HTMLCanvasElement; label:string }
const font='"Segoe UI", Aptos, Calibri, "Microsoft YaHei", sans-serif';
function sourceDate(value:string|null) {
  return value?new Intl.DateTimeFormat("zh-CN",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(value)):"来源未提供日期";
}
export function postCaption(document:ShareDocument,editor:ShareEditor) {
  const selected=editor.items.filter(item=>item.selected);
  return `${editor.title}\n\n${editor.subtitle}\n\n${selected.map((item,index)=>`${index+1}. ${item.title}\n来源日期：${sourceDate(document.items[item.index].publishedAt)}\n${item.summary}`).join("\n\n")}\n\n${editor.cta}\n\n原始出处：\n${selected.map(item=>document.items[item.index].sources.map(source=>`${source.name} ${source.url}`).join("\n")).join("\n")}\n\n摘要与阅读笔记整理，发布前请核对原文。\n#NewsScout #AI资讯 #AI工具 #信息整理`;
}
export function initialEditor(document:ShareDocument):ShareEditor {
  const editor:ShareEditor={title:document.kind==="event"?document.items[0].title:document.kind==="week"?"这一周，AI 有哪些值得跟进的变化":"今天，AI 有哪些值得关注的变化",
    subtitle:document.kind==="event"?"一篇值得继续读的原始报道":"不追逐信息量，只留下值得阅读的线索",
    cta:"用 NewsScout，从原始来源跟进 AI 动态。",caption:"",format:"portrait",theme:"light",
    items:document.items.map((item,index)=>({index,title:item.title,summary:item.summary,selected:index<5}))};
  editor.caption=postCaption(document,editor);
  return editor;
}
function lines(context:CanvasRenderingContext2D,text:string,width:number):string[] {
  const result:string[]=[];
  for(const paragraph of text.split("\n")) {
    let current="";
    for(const character of Array.from(paragraph)) {
      if(current && context.measureText(current+character).width>width) {result.push(current);current=character;}
      else current+=character;
    }
    result.push(current);
  }
  return result;
}
function write(context:CanvasRenderingContext2D,textLines:string[],x:number,y:number,height:number) {
  textLines.forEach((line,index)=>context.fillText(line,x,y+index*height));
}
function fitted(context:CanvasRenderingContext2D,text:string,width:number,maxLines:number,size:number,min:number) {
  let wrapped:string[]=[];
  for(;size>=min;size-=2) {context.font=`700 ${size}px ${font}`;wrapped=lines(context,text,width);if(wrapped.length<=maxLines)break;}
  if(size<min)throw new Error("标题太长，无法完整放进卡片。请缩短标题后导出。");
  return {wrapped,size};
}
export function renderCards(document:ShareDocument,editor:ShareEditor,palette:CSSStyleDeclaration):Card[] {
  if(!editor.title.trim())throw new Error("请填写封面标题。");
  const selected=editor.items.filter(item=>item.selected);
  if(!selected.length)throw new Error("至少选择一篇文章，才能制作卡片。");
  const color=(name:string)=>{const value=palette.getPropertyValue(`--cp-${name}`).trim();if(!value)throw new Error("分享主题尚未加载。");return value;};
  const W=1080,H=editor.format==="portrait"?1440:1080,pad=76,width=W-pad*2;
  const cards:Card[]=[];
  const frame=(label:string)=>{
    const canvas=window.document.createElement("canvas");canvas.width=W;canvas.height=H;
    const ctx=canvas.getContext("2d");if(!ctx)throw new Error("当前浏览器无法生成分享图片。");
    ctx.fillStyle=color("bg");ctx.fillRect(0,0,W,H);ctx.textBaseline="top";
    ctx.fillStyle=color("accent");ctx.fillRect(pad,72,38,8);ctx.font=`700 27px ${font}`;ctx.fillText("NewsScout.",pad+54,56);
    ctx.fillStyle=color("text-muted");ctx.font=`20px ${font}`;ctx.textAlign="right";ctx.fillText(document.date,W-pad,60);ctx.textAlign="left";
    cards.push({canvas,label});return ctx;
  };
  const footer=(ctx:CanvasRenderingContext2D,note:string)=>{
    ctx.strokeStyle=color("border");ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(pad,H-132);ctx.lineTo(W-pad,H-132);ctx.stroke();
    ctx.fillStyle=color("text-muted");ctx.font=`22px ${font}`;
    const footerLines=lines(ctx,note,width-100);
    if(footerLines.length>2) {ctx.font=`18px ${font}`;write(ctx,lines(ctx,note,width-100),pad,H-105,26);}
    else write(ctx,footerLines,pad,H-105,30);
  };
  const cover=frame("封面");
  cover.fillStyle=color("accent-soft");cover.beginPath();cover.arc(W-140,H-440,240,0,Math.PI*2);cover.fill();
  cover.strokeStyle=color("accent");cover.lineWidth=2;cover.beginPath();cover.arc(W-190,H-410,220,0,Math.PI*2);cover.stroke();
  cover.fillStyle=color("accent");cover.font=`700 24px ${font}`;
  cover.fillText(document.kind==="week"?"THE WEEKLY EDIT":document.kind==="event"?"ONE STORY, WORTH READING":"THE DAILY EDIT",pad,198);
  const heading=fitted(cover,editor.title,width,6,82,42);
  cover.fillStyle=color("text");write(cover,heading.wrapped,pad,272,heading.size*1.35);
  const subtitleY=272+heading.wrapped.length*heading.size*1.35+36;
  cover.font=`28px ${font}`;cover.fillStyle=color("text-muted");const subtitleLines=lines(cover,editor.subtitle,width);
  if(subtitleY+subtitleLines.length*42>H-300)throw new Error("封面文字过多，请缩短标题或副标题。");
  write(cover,subtitleLines,pad,subtitleY,42);
  cover.fillStyle=color("accent");cover.font=`800 108px ${font}`;cover.fillText(String(selected.length).padStart(2,"0"),pad,H-315);
  cover.font=`26px ${font}`;cover.fillStyle=color("text");cover.fillText(selected.length===1?"篇原始报道":"篇精选阅读",pad+160,H-236);
  footer(cover,"原始来源 · 清晰摘要 · 值得继续读");
  selected.forEach((item,index)=>{
    if(!item.title.trim())throw new Error(`第 ${index+1} 篇文章缺少标题。`);
    let ctx=frame(`阅读 ${index+1}`),part=0;
    const title=fitted(ctx,item.title,width,5,52,36);
    const bodyY=238+title.wrapped.length*title.size*1.35+30;
    const rowHeight=52,bodyRows=Math.floor((H-234-bodyY)/rowHeight);
    if(bodyRows<3)throw new Error(`第 ${index+1} 篇标题过长，请缩短后导出。`);
    ctx.font=`36px ${font}`;const remaining=lines(ctx,item.summary||"请前往原始出处阅读全文。",width);
    while(remaining.length) {
      if(part>0)ctx=frame(`阅读 ${index+1} · 续 ${part}`);
      ctx.fillStyle=color("accent");ctx.font=`700 24px ${font}`;ctx.fillText(`${String(index+1).padStart(2,"0")} / ${String(selected.length).padStart(2,"0")}${part?" · CONTINUED":""}`,pad,166);
      ctx.fillStyle=color("text");ctx.font=`700 ${title.size}px ${font}`;write(ctx,title.wrapped,pad,238,title.size*1.35);
      ctx.font=`36px ${font}`;write(ctx,remaining.splice(0,bodyRows),pad,bodyY,rowHeight);
      ctx.font=`20px ${font}`;ctx.fillStyle=color("text-muted");
      const source=document.items[item.index],attribution=source.sources.map(item=>item.name).join(" · ");
      const sourceLines=lines(ctx,`来源：${attribution}`,width);
      if(sourceLines.length>2) {
        write(ctx,lines(ctx,`${source.sources.length} 个原始出处（完整署名与链接见文案）`,width),pad,H-213,28);
      } else write(ctx,sourceLines,pad,H-213,28);
      footer(ctx,`${source.summaryKind==="copilot"?"AI 摘要 / 阅读笔记":"原文阅读提示"} · 来源日期 ${sourceDate(source.publishedAt)}`);
      part++;
      if(cards.length>60)throw new Error("文字生成了超过60张卡片，请减少选文或缩短内容。");
    }
  });
  const ending=frame("尾页");
  ending.fillStyle=color("accent");ending.font=`700 24px ${font}`;ending.fillText("LESS NOISE. MORE SIGNAL.",pad,225);
  ending.fillStyle=color("text");const endHeading=fitted(ending,"把注意力，\n留给真正重要的事。",width,4,78,44);
  write(ending,endHeading.wrapped,pad,310,endHeading.size*1.4);
  ending.fillStyle=color("text-muted");ending.font=`32px ${font}`;
  write(ending,lines(ending,editor.cta,width),pad,H-440,48);
  ending.fillStyle=color("accent");ending.font=`800 52px ${font}`;ending.fillText("NewsScout.",pad,H-245);
  footer(ending,"个人阅读工具 · 原始出处收录在配套文案中");
  cards.forEach(({canvas},index)=>{
    const ctx=canvas.getContext("2d")!;ctx.fillStyle=color("text-muted");ctx.font=`20px ${font}`;
    ctx.textAlign="right";ctx.fillText(`${String(index+1).padStart(2,"0")} / ${String(cards.length).padStart(2,"0")}`,W-pad,H-102);
  });
  return cards;
}
function png(canvas:HTMLCanvasElement):Promise<Blob> {
  return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error("图片编码失败，请重试。")),"image/png"));
}
export function download(blob:Blob,name:string) {
  const url=URL.createObjectURL(blob),anchor=window.document.createElement("a");
  anchor.href=url;anchor.download=name;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),10000);
}
export async function downloadCard(card:Card,index:number) {
  download(await png(card.canvas),`NewsScout-${String(index+1).padStart(2,"0")}.png`);
}
export async function downloadBundle(cards:Card[],editor:ShareEditor,date:string) {
  const files:Record<string,Uint8Array>={};
  for(let index=0;index<cards.length;index++) {
    files[`${String(index+1).padStart(2,"0")}-${index===0?"cover":index===cards.length-1?"closing":"reading"}.png`]=new Uint8Array(await (await png(cards[index].canvas)).arrayBuffer());
  }
  files["post.txt"]=strToU8(editor.caption);
  const archive=zipSync(files,{level:0});
  download(new Blob([new Uint8Array(archive).buffer],{type:"application/zip"}),`NewsScout-${date}.zip`);
}
