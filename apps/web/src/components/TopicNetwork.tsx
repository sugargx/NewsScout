import { useEffect, useMemo, useRef, useState } from "react";
import type { Exploration } from "../types";
import { layoutTopics } from "../topic-layout";
import "../topic-network.css";

export function TopicNetwork({nodes,edges,facet,onSelect}:{nodes:Exploration["nodes"];edges:Exploration["edges"];facet:string;onSelect:(id:string)=>void}) {
  const host=useRef<HTMLDivElement>(null);
  const [width,setWidth]=useState(480),[hover,setHover]=useState("");
  const [camera,setCamera]=useState({zoom:1,x:0,y:0});
  const drag=useRef<{pointer:number;x:number;y:number;panX:number;panY:number}|null>(null);
  const linked=useMemo(()=>new Set(edges.flatMap(edge=>[edge.source,edge.target])),[edges]);
  const root=nodes.some(node=>node.id===facet)?facet:nodes[0]?.id??"";
  const focusedEdges=useMemo(()=>edges.filter(edge=>edge.source===root||edge.target===root),[edges,root]);
  const network=useMemo(()=>{const ids=new Set([root,...focusedEdges.flatMap(edge=>[edge.source,edge.target])]);return nodes.filter(node=>ids.has(node.id));},[nodes,root,focusedEdges]);
  const independent=nodes.filter(node=>!network.some(shown=>shown.id===node.id));
  const layout=useMemo(()=>layoutTopics(network,focusedEdges,width),[network,focusedEdges,width]);
  const positions=new Map(layout.points.map(node=>[node.id,node]));
  const focus=hover||(positions.has(facet)?facet:"");
  const adjacent=new Set(edges.filter(edge=>edge.source===focus||edge.target===focus).flatMap(edge=>[edge.source,edge.target]));
  const connections=edges.filter(edge=>edge.source===facet||edge.target===facet);
  const selected=nodes.find(node=>node.id===facet);
  useEffect(()=>{
    const element=host.current;
    if(!element)return;
    const observer=new ResizeObserver(([entry])=>{if(entry.contentRect.width>0)setWidth(Math.round(entry.contentRect.width));});
    observer.observe(element);
    return()=>observer.disconnect();
  },[]);
  function zoom(amount:number) {
    setCamera(previous=>{
      const next=Math.max(1,Math.min(1.8,Math.round((previous.zoom+amount)*10)/10));
      return next===1?{zoom:1,x:0,y:0}:{...previous,zoom:next};
    });
  }
  return <div className="ns-network" ref={host} role="group" aria-label="关键词主题共现图" data-focused-topic={root}>
    <div className="ns-network-toolbar">
      <span><i aria-hidden="true"/>{root} · {focusedEdges.length?`${focusedEdges.length} 个直接共现主题`:"暂无共现连线"}</span>
      <div role="group" aria-label="图谱视图控制">
        <button type="button" aria-label="缩小图谱" disabled={camera.zoom<=1} onClick={()=>zoom(-.2)}>−</button>
        <button type="button" aria-label="还原图谱视图" onClick={()=>setCamera({zoom:1,x:0,y:0})}>{Math.round(camera.zoom*100)}%</button>
        <button type="button" aria-label="放大图谱" disabled={camera.zoom>=1.8} onClick={()=>zoom(.2)}>+</button>
      </div>
    </div>
    <div className="ns-network-stage" data-zoomed={camera.zoom>1}>
      <svg viewBox={`0 0 ${layout.width} ${layout.height}`} style={{height:layout.height}} aria-label="主题节点网络"
        onPointerDown={event=>{
          if(event.button!==0||camera.zoom===1||(event.target instanceof Element&&event.target.closest('[role="button"]')))return;
          drag.current={pointer:event.pointerId,x:event.clientX,y:event.clientY,panX:camera.x,panY:camera.y};
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={event=>{
          const state=drag.current;if(!state||state.pointer!==event.pointerId)return;
          setCamera(previous=>({...previous,x:Math.max(-width/2,Math.min(width/2,state.panX+event.clientX-state.x)),
            y:Math.max(-layout.height/2,Math.min(layout.height/2,state.panY+event.clientY-state.y))}));
        }}
        onPointerUp={()=>{drag.current=null;}} onPointerCancel={()=>{drag.current=null;}}>
        <g transform={`translate(${camera.x+layout.width/2} ${camera.y+layout.height/2}) scale(${camera.zoom}) translate(${-layout.width/2} ${-layout.height/2})`}>
          {focusedEdges.map((edge,index)=>{
            const from=positions.get(edge.source),to=positions.get(edge.target);if(!from||!to)return null;
            const dx=to.x-from.x,dy=to.y-from.y,d=Math.max(1,Math.hypot(dx,dy));
            const bend=Math.min(28,d*.12)*(index%2?1:-1);
            const start={x:from.x+dx/d*(from.radius+5),y:from.y-12+dy/d*(from.radius+5)};
            const end={x:to.x-dx/d*(to.radius+5),y:to.y-12-dy/d*(to.radius+5)};
            const middle={x:(start.x+end.x)/2-dy/d*bend/2,y:(start.y+end.y)/2+dx/d*bend/2};
            const active=focus&&(edge.source===focus||edge.target===focus);
            return <g key={`${edge.source}:${edge.target}`} className={`ns-network-link${active?" is-active":focus?" is-muted":""}`}>
              <path data-edge-source={edge.source} data-edge-target={edge.target}
                d={`M${start.x},${start.y} Q${(start.x+end.x)/2-dy/d*bend},${(start.y+end.y)/2+dx/d*bend} ${end.x},${end.y}`}
                strokeWidth={1.5+Math.min(3,Math.log2(edge.count+1))}/>
              {active&&<g className="ns-network-edge-count" transform={`translate(${middle.x} ${middle.y})`} aria-hidden="true"><rect x="-12" y="-10" width="24" height="20" rx="8"/><text textAnchor="middle" y="4">{edge.count}</text></g>}
              <title>{edge.source} + {edge.target}：{edge.count} 篇共同文章</title>
            </g>;
          })}
          {layout.points.map(node=>{
            const chosen=facet===node.id,related=adjacent.has(node.id),muted=!!focus&&focus!==node.id&&!related;
            return <g key={node.id} role="button" tabIndex={0} aria-pressed={chosen}
              aria-label={`${node.id}，样本中 ${node.count} 篇${chosen?"，已选择":""}。查看匹配文章`}
              data-topic-id={node.id} data-node-x={node.x} data-node-y={node.y}
              className={`ns-network-node${chosen?" is-selected":""}${node.id===layout.hub?" is-hub":""}${muted?" is-muted":""}${hover===node.id?" is-hovered":""}`}
              transform={`translate(${node.x} ${node.y})`}
              onMouseEnter={()=>setHover(node.id)} onMouseLeave={()=>setHover("")}
              onFocus={()=>setHover(node.id)} onBlur={()=>setHover("")}
              onClick={()=>onSelect(node.id)} onKeyDown={event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();onSelect(node.id);}}}>
              <title>{node.id} · 样本中 {node.count} 篇文章</title>
              <rect x={-node.width/2} y={node.radius+3} width={node.width} height={node.lines.length*17+7} fill="transparent"/>
              <circle className="ns-network-halo" cy="-12" r={node.radius+10}/>
              <circle className="ns-network-orb" cy="-12" r={node.radius}/>
              <text className="ns-network-count" textAnchor="middle" y="-6">{node.count}</text>
              <text className="ns-network-unit" textAnchor="middle" y="9">篇</text>
              <text className="ns-network-label" textAnchor="middle" y={node.radius+17}>
                {node.lines.map((line,index)=><tspan x="0" dy={index?17:0} key={index}>{line}</tspan>)}
              </text>
              {chosen&&<circle className="ns-network-selection-dot" cx={node.radius*.72} cy={-12-node.radius*.72} r="5"/>}
            </g>;
          })}
        </g>
      </svg>
      <span className="ns-network-scale">仅展示当前主题与直接共现 · 数字＝样本文章数</span>
    </div>
    {!!independent.length&&<section className="ns-network-independent" aria-label="其他主题">
      <div><span>其他主题</span><small>切换焦点，查看对应文章</small></div>
      <div className="ns-network-satellites">{independent.map(node=><button key={node.id} type="button"
        data-topic-id={node.id} aria-pressed={facet===node.id} aria-label={`${node.id}，样本中 ${node.count} 篇${linked.has(node.id)?"":"，独立主题"}。查看匹配文章`}
        onClick={()=>onSelect(node.id)}><span>{node.count}</span><strong>{node.id}</strong></button>)}</div>
    </section>}
    <div className="ns-network-focus" aria-live="polite">
      <span className="ns-network-focus-mark" aria-hidden="true">{selected?"↗":"◎"}</span>
      <div><strong>{selected?`${selected.id} · 样本 ${selected.count} 篇`:"从相连的主题，找到下一篇值得读的文章"}</strong>
        <p>{selected?(connections.length?`关联 ${connections.length} 个图示主题。右侧查看文章，地图位置保持不变。`:"这是独立主题，与图示主题暂无共现；右侧展示匹配文章。"):"悬停看关联，点击看文章。只有连线代表同篇共现。"}</p></div>
    </div>
    <details className="ns-topic-connections"><summary>查看真实共现计数 · {edges.length} 对</summary>
      {edges.length?<ul>{edges.map(edge=><li key={`${edge.source}:${edge.target}`}><span>{edge.source} + {edge.target}</span><strong>{edge.count} 篇</strong></li>)}</ul>:<p>当前样本没有共现关系。</p>}
    </details>
  </div>;
}
