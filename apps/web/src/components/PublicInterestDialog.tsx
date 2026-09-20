import { Checkbox, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Select } from "@fluentui/react-components";
import { DismissRegular } from "@fluentui/react-icons";
import { useId, useRef, useState } from "react";
import { ReaderButton } from "./ReaderButton";
import {
  InterestConflict, interestPriorities, isInterestWeight, loadPublicInterests, publicInterestTopics,
  resetPublicInterests, savePublicInterests, type PublicInterestRecord,
} from "../public-interests";
import "../public-interests.css";

export function PublicInterestDialog({onClose,onApply}:{
  onClose:()=>void;
  onApply:(record:PublicInterestRecord)=>void;
}) {
  const [record,setRecord]=useState(loadPublicInterests);
  const [draft,setDraft]=useState(record.value);
  const [error,setError]=useState<string|null>(null),[conflict,setConflict]=useState(false);
  const [confirmReset,setConfirmReset]=useState(false);
  const problem=useRef<HTMLDivElement>(null);
  const intro=useId();
  function reload() {
    const next=loadPublicInterests();
    setRecord(next);setDraft(next.value);setError(null);setConflict(false);setConfirmReset(false);
  }
  function apply(reset=false) {
    let next:PublicInterestRecord;
    try {
      next=reset?resetPublicInterests(record.raw):savePublicInterests(draft,record.raw);
    } catch(cause) {
      setConflict(cause instanceof InterestConflict);
      setError(cause instanceof InterestConflict?cause.message:"浏览器未能保存兴趣，可能是存储权限或空间不足。此次选择尚未生效，编辑内容仍在。");
      requestAnimationFrame(()=>problem.current?.scrollIntoView({block:"nearest"}));
      return;
    }
    onApply(next);
  }
  return <Dialog open onOpenChange={(event,data)=>{
    if(!data.open) {
      if(data.type==="escapeKeyDown"){event.preventDefault();event.stopPropagation();}
      onClose();
    }
  }}>
    <DialogSurface className="ns-reader-shell ns-public-interest-dialog" backdrop={{className:"ns-interest-backdrop"}} aria-describedby={intro}>
      <DialogBody className="ns-interest-body">
        <div className="ns-interest-heading"><DialogTitle action={null}>兴趣主题</DialogTitle>
          <ReaderButton className="ns-interest-close" variant="ghost" icon={<DismissRegular/>} aria-label="关闭兴趣设置" onClick={onClose}/></div>
        <DialogContent className="ns-interest-content">
          <p id={intro} className="ns-interest-intro">让当前精选和雷达推荐更贴近你。选择感兴趣的主题，再调整关注程度。</p>
          {(record.error||error)&&<div ref={problem} className="ns-interest-error" role="alert">
            <p>{error??record.error}</p>
            {(record.error||conflict)&&<ReaderButton size="small" onClick={reload}>放弃本次编辑并载入最新设置</ReaderButton>}
            {record.error&&!confirmReset&&<ReaderButton size="small" onClick={()=>setConfirmReset(true)}>重置兴趣记录</ReaderButton>}
            {confirmReset&&<div className="ns-interest-reset">
              <p>确认删除本浏览器的兴趣记录并恢复共享推荐？收藏和阅读记录不会删除。</p>
              <ReaderButton size="small" variant="danger" onClick={()=>apply(true)}>确认重置兴趣</ReaderButton>
              <ReaderButton size="small" onClick={()=>setConfirmReset(false)}>保留记录</ReaderButton>
            </div>}
          </div>}
          <div className="ns-interest-grid" role="group" aria-label="可选兴趣主题">
            {publicInterestTopics.map(topic=>{
              const selected=draft.find(item=>item.id===topic.id);
              return <div className="ns-interest-option" data-selected={!!selected} key={topic.id}>
                <Checkbox label={topic.label} checked={!!selected} onChange={(_,data)=>setDraft(previous=>
                  data.checked===true?[...previous.filter(item=>item.id!==topic.id),{id:topic.id,weight:80}]:previous.filter(item=>item.id!==topic.id))}/>
                {selected&&<Select aria-label={`${topic.label}关注程度`} value={String(selected.weight)} onChange={(_,data)=>{
                  const weight=Number(data.value);
                  if(!isInterestWeight(weight)){setError("请选择已提供的关注程度。");return;}
                  setDraft(previous=>previous.map(item=>item.id===topic.id?{...item,weight}:item));
                }}>{interestPriorities.map(priority=><option key={priority.weight} value={priority.weight}>{priority.label}</option>)}</Select>}
              </div>;
            })}
          </div>
          <div className="ns-interest-help">
            <p>兴趣是推荐倾向，不是只看这些主题的筛选。未选择时使用共享推荐；历史晨报、深读队列和周报顺序不变。</p>
            <p>设置保存在当前浏览器，不跨设备同步。推荐请求会携带所选主题，不会改动站主或同事的设置。</p>
          </div>
        </DialogContent>
        <DialogActions className="ns-interest-actions">
          <div className="ns-interest-selection"><span role="status">已选 {draft.length} 个主题</span>
            <ReaderButton size="small" variant="ghost" disabled={!draft.length} onClick={()=>setDraft([])}>清空选择</ReaderButton></div>
          <div className="ns-interest-submit"><ReaderButton onClick={onClose}>取消</ReaderButton>
            <ReaderButton variant="primary" disabled={!!record.error} onClick={()=>apply()}>保存并应用</ReaderButton></div>
        </DialogActions>
      </DialogBody>
    </DialogSurface>
  </Dialog>;
}
