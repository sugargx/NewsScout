import { mergeClasses } from "@fluentui/react-components";
import type { ReactNode } from "react";
import { useStyles } from "../styles";
import "../editorial-reader.css";
import "../reader-navigation.css";

export function ReaderShell({ navigation, utility, badge, children }: {
  navigation: ReactNode;
  utility?: ReactNode;
  badge?: string;
  children: ReactNode;
}) {
  const styles = useStyles();
  return <div className={mergeClasses(styles.root, "ns-reader-shell")}>
    <div className={styles.shell}>
      <a className={styles.skipLink} href="#main-content">跳到主要内容</a>
      <aside className={mergeClasses(styles.sidebar, "ns-reader-sidebar")}>
        <div className="ns-reader-brand">
          <span className="ns-reader-brand-mark" aria-hidden="true">N</span>
          <div className="ns-reader-brand-copy"><div className={styles.brand}>NewsScout</div>
            {badge && <span className="ns-reader-badge">{badge}</span>}</div>
        </div>
        <div className={mergeClasses(styles.tagline, "ns-reader-tagline")}>安静、可追溯的编辑式阅读</div>
        {navigation}
        {utility && <div className="ns-reader-utility">{utility}</div>}
      </aside>
      <main id="main-content" tabIndex={-1} className={mergeClasses(styles.main, "ns-reader-main")}>
        {children}
      </main>
    </div>
  </div>;
}
