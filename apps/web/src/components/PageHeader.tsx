import type { ReactNode } from "react";

export function PageHeader({ eyebrow, title, subtitle, action, compact = false }: {
  eyebrow: string;
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}) {
  return <header className={`ns-page-head${compact ? " ns-editorial-header" : ""}`}>
    <div className="ns-page-head-copy"><span className="ns-kicker">{eyebrow}</span><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>
    {action && <div className="ns-page-head-actions">{action}</div>}
  </header>;
}
