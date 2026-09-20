import { Badge } from "@fluentui/react-components";
import { formatDate, summaryStatusLabel } from "../reader";
import { useStyles } from "../styles";
import type { Event } from "../types";

export function SummaryState({ event, details = false }: { event: Pick<Event, "summaryKind" | "summaryStatus" | "summaryError" | "summaryNextAttemptAt">; details?: boolean }) {
  const styles = useStyles();
  const status = event.summaryStatus;
  if (!status || status === "completed") return null;
  const waiting = !!event.summaryNextAttemptAt && (status === "failed" || status === "pending" && !!event.summaryError);
  return <div className={details ? styles.reason : styles.meta}>
    <Badge color={status === "failed" && !waiting ? "danger" : "warning"} appearance="tint">{event.summaryKind === "copilot" && status === "running" ? "摘要升级中" : event.summaryKind === "copilot" && status === "pending" && !waiting ? "等待升级摘要" : summaryStatusLabel(status, event.summaryNextAttemptAt, event.summaryError)}</Badge>
    {details && <>
      <span> {event.summaryKind === "copilot" ? "仍保留上次已生成的摘要。" : "当前显示来源提供的摘录或聚合摘要，尚未完成本应用的 AI 摘要。"}</span>
      {waiting && <div>最早重试时间：{formatDate(event.summaryNextAttemptAt)}（北京时间）；仍受账户状态和调用上限限制。</div>}
      {event.summaryError && <div>最近错误：{event.summaryError}</div>}
    </>}
  </div>;
}
