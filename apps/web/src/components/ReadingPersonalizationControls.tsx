import { Switch } from "@fluentui/react-components";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { isReadingPersonalization } from "../reading-personalization";
import type { ReadingPersonalization } from "../types";
import { ErrorNotice } from "./Feedback";
import { ReaderButton } from "./ReaderControls";

export function ReadingPersonalizationControls({ value, onChange }: {
  value: ReadingPersonalization; onChange: (value: ReadingPersonalization) => void;
}) {
  const [confirmation, setConfirmation] = useState<"clear" | "disable" | null>(null);
  const confirmationArea = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLInputElement>(null), clearButton = useRef<HTMLButtonElement>(null);
  const restoreTrigger = (action: "clear" | "disable") => requestAnimationFrame(() => {
    (action === "clear" ? clearButton.current : toggle.current)?.focus();
  });
  useEffect(() => { if (confirmation) confirmationArea.current?.focus(); }, [confirmation]);
  const change = useMutation({
    mutationFn: async (action: boolean | "clear") => {
      const result = await (action === "clear" ? api.clearReadingPersonalization() : api.setReadingPersonalization(action));
      if (!isReadingPersonalization(result)) throw new Error("阅读学习设置响应不完整。");
      return result;
    },
    onSuccess: (result, action) => {
      onChange(result);
      setConfirmation(null);
      restoreTrigger(action === "clear" ? "clear" : "disable");
    },
  });
  return <section className="ns-reading-personalization" aria-labelledby="ns-reading-personalization-title">
    <h3 id="ns-reading-personalization-title">阅读兴趣学习</h3>
    <Switch id="ns-reading-personalization" input={{ ref: toggle }} label="根据我的站内阅读调整推荐" checked={value.enabled}
      disabled={change.isPending} onChange={(_, data) => {
        change.reset();
        if (!data.checked) setConfirmation("disable");
        else { setConfirmation(null); change.mutate(true); }
      }} />
    <p>默认关闭。开启后，只把文章的前台阅读作为弱兴趣线索，不把一次打开当作喜欢或读完。收藏与“不感兴趣”优先。</p>
    <p>用于后续推荐和下一期精选，不重排已保存当期。信号有效期30天，过期后定期清理；确认关闭会删除学习信号，原有收藏和打开记录不受影响。</p>
    <p className="ns-reading-signal-count">过去30天已积累 {value.signalCount} 篇阅读信号；同一主题至少两篇不同文章才参与学习。</p>
    {confirmation ? <div className="ns-reading-clear-confirmation" ref={confirmationArea} tabIndex={-1}
      role="group" aria-label={confirmation === "clear" ? "清空学习记录确认" : "关闭阅读学习确认"}
      aria-describedby="ns-reading-confirmation-description">
      <p id="ns-reading-confirmation-description">{confirmation === "clear"
        ? "只清空学习信号，开启状态不变；收藏、打开记录和已保存精选不会删除。"
        : `关闭后将停止学习，并删除已积累的 ${value.signalCount} 篇阅读信号。收藏、打开记录和已保存精选不会删除。`}</p>
      <div className="ns-reading-control-actions">
        <ReaderButton variant="danger" disabledFocusable={change.isPending} onClick={() => change.mutate(confirmation === "clear" ? "clear" : false)}>
          {confirmation === "clear" ? "确认清空学习记录" : "关闭并删除学习信号"}</ReaderButton>
        <ReaderButton disabledFocusable={change.isPending} onClick={() => {
          const previous = confirmation; setConfirmation(null); change.reset(); restoreTrigger(previous);
        }}>{confirmation === "clear" ? "取消清空" : "取消关闭"}</ReaderButton>
      </div>
    </div> : <ReaderButton ref={clearButton} disabledFocusable={change.isPending || !value.enabled && value.signalCount === 0}
      onClick={() => { change.reset(); setConfirmation("clear"); }}>清空学习记录</ReaderButton>}
    {change.isPending && <p role="status">正在保存阅读学习设置…</p>}
    {change.isSuccess && !change.isPending && <p role="status">{change.variables === "clear"
      ? "学习记录已清空。" : value.enabled ? "已开启，将从新的站内阅读逐步积累兴趣。" : "已关闭，学习信号已删除。"}</p>}
    {change.error && <ErrorNotice title="阅读学习设置未保存" error={change.error}
      retry={() => change.variables !== undefined && change.mutate(change.variables)} />}
  </section>;
}
