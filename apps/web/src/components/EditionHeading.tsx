import type { BriefSection } from "../types";

export function EditionHeading({ section, id, workspace = false }: {
  section?: BriefSection;
  id?: string;
  workspace?: boolean;
}) {
  if (!section) return null;
  return <header id={id} className={`ns-section-heading${workspace ? " ns-workspace-heading" : ""}`} data-edition-kind={section.kind}>
    <h2>{section.title}</h2>
    {section.description && <span>{section.description}</span>}
  </header>;
}
