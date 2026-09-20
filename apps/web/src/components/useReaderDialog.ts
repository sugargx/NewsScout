import { useEffect, type RefObject } from "react";

export function useReaderDialog(pane: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const slot = pane.current?.closest<HTMLElement>(".ns-preview-slot,.ns-topic-detail");
    if (!slot?.closest(".ns-reader-workspace,.ns-topic-workspace")) return;
    const media = window.matchMedia("(max-width: 980px)");
    let release: () => void = () => {};
    const update = () => {
      release(); release = () => {};
      if (!media.matches) return;
      const background: HTMLElement[] = [];
      for (let current: HTMLElement | null = slot; current?.parentElement && current !== document.body; current = current.parentElement) {
        for (const sibling of current.parentElement.children)
          if (sibling instanceof HTMLElement && sibling !== current) background.push(sibling);
      }
      const previous = background.map(node => ({node, ariaHidden: node.getAttribute("aria-hidden"), inert: node.inert}));
      const overflow = document.body.style.overflow;
      const attributes = ["role", "aria-modal", "aria-label"].map(name => ({name, value: slot.getAttribute(name)}));
      slot.setAttribute("role", "dialog"); slot.setAttribute("aria-modal", "true"); slot.setAttribute("aria-label", "文章阅读窗口");
      if (!pane.current?.contains(document.activeElement)) pane.current?.focus({preventScroll: true});
      previous.forEach(({node}) => {node.setAttribute("aria-hidden", "true"); node.inert = true;});
      document.body.style.overflow = "hidden";
      const trap = (event: KeyboardEvent) => {
        if (event.key !== "Tab" || event.defaultPrevented) return;
        const items = Array.from(pane.current?.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])') ?? [])
          .filter(node => node.getClientRects().length > 0 && !node.closest("[inert]"));
        const first = items[0], last = items.at(-1);
        if (!first || !last) {event.preventDefault(); pane.current?.focus(); return;}
        const outside = document.activeElement === pane.current || !pane.current?.contains(document.activeElement);
        if (event.shiftKey && (outside || document.activeElement === first)) {event.preventDefault(); last.focus();}
        else if (!event.shiftKey && (outside || document.activeElement === last)) {event.preventDefault(); first.focus();}
      };
      window.addEventListener("keydown", trap);
      release = () => {
        window.removeEventListener("keydown", trap);
        document.body.style.overflow = overflow;
        previous.forEach(({node, ariaHidden, inert}) => {
          if (ariaHidden === null) node.removeAttribute("aria-hidden"); else node.setAttribute("aria-hidden", ariaHidden);
          node.inert = inert;
        });
        attributes.forEach(({name, value}) => {if (value === null) slot.removeAttribute(name); else slot.setAttribute(name, value);});
      };
    };
    update(); media.addEventListener("change", update);
    return () => {media.removeEventListener("change", update); release();};
  }, [pane]);
}
