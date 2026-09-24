import { Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle } from "@fluentui/react-components";
import { DismissRegular } from "@fluentui/react-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { api } from "../api";
import { useReaderSession } from "../auth";
import { editionTime } from "../editorial";
import { invalidateReader } from "../reader";
import type { Brief, Topic } from "../types";
import { ErrorNotice } from "./Feedback";
import { Toggle, WeightField } from "./FormControls";
import { ReaderButton } from "./ReaderButton";
import { LoadingStatus } from "./ReaderLoading";

const QuickInterestContext = createContext<(() => void) | null>(null);
const rankedQueries = new Set(["brief", "events", "explore", "topic-events", "reading", "weekly"]);

export function useQuickInterests() {
  return useContext(QuickInterestContext);
}

export function QuickInterestProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const show = useCallback(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen(true);
  }, []);
  const close = useCallback(() => {
    setOpen(false);
    const target = opener.current;
    opener.current = null;
    if (target?.isConnected) requestAnimationFrame(() => target.focus());
  }, []);
  return <QuickInterestContext.Provider value={show}>{children}{open && <QuickInterestDialog onClose={close}/>}</QuickInterestContext.Provider>;
}

function QuickInterestDialog({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const { identityVerified } = useReaderSession();
  // 今日精选 is a fixed daily edition, so on edition pages new weights only reach the next edition.
  const edition = ["/", "/share"].includes(useLocation().pathname);
  const nextEdition = edition ? client.getQueryData<Brief>(["brief", "latest"])?.nextRefreshAt : null;
  const topics = useQuery({ queryKey: ["topics"], queryFn: api.topics });
  const [draft, setDraft] = useState<Topic[] | null>(null);
  const items = draft ?? topics.data?.items ?? [];
  const visible = items.slice(0, 4);
  const save = useMutation({
    mutationFn: api.saveTopics,
    onSuccess: async data => {
      client.setQueryData(["topics"], data);
      await invalidateReader(client);
      await client.refetchQueries({ type: "active", predicate: query => rankedQueries.has(String(query.queryKey[0])) });
      onClose();
    },
  });
  const change = (id: string, patch: Partial<Topic>) => {
    save.reset();
    setDraft(items.map(item => item.id === id ? { ...item, ...patch } : item));
  };
  const busy = save.isPending || !topics.data;
  return <Dialog open modalType={identityVerified ? "modal" : "non-modal"} onOpenChange={(_, data) => { if (!data.open && !save.isPending) onClose(); }}>
    <DialogSurface className="ns-quick-interest" aria-describedby="ns-quick-interest-desc">
      <DialogBody>
        <DialogTitle as="h2" action={<ReaderButton variant="ghost" className="ns-icon-button" icon={<DismissRegular/>} aria-label="关闭" disabled={save.isPending} onClick={onClose}/>}>
          <span className="ns-kicker" aria-hidden="true">Your interests</span>快速调整兴趣权重</DialogTitle>
        <DialogContent>
          <p id="ns-quick-interest-desc">{edition
            ? `新闻雷达等实时列表会立即按新权重排序；今日精选已固定，新权重从下一期${nextEdition ? `（${editionTime(nextEdition)}）` : ""}起生效。`
            : "保存后立即按新权重重新排序当前列表。"}更完整的主题管理可在“<Link to="/topics" onClick={onClose}>兴趣权重</Link>”页面完成。</p>
          {topics.isLoading && <LoadingStatus>正在读取你的兴趣主题…</LoadingStatus>}
          {topics.error && <ErrorNotice title="兴趣主题读取失败" error={topics.error} busy={topics.isFetching} retry={() => void topics.refetch()}/>}
          {topics.data && !items.length && <p className="ns-quick-empty">还没有兴趣主题。请先在“兴趣权重”页面添加。</p>}
          <div className="ns-weight-list is-compact">
            {visible.map(topic => <div className="ns-weight-row" key={topic.id}>
              <div className="ns-weight-name"><strong>{topic.label}</strong><small>{topic.group}</small></div>
              <WeightField topic={topic.label} value={topic.weight} disabled={busy || !topic.enabled} onChange={weight => change(topic.id, { weight })}/>
              <Toggle label={`启用主题：${topic.label}`} checked={topic.enabled} disabled={busy} onChange={enabled => change(topic.id, { enabled })}/>
            </div>)}
          </div>
          {items.length > visible.length && <p className="ns-quick-more"><Link to="/topics" onClick={onClose}>管理全部 {items.length} 个主题 →</Link></p>}
          {save.error && <ErrorNotice title="兴趣权重未保存，修改仍保留" error={save.error} busy={save.isPending} retry={() => save.mutate(items)}/>}
        </DialogContent>
        <DialogActions>
          <ReaderButton disabled={save.isPending} onClick={onClose}>取消</ReaderButton>
          <ReaderButton variant="primary" disabled={busy || draft === null} aria-busy={save.isPending} onClick={() => save.mutate(items)}>{save.isPending ? "正在保存…" : edition ? "保存" : "保存并应用"}</ReaderButton>
        </DialogActions>
      </DialogBody>
    </DialogSurface>
  </Dialog>;
}
