import type { ReactNode } from "react";
import "../reader-loading.css";

export function LoadingStatus({ children }: { children: ReactNode }) {
  return <p className="ns-loading-status" role="status"><span aria-hidden="true" />{children}</p>;
}

export function ReaderSkeleton({ variant = "cards", count = 4 }: {
  variant?: "cards" | "rows" | "queue" | "detail" | "map";
  count?: number;
}) {
  if (variant === "map") return <div className="ns-skeleton-map" aria-hidden="true" data-reader-skeleton="map">
    <span className="ns-skeleton-line ns-skeleton-label" />
    <div className="ns-skeleton-map-field"><span /><span /><span /></div>
    <span className="ns-skeleton-line ns-skeleton-short" />
    <span className="ns-skeleton-line" />
  </div>;
  if (variant === "detail") return <div className="ns-skeleton-detail" aria-hidden="true" data-reader-skeleton="detail">
    <div className="ns-skeleton-meta"><span className="ns-skeleton-line ns-skeleton-label" /><span className="ns-skeleton-line ns-skeleton-label" /></div>
    {[0, 1, 2].map(index => <div className="ns-skeleton-paragraph" key={index}>
      <span className="ns-skeleton-line" /><span className="ns-skeleton-line" /><span className="ns-skeleton-line ns-skeleton-short" />
    </div>)}
  </div>;
  return <div className={`ns-skeleton-list ns-skeleton-${variant}`} aria-hidden="true" data-reader-skeleton={variant}>
    {Array.from({ length: count }, (_, index) => <div className="ns-skeleton-item" key={index}>
      <div className="ns-skeleton-meta"><span className="ns-skeleton-line ns-skeleton-tag" /><span className="ns-skeleton-line ns-skeleton-label" /></div>
      <span className="ns-skeleton-line ns-skeleton-title" />
      <span className="ns-skeleton-line" />
      {variant === "cards" && <span className="ns-skeleton-line ns-skeleton-short" />}
      <div className="ns-skeleton-meta"><span className="ns-skeleton-line ns-skeleton-label" /><span className="ns-skeleton-line ns-skeleton-tag" /></div>
    </div>)}
  </div>;
}

export function ReaderLoading({ label = "正在读取文章…", variant = "cards", count, heading = false }: {
  label?: string;
  variant?: "cards" | "rows" | "queue" | "detail" | "map";
  count?: number;
  heading?: boolean;
}) {
  return <div className="ns-reader-loading">
    {heading && <div className="ns-route-loading-heading" aria-hidden="true"><span className="ns-skeleton-line ns-skeleton-label" /><span className="ns-skeleton-line ns-skeleton-title" /></div>}
    <LoadingStatus>{label}</LoadingStatus>
    <ReaderSkeleton variant={variant} count={count} />
  </div>;
}
