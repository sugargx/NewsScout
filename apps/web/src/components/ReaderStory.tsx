import { useId, type HTMLAttributes, type MouseEventHandler, type ReactNode, type Ref } from "react";
import "../reader-story.css";

interface ReaderStoryProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title: ReactNode;
  headingLevel?: "h2" | "h3";
  meta: ReactNode;
  selected?: boolean;
  onOpen?: MouseEventHandler<HTMLButtonElement>;
  titleRef?: Ref<HTMLButtonElement>;
  containerRef?: Ref<HTMLElement>;
  actions?: ReactNode;
}

export function ReaderStory({
  title, headingLevel: Heading = "h2", meta, selected = false, onOpen, titleRef, containerRef,
  className = "", actions, children, ...attributes
}: ReaderStoryProps) {
  const titleId = useId();
  return <article {...attributes} ref={containerRef} aria-labelledby={titleId}
    className={`ns-reader-story ${className}`} data-selected={selected}>
    <Heading className="ns-reader-story-title" id={titleId}>
      {onOpen ? <button type="button" ref={titleRef} onClick={onOpen} title="阅读要点与来源内容">{title}</button> : title}
    </Heading>
    <div className="ns-reader-story-meta">{meta}</div>
    <div className="ns-reader-story-body">{children}</div>
    {actions && <div className="ns-reader-story-actions">{actions}</div>}
  </article>;
}
