import { BookmarkFilled, BookmarkRegular, EyeOffRegular, EyeRegular } from "@fluentui/react-icons";
import { useMutation, useMutationState, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { invalidateReader, projectedFeedbackState, updateReaderState, type FeedbackMutationVariables, type FeedbackState } from "../reader";
import type { Event } from "../types";
import { useStyles } from "../styles";
import { ErrorNotice } from "./Feedback";
import { announceFeedback } from "./FeedbackUndo";
import { disinterestReasons, readingTitle } from "../editorial";
import { ReaderButton } from "./ReaderControls";

export function EventActions({ event, variant = "text" }: { event: Event; variant?: "text" | "icons" }) {
  const styles = useStyles(), client = useQueryClient();
  const mutationKey = ["event-feedback", event.id] as const;
  const mutation = useMutation({
    mutationKey,
    mutationFn: (state: FeedbackState) => api.eventState(event.id, state),
    onSuccess: (updated,state) => {
      announceFeedback(updated,state.notInterested===true);
      updateReaderState(client,updated);
      void invalidateReader(client);
    },
  });
  const pending = projectedFeedbackState(useMutationState({
    filters: { mutationKey, exact: true, status: "pending" },
    select: item => item.state.variables as FeedbackMutationVariables | undefined,
  }).at(-1)) ?? (mutation.isPending ? mutation.variables : undefined);
  const busy = pending !== undefined;
  const saved = pending?.saved ?? event.saved;
  const notInterested = pending?.notInterested ?? !!event.notInterested;
  const savedPending = pending?.saved !== undefined;
  const dismissalPending = pending?.notInterested !== undefined;
  const change = (state: FeedbackState) => {
    // The cache guard also covers a second click before React renders, including another copy of this event.
    if (client.isMutating({ mutationKey, exact: true })) return;
    mutation.mutate(state);
  };
  const title = readingTitle(event);
  const savedLabel = `${saved ? "取消收藏" : "收藏"}：${title}`;
  const dismissLabel = `${notInterested ? "撤销不感兴趣" : "不感兴趣"}：${title}`;
  if (variant === "icons") return <div className="ns-event-actions ns-event-actions-icons" aria-busy={busy}>
    <div className="ns-event-action-buttons">
      <ReaderButton className="ns-icon-button ns-event-action-bookmark" icon={saved ? <BookmarkFilled /> : <BookmarkRegular />} aria-label={savedLabel} aria-pressed={saved} aria-busy={savedPending} disabledFocusable={busy} onClick={() => change({ saved: !saved })}/>
      <ReaderButton className="ns-icon-button ns-event-action-dismiss" icon={notInterested ? <EyeRegular /> : <EyeOffRegular />} title={notInterested ? "撤销不感兴趣" : "不感兴趣 · 移出推荐，可撤销"} aria-label={dismissLabel} aria-pressed={notInterested} aria-busy={dismissalPending} disabledFocusable={busy} onClick={() => change({ notInterested: !notInterested, notInterestedReason: null })}/>
    </div>
    {event.notInterested&&event.notInterestedReason&&<span className="ns-feedback-saved-reason">理由：{disinterestReasons.find(reason=>reason.value===event.notInterestedReason)?.label}</span>}
    {mutation.error && <ErrorNotice title="阅读状态保存失败" error={mutation.error} busy={busy} retry={() => mutation.variables && change(mutation.variables)} />}
  </div>;
  return <div className={`ns-event-actions ${styles.eventActions}`} aria-busy={busy}>
    <div className={`ns-event-action-buttons ${styles.eventActionButtons}`}>
      <ReaderButton className="ns-event-action-bookmark" size="small" variant="ghost" icon={saved ? <BookmarkFilled /> : <BookmarkRegular />} aria-label={savedLabel} aria-pressed={saved} aria-busy={savedPending} disabledFocusable={busy} onClick={() => change({ saved: !saved })}>{savedPending ? saved ? "收藏中" : "取消中" : saved ? "已收藏" : "收藏"}</ReaderButton>
      <ReaderButton className="ns-event-action-dismiss" size="small" variant="ghost" title="移出推荐，可撤销；理由可选。" aria-label={dismissLabel} aria-pressed={notInterested} aria-busy={dismissalPending} disabledFocusable={busy} onClick={() => change({ notInterested: !notInterested,notInterestedReason:null })}>{dismissalPending ? notInterested ? "移出中" : "撤销中" : notInterested ? "撤销不感兴趣" : "不感兴趣"}</ReaderButton>
    </div>
    {event.notInterested&&event.notInterestedReason&&<span className="ns-feedback-saved-reason">理由：{disinterestReasons.find(reason=>reason.value===event.notInterestedReason)?.label}</span>}
    {mutation.error && <ErrorNotice title="阅读状态保存失败" error={mutation.error} busy={busy} retry={() => mutation.variables && change(mutation.variables)} />}
  </div>;
}
