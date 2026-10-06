import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./InteractiveTooltip.css";

interface TooltipState {
  text: string;
  left: number;
  top: number;
}

const actionableSelector =
  "button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=menuitem]";

export default function InteractiveTooltip() {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const timerRef = useRef<number | null>(null);
  const activeTargetRef = useRef<HTMLElement | null>(null);
  const nativeTitleRef = useRef<{ element: HTMLElement; title: string } | null>(
    null,
  );

  useEffect(() => {
    const clear = () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
      const nativeTitle = nativeTitleRef.current;
      if (nativeTitle?.element.isConnected && !nativeTitle.element.hasAttribute("title")) {
        nativeTitle.element.setAttribute("title", nativeTitle.title);
      }
      nativeTitleRef.current = null;
      activeTargetRef.current = null;
      setTooltip(null);
    };

    const show = (element: HTMLElement, delay: number) => {
      const directHelp = element.dataset.help?.trim();
      const contextHelp = element
        .closest<HTMLElement>("[data-help]")
        ?.dataset.help?.trim();
      if (
        (element.hasAttribute("title") && !directHelp) ||
        element.matches(":disabled")
      ) {
        clear();
        return;
      }
      const label =
        element.getAttribute("aria-label")?.trim() ||
        element.getAttribute("title")?.trim() ||
        element.getAttribute("placeholder")?.trim() ||
        element.innerText?.replace(/\s+/g, " ").trim();
      const text =
        directHelp ||
        (contextHelp && label ? `${label}: ${contextHelp}` : contextHelp) ||
        label;
      if (!text) {
        clear();
        return;
      }
      if (activeTargetRef.current === element) return;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      if (directHelp && element.hasAttribute("title")) {
        nativeTitleRef.current = {
          element,
          title: element.getAttribute("title") ?? "",
        };
        element.removeAttribute("title");
      }
      activeTargetRef.current = element;
      timerRef.current = window.setTimeout(() => {
        if (!element.isConnected) return clear();
        const bounds = element.getBoundingClientRect();
        const left = Math.min(
          Math.max(12, bounds.left + bounds.width / 2 - 130),
          Math.max(12, window.innerWidth - 272),
        );
        const estimatedHeight = 120;
        const top =
          bounds.bottom + 10 + estimatedHeight < window.innerHeight
            ? bounds.bottom + 10
            : Math.max(8, bounds.top - estimatedHeight);
        setTooltip({ text, left, top });
      }, delay);
    };

    const findTarget = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return null;
      return target.closest<HTMLElement>(actionableSelector);
    };

    const pointerOver = (event: PointerEvent) => {
      const element = findTarget(event.target);
      if (element) show(element, 450);
    };
    const pointerOut = (event: PointerEvent) => {
      const element = findTarget(event.target);
      if (!element) return;
      if (event.relatedTarget instanceof Node && element.contains(event.relatedTarget))
        return;
      if (activeTargetRef.current === element) clear();
    };
    const focusIn = (event: FocusEvent) => {
      const element = findTarget(event.target);
      if (element) show(element, 250);
    };
    const focusOut = (event: FocusEvent) => {
      const element = findTarget(event.target);
      if (element && activeTargetRef.current === element) clear();
    };

    document.addEventListener("pointerover", pointerOver, true);
    document.addEventListener("pointerout", pointerOut, true);
    document.addEventListener("focusin", focusIn, true);
    document.addEventListener("focusout", focusOut, true);
    return () => {
      clear();
      document.removeEventListener("pointerover", pointerOver, true);
      document.removeEventListener("pointerout", pointerOut, true);
      document.removeEventListener("focusin", focusIn, true);
      document.removeEventListener("focusout", focusOut, true);
    };
  }, []);

  if (!tooltip) return null;
  return createPortal(
    <div
      className="interactive-tooltip"
      role="tooltip"
      style={{ left: tooltip.left, top: tooltip.top }}
    >
      {tooltip.text}
    </div>,
    document.body,
  );
}
