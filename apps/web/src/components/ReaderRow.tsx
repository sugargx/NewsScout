import { mergeClasses } from "@fluentui/react-components";
import { useId, type HTMLAttributes, type MouseEventHandler, type ReactNode, type Ref } from "react";
import { useStyles } from "../styles";

export function ReaderRow({ title, meta, preview, actions, children, onOpen, selected = false, headingLevel: Heading = "h2", titleRef, ...attributes }: Omit<HTMLAttributes<HTMLElement>, "title"> & {
  title: ReactNode; meta: ReactNode; preview: ReactNode; actions?: ReactNode;
  onOpen?: MouseEventHandler<HTMLButtonElement>; selected?: boolean; headingLevel?: "h2" | "h3"; titleRef?: Ref<HTMLButtonElement>;
}) {
  const styles = useStyles(), id = useId();
  return <article {...attributes} aria-labelledby={id} className={mergeClasses(styles.newsRow, selected && styles.newsRowSelected, "ns-reader-row", attributes.className)}>
    <div className={styles.rowContent}>
      <div className={styles.articleMeta}>{meta}</div>
      <Heading className={`${styles.rowTitle} ns-reader-row-title`} id={id}>{onOpen ? <button className={styles.articleTitleButton} type="button" ref={titleRef} onClick={onOpen}>{title}</button> : title}</Heading>
      <p className={styles.rowPreview}>{preview}</p>
      {children}
    </div>
    {actions && <div className={styles.rowActions}>{actions}</div>}
  </article>;
}
