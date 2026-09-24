import { DrawerBody, DrawerHeader, DrawerHeaderTitle, OverlayDrawer, useRestoreFocusSource, useRestoreFocusTarget } from "@fluentui/react-components";
import { DismissRegular, NavigationRegular } from "@fluentui/react-icons";
import { useEffect, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { useReaderSession } from "../auth";
import { ReaderButton } from "./ReaderButton";
import "../editorial-reader.css";
import "../reader-navigation.css";
import "../reader-shell.css";

export function ReaderShell({ navigation, navigationReady = true, tools, footer, badge, children }: {
  navigation: ReactNode;
  navigationReady?: boolean;
  tools?: ReactNode;
  footer?: ReactNode;
  badge?: string;
  children: ReactNode;
}) {
  const [navigationOpen, setNavigationOpen] = useState(false);
  const { identityVerified } = useReaderSession();
  const location = useLocation();
  const restoreTarget = useRestoreFocusTarget(), restoreSource = useRestoreFocusSource();
  useEffect(() => setNavigationOpen(false), [location.pathname, location.search]);
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 769px)");
    const resized = () => { if (desktop.matches) setNavigationOpen(false); };
    desktop.addEventListener("change", resized);
    return () => desktop.removeEventListener("change", resized);
  }, []);
  const brand = <div className="ns-reader-brand">
    <span className="ns-reader-brand-mark" aria-hidden="true">𝒩</span>
    <span className="ns-reader-brand-name">NewsScout</span>
    {badge && <span className="ns-reader-badge">{badge}</span>}
  </div>;
  const destinations = <>
    <div className="ns-reader-destinations">{navigation}</div>
    {tools && <div className="ns-reader-tools"><span className="ns-reader-tools-label" aria-hidden="true">工具</span>{tools}</div>}
    {footer && <div className="ns-reader-sidebar-foot">{footer}</div>}
  </>;
  return <div className="ns-reader-shell">
    <a className="ns-reader-skip" href="#main-content">跳到主要内容</a>
    <header className="ns-reader-mobile-header">
      {brand}
      <ReaderButton {...restoreTarget} className="ns-icon-button" icon={<NavigationRegular/>} aria-label="打开导航"
        aria-expanded={navigationOpen} disabled={!navigationReady} onClick={() => setNavigationOpen(true)}/>
    </header>
    <aside className="ns-reader-sidebar">{brand}{destinations}</aside>
    <OverlayDrawer {...restoreSource} className="ns-reader-shell ns-reader-mobile-nav" open={navigationOpen}
      modalType={identityVerified ? "modal" : "non-modal"}
      position="start" onOpenChange={(_, data) => setNavigationOpen(data.open)}>
      <DrawerHeader><DrawerHeaderTitle action={<ReaderButton variant="ghost" className="ns-icon-button" icon={<DismissRegular/>}
        aria-label="关闭导航" onClick={() => setNavigationOpen(false)}/>}>{brand}</DrawerHeaderTitle></DrawerHeader>
      <DrawerBody className="ns-reader-drawer-body" onClick={event => {
        if (!(event.target instanceof Element) || !event.currentTarget.contains(event.target)) return;
        const action = event.target.closest("a,button");
        if (action && action.getAttribute("aria-haspopup") !== "dialog") setNavigationOpen(false);
      }}>{destinations}</DrawerBody>
    </OverlayDrawer>
    <main id="main-content" tabIndex={-1} className="ns-reader-main"><div className="ns-reader-content">{children}</div></main>
  </div>;
}
