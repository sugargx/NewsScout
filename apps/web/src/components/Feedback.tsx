import type { ReactNode } from "react";
import { useStyles } from "../styles";
import { ReaderProblem } from "./ReaderProblem";

export function ErrorNotice({ error, retry, busy = false, title = "操作未完成" }: { error: unknown; retry?: () => void; busy?: boolean; title?: string }) {
  return <ReaderProblem title={title} error={error} retry={retry} busy={busy}/>;
}

export function Notice({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return <div className={styles.notice} role="status">{children}</div>;
}
