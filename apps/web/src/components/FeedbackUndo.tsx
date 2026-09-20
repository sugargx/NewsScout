import { Button } from "@fluentui/react-components";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../api";
import { disinterestReasons, readingTitle } from "../editorial";
import { invalidateReader, updateReaderState } from "../reader";
import type { Event, EventState } from "../types";
import { ErrorNotice } from "./Feedback";

export function announceDismissal(event:Event) {
  window.dispatchEvent(new CustomEvent("newsscout-dismissed",{detail:event}));
}

export function FeedbackUndo() {
  const [event,setEvent]=useState<Event|null>(null);
  const client=useQueryClient();
  useEffect(()=>{
    const listener=(message:globalThis.Event)=>setEvent((message as CustomEvent<Event>).detail);
    window.addEventListener("newsscout-dismissed",listener);
    return()=>window.removeEventListener("newsscout-dismissed",listener);
  },[]);
  const mutation=useMutation({
    mutationFn:({id,state}:{id:string;state:EventState})=>api.eventState(id,state),
    onSuccess:updated=>{
      updateReaderState(client,updated);void invalidateReader(client);
      setEvent(current=>current?.id===updated.id?updated.notInterested?updated:null:current);
    },
  });
  if(!event)return null;
  return <aside className="ns-feedback-undo" aria-label="不感兴趣反馈">
    <div role="status"><strong>已移出推荐</strong><span className="ns-feedback-title">{readingTitle(event)}</span></div>
    <div className="ns-feedback-buttons">
      <Button size="small" disabled={mutation.isPending} onClick={()=>mutation.mutate({id:event.id,state:{notInterested:false,notInterestedReason:null}})}>撤销不感兴趣</Button>
      <details><summary>补充理由（可选）</summary><div>{disinterestReasons.map(reason=><Button key={reason.value} size="small" aria-pressed={event.notInterestedReason===reason.value} disabled={mutation.isPending} onClick={()=>mutation.mutate({id:event.id,state:{notInterested:true,notInterestedReason:reason.value}})}>{reason.label}</Button>)}</div></details>
      <Button size="small" appearance="subtle" onClick={()=>setEvent(null)} aria-label="关闭反馈提示">关闭</Button>
    </div>
    {mutation.error&&<ErrorNotice title="反馈未保存" error={mutation.error} retry={()=>mutation.variables&&mutation.mutate(mutation.variables)}/>}
  </aside>;
}
