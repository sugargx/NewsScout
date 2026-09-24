import { CheckmarkRegular } from "@fluentui/react-icons";
import type { ReactNode } from "react";
import { ReaderProblem } from "./ReaderProblem";

export function ErrorNotice({ error, retry, busy = false, title = "操作未完成" }: { error: unknown; retry?: () => void; busy?: boolean; title?: string }) {
  return <ReaderProblem title={title} error={error} retry={retry} busy={busy}/>;
}

export function Notice({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "success" }) {
  return <div className={`ns-notice ns-notice-${tone}`} role="status">
    {tone === "success" && <CheckmarkRegular aria-hidden="true"/>}<span>{children}</span>
  </div>;
}