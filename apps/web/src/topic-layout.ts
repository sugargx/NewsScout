import type { Exploration } from "./types";

export interface TopicPoint { id:string;count:number;x:number;y:number;radius:number;lines:string[];width:number;height:number }

function labelLines(text:string,maxUnits:number) {
  const lines:string[]=[];
  let line="",units=0;
  for(const char of text) {
    const next=/[^\u0000-\u007f]/u.test(char)?1:.56;
    if(units+next>maxUnits&&line) {lines.push(line.trim());line="";units=0;}
    line+=char;units+=next;
  }
  if(line.trim())lines.push(line.trim());
  return lines.length>2?[lines[0],[...lines[1]].slice(0,-1).join("")+"\u2026"]:lines;
}

export function layoutTopics(nodes:Exploration["nodes"],edges:Exploration["edges"],width:number) {
  width=Math.max(240,width);
  const boxWidth=Math.min(134,(width-40)/2);
  const columns=Math.min(3,Math.max(2,Math.floor((width-20)/(boxWidth+8))));
  const height=Math.max(width<380?430:390,Math.ceil(nodes.length/columns)*140+65);
  const strength=new Map(nodes.map(node=>[node.id,0]));
  for(const edge of edges) {
    strength.set(edge.source,(strength.get(edge.source)??0)+edge.count);
    strength.set(edge.target,(strength.get(edge.target)??0)+edge.count);
  }
  const sorted=[...nodes].sort((a,b)=>(strength.get(b.id)??0)-(strength.get(a.id)??0)||b.count-a.count||a.id.localeCompare(b.id));
  const maxCount=Math.max(1,...nodes.map(node=>node.count));
  const points:TopicPoint[]=sorted.map((node,index)=>{
    const angle=index*2.39996323-.9;
    const distance=index===0?0:Math.sqrt(index/Math.max(1,nodes.length-1));
    return {...node,x:width/2+Math.cos(angle)*(width/2-boxWidth/2-24)*distance,
      y:height/2+Math.sin(angle)*(height/2-78)*distance,
      radius:23+Math.sqrt(node.count/maxCount)*13,lines:labelLines(node.id,(boxWidth-8)/15),width:boxWidth,height:126};
  });
  const byId=new Map(points.map((point,index)=>[point.id,index]));
  const constrain=(point:TopicPoint)=>{
    point.x=Math.max(point.width/2+14,Math.min(width-point.width/2-14,point.x));
    point.y=Math.max(70,Math.min(height-96,point.y));
  };
  // Solve once per topology/viewport; focus and hover never reheat or shuffle the graph.
  for(let step=0;step<380;step++) {
    const forces=points.map(point=>({x:(width/2-point.x)*.009,y:(height/2-point.y)*.009}));
    for(const edge of edges) {
      const a=byId.get(edge.source),b=byId.get(edge.target);
      if(a===undefined||b===undefined)continue;
      const dx=points[b].x-points[a].x,dy=points[b].y-points[a].y,d=Math.max(1,Math.hypot(dx,dy));
      const pull=(d-170)*.014*Math.min(2,1+Math.log2(edge.count+1)/5);
      forces[a].x+=dx/d*pull;forces[a].y+=dy/d*pull;
      forces[b].x-=dx/d*pull;forces[b].y-=dy/d*pull;
    }
    for(let a=0;a<points.length;a++)for(let b=a+1;b<points.length;b++) {
      const dx=points[b].x-points[a].x,dy=points[b].y-points[a].y,d=Math.max(1,Math.hypot(dx,dy));
      const push=Math.min(3,6500/(d*d));
      forces[a].x-=dx/d*push;forces[a].y-=dy/d*push;forces[b].x+=dx/d*push;forces[b].y+=dy/d*push;
      const overlapX=(points[a].width+points[b].width)/2+12-Math.abs(dx),overlapY=138-Math.abs(dy);
      if(overlapX>0&&overlapY>0) {
        if(overlapX<overlapY) {
          const shift=(Math.sign(dx)||1)*overlapX*.55;
          forces[a].x-=shift;forces[b].x+=shift;
        } else {
          const shift=(Math.sign(dy)||1)*overlapY*.55;
          forces[a].y-=shift;forces[b].y+=shift;
        }
      }
    }
    points.forEach((point,index)=>{
      point.x+=Math.max(-8,Math.min(8,forces[index].x));
      point.y+=Math.max(-8,Math.min(8,forces[index].y));
      constrain(point);
    });
  }
  for(let step=0;step<160;step++) {
    for(let a=0;a<points.length;a++)for(let b=a+1;b<points.length;b++) {
      const dx=points[b].x-points[a].x,dy=points[b].y-points[a].y;
      const overlapX=(points[a].width+points[b].width)/2+5-Math.abs(dx),overlapY=132-Math.abs(dy);
      if(overlapX>0&&overlapY>0) {
        const horizontal=overlapX<overlapY;
        const shift=((horizontal?Math.sign(dx):Math.sign(dy))||1)*(horizontal?overlapX:overlapY)*.51;
        if(horizontal){points[a].x-=shift;points[b].x+=shift;}else{points[a].y-=shift;points[b].y+=shift;}
        constrain(points[a]);constrain(points[b]);
      }
    }
  }
  // Dense, narrow canvases can trap a force solver against the bounds. Assign free
  // slots near the solved positions rather than leaving any label collision.
  if(points.some((point,a)=>points.slice(a+1).some(other=>Math.abs(point.x-other.x)<boxWidth+1&&Math.abs(point.y-other.y)<128))) {
    const rows=Math.ceil(points.length/columns);
    const slots=Array.from({length:rows*columns},(_,index)=>({
      x:boxWidth/2+14+(width-boxWidth-28)*(index%columns)/(columns-1),
      y:rows===1?height/2:70+(height-166)*Math.floor(index/columns)/(rows-1),
    }));
    for(const point of points) {
      let best=0;
      for(let index=1;index<slots.length;index++) {
        if(Math.hypot(point.x-slots[index].x,point.y-slots[index].y)<Math.hypot(point.x-slots[best].x,point.y-slots[best].y))best=index;
      }
      const [slot]=slots.splice(best,1);point.x=slot.x;point.y=slot.y;
    }
  }
  return {width,height,points,hub:sorted[0]?.id??""};
}
