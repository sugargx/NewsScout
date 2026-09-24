import { Button } from "@fluentui/react-components";
import { useMutation, useMutationState, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../api";
import { disinterestReasons, readingTitle } from "../editorial";
import { invalidateReader, projectedFeedbackState, updateReaderState, type FeedbackMutationVariables } from "../reader";
import type { Event, EventState } from "../types";
import { ErrorNotice } from "./Feedback";

type FeedbackUpdate = { event: Event; showUndo: boolean };

export function announceFeedback(event:Event,showUndo:boolean) {
  window.dispatchEvent(new CustomEvent<FeedbackUpdate>("newsscout-feedback",{detail:{event,showUndo}}));
}

export function FeedbackUndo() {
  const [event,setEvent]=useState<Event|null>(null);
  const client=useQueryClient();
  const mutationKey=["event-feedback",event?.id??"feedback-undo"] as const;
  useEffect(()=>{
    const listener=(message:globalThis.Event)=>{
      const {event:updated,showUndo}=(message as CustomEvent<FeedbackUpdate>).detail;
      setEvent(current=>showUndo&&updated.notInterested?updated:
        current?.id===updated.id?updated.notInterested?updated:null:current);
    };
    window.addEventListener("newsscout-feedback",listener);
    return()=>window.removeEventListener("newsscout-feedback",listener);
  },[]);
  const mutation=useMutation({
    mutationKey,
    mutationFn:({id,state}:{id:string;state:EventState})=>api.eventState(id,state),
    onSuccess:updated=>{
      updateReaderState(client,updated);
      void invalidateReader(client);
      setEvent(current=>current?.id===updated.id?updated.notInterested?updated:null:current);
    },
  });
  const pending=projectedFeedbackState(useMutationState({
    filters:{mutationKey,exact:true,status:"pending"},
    select:item=>item.state.variables as FeedbackMutationVariables|undefined,
  }).at(-1))??(mutation.isPending?mutation.variables?.state:undefined);
  if(!event)return null;
  const busy=pending!==undefined;
  const projectedReason=pending?.notInterestedReason??event.notInterestedReason;
  const change=(state:EventState)=>{
    if(client.isMutating({mutationKey,exact:true}))return;
    mutation.mutate({id:event.id,state});
  };
  return <aside className="ns-feedback-undo" aria-label="不感兴趣反馈" aria-busy={busy}>
    <div role="status"><strong>已移出推荐</strong><span className="ns-feedback-title">{readingTitle(event)}</span></div>
    <div className="ns-feedback-buttons">
      <Button size="small" aria-busy={pending?.notInterested===false} disabledFocusable={busy} onClick={()=>change({notInterested:false,notInterestedReason:null})}>{pending?.notInterested===false?"撤销中":"撤销不感兴趣"}</Button>
      <details><summary>补充理由（可选）</summary><div>{disinterestReasons.map(reason=><Button key={reason.value} size="small" aria-pressed={projectedReason===reason.value} aria-busy={pending?.notInterestedReason===reason.value} disabledFocusable={busy} onClick={()=>change({notInterested:true,notInterestedReason:reason.value})}>{reason.label}</Button>)}</div></details>
      <Button size="small" appearance="subtle" onClick={()=>setEvent(null)} aria-label="关闭反馈提示">关闭</Button>
    </div>
    {mutation.error&&mutation.variables?.id===event.id&&<ErrorNotice title="反馈未保存" error={mutation.error} busy={busy} retry={()=>mutation.variables?.id===event.id&&change(mutation.variables.state)}/>}
  </aside>;
}
