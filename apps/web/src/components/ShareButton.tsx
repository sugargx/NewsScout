import { ShareRegular } from "@fluentui/react-icons";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { ErrorNotice } from "./Feedback";
import type { Event } from "../types";
import { ReaderButton } from "./ReaderControls";

export function ShareButton({kind,id,date,items,compact=false}:{kind:"event"|"brief"|"week";id?:string;date?:string;items?:Event[];compact?:boolean}) {
  const navigate=useNavigate(),client=useQueryClient();
  const create=useMutation({mutationFn:()=>api.createShare({kind,eventId:id,date,
    selection:items?.map(item=>({eventId:item.id,contentVersion:item.contentVersion,summarizedAt:item.summarizedAt}))}),
    onSuccess:async share=>{
      client.setQueryData(["share",share.id],share);
      await client.invalidateQueries({queryKey:["share-drafts"]});
      navigate("/share/"+share.id);
    }});
  return <span className="ns-share-entry">
    <ReaderButton icon={<ShareRegular />} size={compact?"small":"medium"} variant={compact?"ghost":"secondary"}
      disabled={create.isPending} onClick={()=>create.mutate()} title="生成本地分享草稿，不会自动发布">
      {create.isPending?"准备草稿…":compact?"分享卡片":"制作分享卡片"}
    </ReaderButton>
    {create.error && <ErrorNotice title="分享草稿未创建" error={create.error} retry={()=>create.mutate()} />}
  </span>;
}
