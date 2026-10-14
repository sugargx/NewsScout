import { useId, useLayoutEffect, useRef, useState } from "react";
import { cleanUrl } from "../daily-share";
import { wrapVisualText } from "../summary-visual";
import type { SummaryVisual as Visual } from "../types";

type Source = {id:string;sourceName:string;url:string|null};
type NodeLayout = {x:number;y:number;width:number;height:number;label:string[];detail:string[]};
type Layout = {width:number;height:number;nodes:NodeLayout[]};

export function SummaryVisual({visual,points,sources=[],onReadPoints}:{visual:Visual;points:string[];sources?:readonly Source[];onReadPoints:()=>void}) {
  const id = useId(), figure = useRef<HTMLElement>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const heading = visual.kind === "comparison" ? "并列对照" : "内容结构";
  useLayoutEffect(() => {
    const element = figure.current;
    if (!element) return;
    const canvas = document.createElement("canvas"), context = canvas.getContext("2d");
    if (!context) { setUnavailable(true); return; }
    const measure = () => {
      const width = Math.floor(element.getBoundingClientRect().width);
      if (width <= 0) return;
      const columns = width >= 520 ? 2 : 1, gap = 12, padding = 16;
      const nodeWidth = (width - gap * (columns - 1)) / columns;
      const font = getComputedStyle(element).fontFamily;
      const nodes = visual.items.map(item => {
        context.font = `600 14px ${font}`;
        const label = wrapVisualText(item.label, nodeWidth - padding * 2, text => context.measureText(text).width);
        context.font = `400 14px ${font}`;
        const detail = wrapVisualText(item.detail, nodeWidth - padding * 2, text => context.measureText(text).width);
        return {x:0,y:0,width:nodeWidth,height:padding * 2 + label.length * 20 + detail.length * 21 + 34,label,detail};
      });
      let height = 0;
      for (let row = 0; row < nodes.length; row += columns) {
        const rowHeight = Math.max(...nodes.slice(row, row + columns).map(node => node.height));
        for (let column = 0; column < columns && row + column < nodes.length; column++) {
          Object.assign(nodes[row + column], {x:column * (nodeWidth + gap),y:height,height:rowHeight});
        }
        height += rowHeight + gap;
      }
      setLayout({width,height:height - gap,nodes});
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    document.fonts.addEventListener("loadingdone", measure);
    return () => { observer.disconnect(); document.fonts.removeEventListener("loadingdone", measure); };
  }, [visual]);
  const references = [...new Set(visual.items.map(item => item.point))].sort((a,b) => a-b);
  return <figure className="ns-summary-visual" ref={figure} aria-label="摘要辅助图解">
    <figcaption><strong>摘要图解</strong><span>{heading}</span><span className="ns-summary-visual-badge">AI 生成</span></figcaption>
    <p className="ns-summary-visual-note">依据摘要整理，非原文配图；不代表独立核验。完整条件与局限请结合下文阅读。</p>
    <button type="button" className="ns-summary-visual-skip" onClick={onReadPoints}>跳到完整要点</button>
    {layout && <svg xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby={`${id}-title ${id}-description`}
      viewBox={`0 0 ${layout.width} ${layout.height}`} width={layout.width} height={layout.height} className="ns-summary-visual-image">
      <title id={`${id}-title`}>{`摘要图解：${heading}`}</title>
      <desc id={`${id}-description`}>{visual.items.map(item => `${item.label}：${item.detail}。依据要点${item.point}。`).join("\n")}</desc>
      {layout.nodes.map((node,index) => <g key={index} transform={`translate(${node.x} ${node.y})`} aria-hidden="true">
        <rect x=".5" y=".5" width={node.width - 1} height={node.height - 1} rx="6" className="ns-summary-visual-box"/>
        <path d={`M 16 13 H ${node.width - 16}`} className="ns-summary-visual-rule"/>
        <text x="16" y="37" className="ns-summary-visual-label">{node.label.map((line,i) => <tspan key={i} x="16" dy={i ? 20 : 0}>{line}</tspan>)}</text>
        <text x="16" y={37 + node.label.length * 20 + 4} className="ns-summary-visual-detail">{node.detail.map((line,i) => <tspan key={i} x="16" dy={i ? 21 : 0}>{line}</tspan>)}</text>
        <text x="16" y={node.height - 14} className="ns-summary-visual-reference">{`依据要点 ${visual.items[index].point}`}</text>
      </g>)}
    </svg>}
    {unavailable && <p role="status">浏览器暂不能绘制图解，仍可查看下方文字依据。</p>}
    <details open={unavailable || undefined}>
      <summary>查看图解依据与来源</summary>
      <ol className="ns-summary-visual-evidence" aria-label="图解文字依据">{references.map(point => <li key={point} value={point}>{points[point - 1]}</li>)}</ol>
      {sources.length > 0 && <p className="ns-summary-visual-sources">材料来源：{sources.map((source,index) => {
        const url = cleanUrl(source.url ?? "");
        return <span key={source.id}>{index > 0 && " · "}{url
          ? <a href={url} target="_blank" rel="noopener noreferrer">{source.sourceName}</a>
          : <span>{source.sourceName}（原文链接不可用）</span>}</span>;
      })}</p>}
    </details>
  </figure>;
}
