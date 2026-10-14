import { useLayoutEffect, useRef, useState } from "react";
import type { Event } from "../types";
import { summaryPresentation } from "../summary-presentation";
import { summaryLineCount, validSummaryVisual } from "../summary-visual";
import { SummaryVisual } from "./SummaryVisual";
import "../summary-content.css";

export function compactSummaryPoints(points:string[],limit=240) {
  let remaining=limit;
  return points.slice(0,2).flatMap(point=>{
    if(remaining<=0)return [];
    if(point.length<=remaining) {remaining-=point.length;return [point];}
    const clipped=`${point.slice(0,Math.max(0,remaining-1)).trimEnd()}…`;
    remaining=0;
    return clipped.length>1?[clipped]:[];
  });
}

type SummaryEvent = Pick<Event,"summary"|"summaryKind"|"summaryPoints"|"summaryMaterialLimit"|"summaryLimitations"|"summaryVisual"|"summaryFormatVersion"|"summaryStatus">
  & {evidence?:readonly {id:string;sourceName:string;url:string|null}[];summaryEvidenceIds?:readonly string[]};

export function SummaryContent({event,compact=false}:{event:SummaryEvent;compact?:boolean}) {
  const {points,limitations}=summaryPresentation(event);
  const pointList=useRef<HTMLUListElement>(null);
  const [longSummary,setLongSummary]=useState(false);
  const signature=points.join("\n");
  useLayoutEffect(()=>{
    const element=pointList.current;
    if(compact||!element) {setLongSummary(false);return;}
    const measure=()=>setLongSummary(summaryLineCount(element)>5);
    measure();
    const observer=new ResizeObserver(measure);
    observer.observe(element);
    document.fonts.addEventListener("loadingdone",measure);
    return ()=>{observer.disconnect();document.fonts.removeEventListener("loadingdone",measure);};
  },[compact,signature,event.summaryKind]);
  if(event.summaryKind!=="copilot") {
    const summary=event.summary||"暂无摘录，请阅读原文。";
    return <p className={`ns-summary-excerpt${compact?" ns-summary-compact":""}`}>{compact&&summary.length>240?`${summary.slice(0,240).trimEnd()}…`:summary}</p>;
  }
  const displayPoints=compact?compactSummaryPoints(points):points;
  const visual=validSummaryVisual(event.summaryVisual,points)?event.summaryVisual:null;
  const sources=event.evidence?.filter(source=>!event.summaryEvidenceIds?.length||event.summaryEvidenceIds.includes(source.id));
  const unavailable=event.summaryVisual?"图解数据与摘要不匹配，暂不展示；文字摘要仍可阅读。"
    :event.summaryStatus==="failed"?"辅助图解暂未生成，摘要更新失败；已有文字摘要仍可阅读。"
    :event.summaryStatus==="running"?"辅助图解正在随摘要更新，已有文字可先阅读。"
    :event.summaryStatus==="pending"?"辅助图解待随摘要更新，已有文字可先阅读。"
    :(event.summaryFormatVersion??0)<4?"这篇摘要尚无辅助图解，文字内容仍可阅读。"
    :"这篇材料未提取出适合图解的独立信息，请结合摘要与原文阅读。";
  return <div className="ns-summary-content">
    {!compact&&longSummary&&(visual?<SummaryVisual visual={visual} points={points} sources={sources} onReadPoints={()=>{
      pointList.current?.focus({preventScroll:true});
      pointList.current?.scrollIntoView({block:"start"});
    }}/>:<p className="ns-summary-visual-unavailable" role="status">{unavailable}</p>)}
    {displayPoints.length>0&&<ul ref={pointList} tabIndex={compact?undefined:-1} className={`ns-summary-points${compact?" ns-summary-compact":""}`} aria-label="摘要要点">{displayPoints.map((point,index)=><li key={index}>{point}</li>)}</ul>}
    {!compact&&limitations.length>0&&<section className="ns-summary-limits" aria-label="原文明确的局限"><strong>原文提及的局限</strong><ul>{limitations.map((text,index)=><li key={index}>{text}</li>)}</ul></section>}
    {!displayPoints.length&&(!limitations.length||compact)&&<p>摘要没有可展示的要点，请阅读原文。</p>}
  </div>;
}
