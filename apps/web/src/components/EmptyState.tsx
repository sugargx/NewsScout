import type { ReactNode } from "react";

export function EmptyState({ icon, title, children, actions }: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return <div className="ns-empty">
    {icon && <span className="ns-empty-icon" aria-hidden="true">{icon}</span>}
    <h2>{title}</h2>
    {children && <p>{children}</p>}
    {actions && <div className="ns-empty-actions">{actions}</div>}
  </div>;
}
