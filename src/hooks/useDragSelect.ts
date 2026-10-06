import { useEffect, useRef } from "react";

interface UseDragSelectOptions {
  scopeSelector: string;
  onSelectionChange: (paths: Set<string>, additive: boolean) => void;
  onToggle?: (path: string) => void;
}

const ITEM_SELECTOR = '[data-file-path]:not([data-directory="true"])';
const NO_DRAG_SELECTOR =
  "input, textarea, select, a, .favorite-toggle, .map-photo-favorite, .person-photo-meta button";
const DRAG_THRESHOLD = 5;
const EDGE = 48;
const MAX_SCROLL_STEP = 28;

const findScroller = (el: HTMLElement): HTMLElement => {
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      node.scrollHeight > node.clientHeight
    )
      return node;
  }
  return (document.scrollingElement as HTMLElement) ?? document.documentElement;
};

const viewRectOf = (scroller: HTMLElement) =>
  scroller === document.scrollingElement
    ? new DOMRect(0, 0, window.innerWidth, window.innerHeight)
    : scroller.getBoundingClientRect();

export const useDragSelect = ({
  scopeSelector,
  onSelectionChange,
  onToggle,
}: UseDragSelectOptions) => {
  const onChangeRef = useRef(onSelectionChange);
  onChangeRef.current = onSelectionChange;
  const onToggleRef = useRef(onToggle);
  onToggleRef.current = onToggle;
  const dragCompletedRef = useRef(false);

  useEffect(() => {
    let container: HTMLElement | null = null;
    let scroller: HTMLElement | null = null;
    // Drag origin in scroll-content coordinates so it stays anchored while scrolling.
    let origin: { x: number; y: number } | null = null;
    let startClient = { x: 0, y: 0 };
    let last = { x: 0, y: 0 };
    let startPath: string | undefined;
    let active = false;
    let additive = false;
    let box: HTMLDivElement | null = null;
    let frame = 0;
    const hits = new Set<string>();
    // Pre-drag checkbox states, restored on release so React stays the source of truth.
    const touched = new Map<HTMLInputElement, boolean>();

    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };

    const update = () => {
      frame = 0;
      if (!container || !scroller || !origin || !box) return;
      let view = viewRectOf(scroller);

      let step = 0;
      if (last.y < view.top + EDGE)
        step = -Math.min(
          MAX_SCROLL_STEP,
          Math.ceil((view.top + EDGE - last.y) / 3),
        );
      else if (last.y > view.bottom - EDGE)
        step = Math.min(
          MAX_SCROLL_STEP,
          Math.ceil((last.y - view.bottom + EDGE) / 3),
        );
      if (step) {
        const before = scroller.scrollTop;
        scroller.scrollTop += step;
        if (scroller.scrollTop !== before) schedule();
        view = viewRectOf(scroller);
      }

      const sx = scroller.scrollLeft;
      const sy = scroller.scrollTop;
      const curX = last.x - view.left + sx;
      const curY = last.y - view.top + sy;
      const left = Math.min(origin.x, curX);
      const right = Math.max(origin.x, curX);
      const top = Math.min(origin.y, curY);
      const bottom = Math.max(origin.y, curY);

      const boxLeft = Math.max(view.left, left - sx + view.left);
      const boxRight = Math.min(view.right, right - sx + view.left);
      const boxTop = Math.max(view.top, top - sy + view.top);
      const boxBottom = Math.min(view.bottom, bottom - sy + view.top);
      box.style.left = `${boxLeft}px`;
      box.style.top = `${boxTop}px`;
      box.style.width = `${Math.max(0, boxRight - boxLeft)}px`;
      box.style.height = `${Math.max(0, boxBottom - boxTop)}px`;

      hits.clear();
      container.querySelectorAll<HTMLElement>(ITEM_SELECTOR).forEach((el) => {
        const r = el.getBoundingClientRect();
        const elLeft = r.left - view.left + sx;
        const elTop = r.top - view.top + sy;
        const hit =
          elLeft + r.width >= left &&
          elLeft <= right &&
          elTop + r.height >= top &&
          elTop <= bottom;
        el.classList.toggle("drag-selecting", hit);
        const path = el.dataset.filePath;
        if (hit && path) hits.add(path);
        const checkbox = el.querySelector<HTMLInputElement>(
          'input[type="checkbox"]',
        );
        if (checkbox) {
          if (!touched.has(checkbox)) touched.set(checkbox, checkbox.checked);
          checkbox.checked =
            hit || (additive && touched.get(checkbox) === true);
        }
      });
    };

    const swallowClick = (e: MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
    };

    const suppressNextClick = () => {
      dragCompletedRef.current = true;
      window.addEventListener("click", swallowClick, {
        capture: true,
        once: true,
      });
      setTimeout(() => {
        dragCompletedRef.current = false;
        window.removeEventListener("click", swallowClick, true);
      }, 0);
    };

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      const scope = target.closest<HTMLElement>(scopeSelector);
      if (!scope || target.closest(NO_DRAG_SELECTOR)) return;
      if (target === scope && e.offsetX >= scope.clientWidth) return; // scrollbar
      e.preventDefault(); // blocks native image drag and text selection
      container = scope;
      scroller = findScroller(scope);
      const view = viewRectOf(scroller);
      origin = {
        x: e.clientX - view.left + scroller.scrollLeft,
        y: e.clientY - view.top + scroller.scrollTop,
      };
      startClient = { x: e.clientX, y: e.clientY };
      last = startClient;
      additive = e.metaKey || e.ctrlKey;
      startPath = target.closest<HTMLElement>(ITEM_SELECTOR)?.dataset.filePath;
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!origin) return;
      last = { x: e.clientX, y: e.clientY };
      if (!active) {
        if (
          Math.hypot(last.x - startClient.x, last.y - startClient.y) <
          DRAG_THRESHOLD
        )
          return;
        active = true;
        box = document.createElement("div");
        box.className = "drag-selection-box";
        document.body.appendChild(box);
      }
      schedule();
    };

    const onScroll = () => {
      if (active) schedule();
    };

    const onContextMenu = (e: MouseEvent) => {
      // macOS turns Ctrl+click into a context menu; keep it as a selection toggle inside the grid.
      if (e.ctrlKey && (e.target as HTMLElement).closest?.(scopeSelector))
        e.preventDefault();
    };

    const finish = () => {
      if (!origin) return;
      const wasActive = active;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      if (wasActive) update();
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      box?.remove();
      box = null;
      container
        ?.querySelectorAll(".drag-selecting")
        .forEach((el) => el.classList.remove("drag-selecting"));
      touched.forEach((checked, checkbox) => {
        checkbox.checked = checked;
      });
      touched.clear();
      const toggledPath = !wasActive && additive ? startPath : undefined;
      origin = null;
      active = false;
      container = null;
      scroller = null;
      startPath = undefined;
      if (wasActive) {
        suppressNextClick();
        onChangeRef.current(new Set(hits), additive);
      } else if (toggledPath && onToggleRef.current) {
        suppressNextClick();
        onToggleRef.current(toggledPath);
      }
    };

    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", finish);
    document.addEventListener("scroll", onScroll, true);
    document.addEventListener("contextmenu", onContextMenu);
    window.addEventListener("blur", finish);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", finish);
      document.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("contextmenu", onContextMenu);
      window.removeEventListener("blur", finish);
      if (frame) cancelAnimationFrame(frame);
      box?.remove();
    };
  }, [scopeSelector]);

  return { dragCompletedRef };
};
