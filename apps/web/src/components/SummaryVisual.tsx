import { useId, useLayoutEffect, useRef, useState } from "react";
import { cleanUrl } from "../daily-share";
import { wrapVisualText } from "../summary-visual";
import type { SummaryVisual as Visual } from "../types";

type Source = {id:string;sourceName:string;url:string|null};
type NodeLayout = {x:number;y:number;width:number;height:number;label:string[];detail:string[];inset:number;labelY:number;detailY:number};
type Layout = {width:number;height:number;nodes:NodeLayout[];horizontal:boolean;root:{x:number;y:number}|null};
const headings = {overview:"内容结构",comparison:"并列对照",flow:"流程步骤",timeline:"时间脉络"};

export function SummaryVisual({visual,points,sources=[],onReadPoints}:{visual:Visual;points:string[];sources?:readonly Source[];onReadPoints:()=>void}) {
  const id = useId(), figure = useRef<HTMLElement>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const heading = headings[visual.kind];
  useLayoutEffect(() => {
    const element = figure.current;
    if (!element) return;
    const canvas = document.createElement("canvas"), context = canvas.getContext("2d");
    if (!context) { setUnavailable(true); return; }
    const measure = () => {
      const width = Math.floor(element.getBoundingClientRect().width);
      if (width <= 0) return;
      const horizontal = visual.kind === "comparison" && width >= 440
        || visual.kind === "flow" && visual.items.length === 2 && width >= 520;
      const columns = horizontal ? 2 : 1, gap = visual.kind === "flow" ? 40 : 24;
      const branching = visual.kind === "overview";
      const offset = branching ? width >= 520 ? 116 : 36 : 0;
      const top = branching && width < 520 ? 72 : 8;
      const nodeWidth = (width - offset - gap * (columns - 1)) / columns;
      const font = getComputedStyle(element).fontFamily;
      const nodes = visual.items.map(item => {
        const inset = visual.kind === "comparison" || horizontal ? 0 : 44;
        const labelY = visual.kind === "comparison" || horizontal ? 70 : 24;
        context.font = `600 15px ${font}`;
        const label = wrapVisualText(item.label, nodeWidth - inset - 8, text => context.measureText(text).width);
        context.font = `400 14px ${font}`;
        const detail = wrapVisualText(item.detail, nodeWidth - inset - 8, text => context.measureText(text).width);
        const detailY = labelY + label.length * 22 + 6;
        return {x:0,y:0,width:nodeWidth,height:detailY + detail.length * 22 + 26,label,detail,inset,labelY,detailY};
      });
      let height = top;
      for (let row = 0; row < nodes.length; row += columns) {
        const rowHeight = Math.max(...nodes.slice(row, row + columns).map(node => node.height));
        for (let column = 0; column < columns && row + column < nodes.length; column++) {
          Object.assign(nodes[row + column], {x:offset + column * (nodeWidth + gap),y:height,height:rowHeight});
        }
        height += rowHeight + gap;
      }
      const root = branching ? width >= 520 ? {x:40,y:(height - gap) / 2} : {x:18,y:26} : null;
      setLayout({width,height:height - gap + 8,nodes,horizontal,root});
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    document.fonts.addEventListener("loadingdone", measure);
    return () => { observer.disconnect(); document.fonts.removeEventListener("loadingdone", measure); };
  }, [visual]);
  const references = [...new Set([...visual.items.map(item => item.point), ...(visual.basis ? [visual.basis.point] : [])])].sort((a,b) => a-b);
  return <figure className="ns-summary-visual" data-kind={visual.kind} ref={figure} aria-label="摘要辅助图解">
    <figcaption><strong>摘要图解</strong><span>{heading}</span><span className="ns-summary-visual-badge">AI 生成</span></figcaption>
    <p className="ns-summary-visual-note">依据摘要整理，非原文配图；不代表独立核验。完整条件与局限请结合下文阅读。</p>
    <button type="button" className="ns-summary-visual-skip" onClick={onReadPoints}>跳到完整要点</button>
    {layout && <svg xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby={`${id}-title ${id}-description`}
      viewBox={`0 0 ${layout.width} ${layout.height}`} width={layout.width} height={layout.height} className="ns-summary-visual-image">
      <title id={`${id}-title`}>{`摘要图解：${heading}`}</title>
      <desc id={`${id}-description`}>{visual.items.map(item => `${item.label}：${item.detail}。依据要点${item.point}。`).join("\n")
        + (visual.basis ? `\n顺序依据：${visual.basis.quote}。` : "")}</desc>
      <defs><marker id={`${id}-arrow`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 1 1 L 8 5 L 1 9" className="ns-summary-visual-arrow"/>
      </marker></defs>
      {layout.root && <g className="ns-summary-visual-structure" aria-hidden="true">
        {layout.nodes.map((node,index) => <path key={index} className="ns-summary-visual-connector"
          d={layout.width >= 520
            ? `M ${layout.root!.x + 22} ${layout.root!.y} C ${node.x - 30} ${layout.root!.y} ${node.x - 30} ${node.y + 18} ${node.x + 4} ${node.y + 18}`
            : `M ${layout.root!.x} ${layout.root!.y + 20} V ${node.y + 8} Q ${layout.root!.x} ${node.y + 18} ${node.x + 4} ${node.y + 18}`}/>)}
        <circle cx={layout.root.x} cy={layout.root.y} r="18" className="ns-summary-visual-hub"/>
        <path d={`M ${layout.root.x - 7} ${layout.root.y - 8} h 14 v 16 h -14 Z M ${layout.root.x - 4} ${layout.root.y - 3} h 8 M ${layout.root.x - 4} ${layout.root.y + 2} h 8`} className="ns-summary-visual-hub-icon"/>
        <text x={layout.width >= 520 ? layout.root.x : 48} y={layout.width >= 520 ? layout.root.y + 40 : layout.root.y + 5}
          textAnchor={layout.width >= 520 ? "middle" : "start"} className="ns-summary-visual-root-label">本文要点</text>
      </g>}
      {(visual.kind === "flow" || visual.kind === "timeline") && layout.nodes.slice(0,-1).map((node,index) => {
        const next = layout.nodes[index + 1];
        const d = layout.horizontal ? `M ${node.x + 42} ${node.y + 22} H ${next.x - 8}`
          : visual.kind === "timeline" ? `M ${node.x + 18} ${node.y + 29} V ${next.y + 7}`
          : `M ${node.x + 21} ${node.y + 36} V ${next.y - 8}`;
        return <path key={index} d={d} className={`ns-summary-visual-connector ns-summary-visual-${visual.kind}-line`}
          markerEnd={visual.kind === "flow" ? `url(#${id}-arrow)` : undefined} aria-hidden="true"/>;
      })}
      {layout.nodes.map((node,index) => <g key={index} className="ns-summary-visual-node" transform={`translate(${node.x} ${node.y})`} aria-hidden="true">
        {visual.kind === "comparison" ? <>
          <path d={`M 0 42 H ${node.width - 8}`} className="ns-summary-visual-comparison-rule"/>
          <path d="M 1 0 H 29 L 37 8 V 30 H 1 Z M 29 0 V 8 H 37" className="ns-summary-visual-paper"/>
          <text x="18" y="22" textAnchor="middle" className="ns-summary-visual-index">{String.fromCharCode(65 + index)}</text>
        </> : visual.kind === "timeline" ? <>
          <circle cx="18" cy="18" r="11" className="ns-summary-visual-dot"/>
          <circle cx="18" cy="18" r="3" className="ns-summary-visual-dot-center"/>
        </> : <>
          <path d={visual.kind === "flow" ? "M 5 4 H 31 L 39 18 L 31 32 H 5 L -3 18 Z" : "M 18 2 L 34 18 L 18 34 L 2 18 Z"}
            transform={visual.kind === "flow" ? "translate(3 4)" : undefined} className="ns-summary-visual-step"/>
          <text x={visual.kind === "flow" ? "21" : "18"} y={visual.kind === "flow" ? "27" : "23"} textAnchor="middle" className="ns-summary-visual-index">{index + 1}</text>
        </>}
        <text x={node.inset} y={node.labelY} className="ns-summary-visual-label">{node.label.map((line,i) => <tspan key={i} x={node.inset} dy={i ? 22 : 0}>{line}</tspan>)}</text>
        <text x={node.inset} y={node.detailY} className="ns-summary-visual-detail">{node.detail.map((line,i) => <tspan key={i} x={node.inset} dy={i ? 22 : 0}>{line}</tspan>)}</text>
        <text x={node.inset} y={node.height - 8} className="ns-summary-visual-reference">{`依据要点 ${visual.items[index].point}`}</text>
      </g>)}
    </svg>}
    {visual.kind === "flow" && <p className="ns-summary-visual-basis"><strong>顺序依据</strong> {visual.basis.quote}（要点 {visual.basis.point}）。箭头表示步骤先后，不表示因果或效果提升。</p>}
    {visual.kind === "timeline" && <p className="ns-summary-visual-basis">按摘要中的日期排列；节点等距，不表示实际时间间隔。</p>}
    {visual.kind === "comparison" && <p className="ns-summary-visual-basis">并列展示不同条目，不构成统一指标下的性能排名。</p>}
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
