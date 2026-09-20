import { Badge, Spinner } from "@fluentui/react-components";
import { Link } from "react-router-dom";
import { processingBlocker, useProcessing } from "../reader";
import { useStyles } from "../styles";
import { ErrorNotice } from "./Feedback";

export function ProcessingStatus() {
  const styles = useStyles();
  const query = useProcessing();
  const data = query.data;
  if (!data) return query.error
    ? <ErrorNotice title="自动摘要状态读取失败，仍可阅读已有内容" error={query.error} busy={query.isFetching} retry={() => void query.refetch()} />
    : <Spinner size="tiny" label="正在读取摘要覆盖率…" />;
  const total = data.aiCount + data.feedCount;
  return <>
    {query.error && <ErrorNotice title="摘要状态暂未更新，以下为上次读取的状态" error={query.error} busy={query.isFetching} retry={() => void query.refetch()} />}
    <div className={styles.statusStrip}><Badge title={processingBlocker(data.blockedReason)} appearance="tint" color={data.blockedReason ? "warning" : "success"}>{!data.settings.enabled ? "摘要已暂停" : data.blockedReason ? "摘要等待处理" : "自动摘要中"}</Badge><span>AI 摘要 {data.aiCount} / {total} · 排队 {data.counts.pending} · 生成中 {data.counts.running}</span><Link to="/settings">队列与用量</Link></div>
  </>;
}
