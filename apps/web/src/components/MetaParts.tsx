import { Fragment, type ReactNode } from "react";

// Each part stays on one line and carries its trailing "·", so a wrapped line never starts with a separator.
export function MetaParts({ parts }: { parts: ReactNode[] }) {
  return <>{parts.map((part, index) => <Fragment key={index}>{index > 0 && " "}<span className="ns-meta-part">{part}{index < parts.length - 1 && "\u00a0·"}</span></Fragment>)}</>;
}
