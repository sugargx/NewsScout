import type { BriefSection } from "../types";

export function EditionHeading({ section, id, workspace = false, count }: {
  section?: BriefSection;
  count?: number;
  id?: string;
  workspace?: boolean;
}) {
  if (!section) return null;
  return <header id={id} className={`ns-section-heading ns-section-line${workspace ? " ns-workspace-heading" : ""}`} data-edition-kind={section.kind}>
    <h2>{section.title}</h2>
    {(count !== undefined || section.description) && <span>{[count !== undefined ? `${count} 篇` : "", section.description ?? ""].filter(Boolean).join(" · ")}</span>}
  </header>;
}
