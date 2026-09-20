import { WarningRegular } from "@fluentui/react-icons";
import type { ReactNode } from "react";
import { ReaderButton } from "./ReaderButton";

export function ReaderProblem({ title, error, details, retry, busy = false }: {
  title: string; error: unknown; details?: ReactNode; retry?: () => void; busy?: boolean;
}) {
  return <div className="ns-reader-problem" role="alert">
    <WarningRegular aria-hidden="true"/>
    <div><strong>{title}</strong><p>{error instanceof Error ? error.message : "发生未知错误，请重试。"}</p>
      {details && <details><summary>查看详情</summary>{details}</details>}
    </div>
    {retry && <ReaderButton disabled={busy} onClick={retry}>{busy ? "正在重试…" : "重试"}</ReaderButton>}
  </div>;
}
