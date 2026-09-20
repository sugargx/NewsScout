import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Event } from "../types";

export function useExposure(items: Event[], surface = "") {
  const container=useRef<HTMLDivElement>(null);
  const sent=useRef(new Set<string>());
  const [error,setError]=useState<Error|null>(null);
  const version=items.map(item=>`${item.id}:${item.contentVersion}`).join(",");
  useEffect(()=>{
    const root=container.current;
    if(!root) return;
    const timers=new Map<Element,ReturnType<typeof setTimeout>>();
    const observer=new IntersectionObserver(entries=>{
      for(const entry of entries) {
        if(!entry.isIntersecting || entry.intersectionRatio<.5) {
          clearTimeout(timers.get(entry.target));timers.delete(entry.target);continue;
        }
        if(timers.has(entry.target)) continue;
        const id=entry.target.getAttribute("data-event-id");
        const contentVersion=Number(entry.target.getAttribute("data-event-version"));
        const key=`${id}:${contentVersion}`;
        if(!id||!Number.isInteger(contentVersion)||sent.current.has(key)) continue;
        timers.set(entry.target,setTimeout(()=>{
          timers.delete(entry.target);
          if(document.visibilityState!=="visible") return;
          sent.current.add(key);
          void api.exposures([{eventId:id,contentVersion}]).catch((failure:Error)=>{
            sent.current.delete(key);setError(failure);
          });
        },1500));
      }
    },{threshold:[0,.5]});
    root.querySelectorAll("article[data-event-id]").forEach(node=>observer.observe(node));
    return ()=>{observer.disconnect();for(const timer of timers.values()) clearTimeout(timer);};
  },[version,surface]);
  return {container,error};
}
