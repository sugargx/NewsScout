import { BookmarkFilled, BookmarkRegular } from "@fluentui/react-icons";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { invalidateReader, updateReaderState } from "../reader";
import type { Event, EventState } from "../types";
import { useStyles } from "../styles";
import { ErrorNotice } from "./Feedback";
import { announceDismissal } from "./FeedbackUndo";
import { disinterestReasons, readingTitle } from "../editorial";
import { ReaderButton } from "./ReaderControls";

export function EventActions({ event }: { event: Event }) {
  const styles = useStyles(), client = useQueryClient();
  const mutation = useMutation({
    mutationFn: (state: EventState) => api.eventState(event.id, state),
    onSuccess: async (updated,state) => {
      if(state.notInterested===true)announceDismissal(updated);
      updateReaderState(client,updated);
      await invalidateReader(client);
    },
  });
  return <div className={`ns-event-actions ${styles.eventActions}`} aria-busy={mutation.isPending}>
    <div className={`ns-event-action-buttons ${styles.eventActionButtons}`}>
      <ReaderButton size="small" variant="ghost" icon={event.saved ? <BookmarkFilled /> : <BookmarkRegular />} aria-label={`${event.saved ? "取消收藏" : "收藏"}：${readingTitle(event)}`} aria-pressed={event.saved} disabled={mutation.isPending} onClick={() => mutation.mutate({ saved: !event.saved })}>{event.saved ? "已收藏" : "收藏"}</ReaderButton>
      <ReaderButton size="small" variant="ghost" title="移出推荐，可撤销；理由可选。" aria-label={`${event.notInterested ? "撤销不感兴趣" : "不感兴趣"}：${readingTitle(event)}`} aria-pressed={!!event.notInterested} disabled={mutation.isPending} onClick={() => mutation.mutate({ notInterested: !event.notInterested,notInterestedReason:null })}>{event.notInterested ? "撤销不感兴趣" : "不感兴趣"}</ReaderButton>
      {mutation.isPending && <span role="status">正在保存…</span>}
    </div>
    {event.notInterested&&event.notInterestedReason&&<span className="ns-feedback-saved-reason">理由：{disinterestReasons.find(reason=>reason.value===event.notInterestedReason)?.label}</span>}
    {mutation.error && <ErrorNotice title="阅读状态保存失败" error={mutation.error} busy={mutation.isPending} retry={() => mutation.variables && mutation.mutate(mutation.variables)} />}
  </div>;
}
