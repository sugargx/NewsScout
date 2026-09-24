import { ChevronRightRegular } from "@fluentui/react-icons";
import { useCallback, useId, useRef, type HTMLAttributes, type MouseEvent, type MouseEventHandler, type ReactNode, type Ref } from "react";
import { ReaderButton } from "./ReaderButton";
import "../reader-story.css";

const interactive = "a,button,input,select,textarea,summary,details,label,[role=button],[role=tab]";

export function ReaderRow({ title, openLabel, meta, preview, value, actions, children, onOpen, selected = false, headingLevel: Heading = "h2", titleRef, ...attributes }: Omit<HTMLAttributes<HTMLElement>, "title"> & {
  title: ReactNode; openLabel?: string; meta: ReactNode; preview?: ReactNode; value?: ReactNode; actions?: ReactNode;
  onOpen?: MouseEventHandler<HTMLButtonElement>; selected?: boolean; headingLevel?: "h2" | "h3"; titleRef?: Ref<HTMLButtonElement>;
}) {
  const id = useId(), titleButton = useRef<HTMLButtonElement | null>(null);
  const setTitleButton = useCallback((element: HTMLButtonElement | null) => {
    titleButton.current = element;
    if (typeof titleRef === "function") titleRef(element);
    else if (titleRef) (titleRef as { current: HTMLButtonElement | null }).current = element;
  }, [titleRef]);
  // The whole reading copy is a pointer target, while the title button remains the accessible control.
  const openFromCopy = (event: MouseEvent<HTMLDivElement>) => {
    if (!onOpen || event.defaultPrevented || (event.target as HTMLElement).closest(interactive)) return;
    if (window.getSelection()?.toString()) return;
    titleButton.current?.click();
  };
  return <article {...attributes} aria-labelledby={id} data-selected={selected} className={`ns-reader-row ${attributes.className ?? ""}`}>
    <div className={`ns-reader-row-content${onOpen ? " ns-reader-row-openable" : ""}`} onClick={openFromCopy}>
      <Heading className="ns-reader-row-title" id={id}>{onOpen ? <button type="button" ref={setTitleButton} onClick={onOpen}>{title}</button> : title}</Heading>
      {preview && <p className="ns-reader-row-preview">{preview}</p>}
      <div className="ns-reader-story-meta">{meta}</div>
      {value && <b className="ns-reader-row-value">{value}</b>}
      {children}
    </div>
    {(onOpen || actions) && <div className="ns-reader-row-actions">
      {onOpen && <ReaderButton className="ns-read-button" aria-label={openLabel ? `阅读：${openLabel}` : undefined} onClick={onOpen}>阅读<ChevronRightRegular aria-hidden="true"/></ReaderButton>}
      {actions}
    </div>}
  </article>;
}
