import type { Event } from "../types";
import { summaryPresentation } from "../summary-presentation";
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

export function SummaryContent({event,compact=false}:{event:Pick<Event,"summary"|"summaryKind"|"summaryPoints"|"summaryMaterialLimit"|"summaryLimitations">;compact?:boolean}) {
  if(event.summaryKind!=="copilot") {
    const summary=event.summary||"暂无摘录，请阅读原文。";
    return <p className={`ns-summary-excerpt${compact?" ns-summary-compact":""}`}>{compact&&summary.length>240?`${summary.slice(0,240).trimEnd()}…`:summary}</p>;
  }
  const {points,limitations}=summaryPresentation(event);
  const displayPoints=compact?compactSummaryPoints(points):points;
  return <div className="ns-summary-content">
    {displayPoints.length>0&&<ul className={`ns-summary-points${compact?" ns-summary-compact":""}`} aria-label="摘要要点">{displayPoints.map((point,index)=><li key={index}>{point}</li>)}</ul>}
    {!compact&&limitations.length>0&&<section className="ns-summary-limits" aria-label="原文明确的局限"><strong>原文提及的局限</strong><ul>{limitations.map((text,index)=><li key={index}>{text}</li>)}</ul></section>}
    {!displayPoints.length&&(!limitations.length||compact)&&<p>摘要没有可展示的要点，请阅读原文。</p>}
  </div>;
}
