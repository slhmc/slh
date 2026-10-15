/** Mac trackpads: Control-click or hold empty space for 550 ms. */
export function installMacContextMenus(target: Document = document, platform = navigator.platform) {
  if (!/Mac/i.test(platform)) return () => undefined;
  let suppressClick = false;
  let hold: { element: Element; x: number; y: number; pointerId: number } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => { clearTimeout(timer); hold = null; };
  const open = (element: Element, x: number, y: number) => {
    cancel(); suppressClick = true;
    // Release pending sidebar/card drags before opening the custom menu.
    window.dispatchEvent(new Event("slh-ui-cancel"));
    element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: x, clientY: y }));
  };
  const pointer = (event: PointerEvent) => {
    cancel(); suppressClick = false;
    if (event.button !== 0 || !(event.target instanceof Element)) return;
    const element = event.target.closest("[data-slh-context-menu]");
    if (!element || event.target.closest(".slh-context-menu")) return;
    if (event.ctrlKey) {
      event.preventDefault(); event.stopImmediatePropagation();
      open(element, event.clientX, event.clientY); return;
    }
    // Holding buttons, links and form fields must keep their usual behavior.
    if (event.target.closest('button, a, input, select, textarea, summary, canvas, [role="button"], [contenteditable="true"]')) return;
    hold = { element, x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    timer = setTimeout(() => { if (hold) open(hold.element, hold.x, hold.y); }, 550);
  };
  const move = (event: PointerEvent) => {
    if (hold && (hold.pointerId !== event.pointerId || Math.hypot(event.clientX - hold.x, event.clientY - hold.y) >= 8)) cancel();
  };
  const click = (event: MouseEvent) => {
    if (!suppressClick) return;
    suppressClick = false; event.preventDefault(); event.stopImmediatePropagation();
  };
  target.addEventListener("pointerdown", pointer, true);
  target.addEventListener("pointermove", move, true);
  target.addEventListener("pointerup", cancel, true);
  target.addEventListener("pointercancel", cancel, true);
  target.addEventListener("scroll", cancel, true);
  target.addEventListener("click", click, true);
  window.addEventListener("blur", cancel);
  return () => {
    cancel();
    target.removeEventListener("pointerdown", pointer, true);
    target.removeEventListener("pointermove", move, true);
    target.removeEventListener("pointerup", cancel, true);
    target.removeEventListener("pointercancel", cancel, true);
    target.removeEventListener("scroll", cancel, true);
    target.removeEventListener("click", click, true);
    window.removeEventListener("blur", cancel);
  };
}
