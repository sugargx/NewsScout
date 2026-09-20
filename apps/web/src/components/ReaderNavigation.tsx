import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import "../reader-navigation.css";

export interface ReaderDestination<T extends string = string> {
  key: T;
  label: string;
  shortLabel: string;
  icon: ReactNode;
  href?: string;
  count?: number;
}

export function ReaderNavigation<T extends string>({ label, items, activeKey, onSelect }: {
  label: string;
  items: readonly ReaderDestination<T>[];
  activeKey?: T;
  onSelect?: (key: T) => void;
}) {
  return <nav className="ns-reader-navigation" aria-label={label}>
    {items.map(item => {
      const content = <><span className="ns-reader-nav-icon" aria-hidden="true">{item.icon}</span>
        <span className="ns-reader-nav-label">{item.label}</span><span className="ns-reader-nav-short">{item.shortLabel}</span>
        {!!item.count && <span className="ns-reader-nav-count">{item.count}</span>}</>;
      const name = item.count !== undefined ? `${item.label} ${item.count}` : item.label;
      return item.href
        ? <NavLink key={item.key} to={item.href} end={item.href === "/"} aria-label={name} title={item.label}
          className={({ isActive }) => `ns-reader-nav-item${isActive ? " is-active" : ""}`}>{content}</NavLink>
        : <button key={item.key} type="button" aria-label={name} title={item.label} aria-pressed={activeKey === item.key}
          className={`ns-reader-nav-item${activeKey === item.key ? " is-active" : ""}`} onClick={() => onSelect?.(item.key)}>{content}</button>;
    })}
  </nav>;
}
