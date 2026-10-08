type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };
type Dock = "top" | "bottom" | "left" | "right";

export function accountPopoverPosition(anchor: Rect, bounds: Rect, menu: { width: number; height: number }, dock: Dock) {
  const gap = 8;
  const width = Math.min(menu.width, Math.max(0, bounds.width - gap * 2));
  const room = {
    top: anchor.top - bounds.top - gap * 2,
    bottom: bounds.bottom - anchor.bottom - gap * 2,
    left: anchor.left - bounds.left - gap * 2,
    right: bounds.right - anchor.right - gap * 2,
  };
  let side: Dock = dock === "top" ? "bottom" : dock === "bottom" ? "top" : dock === "left" ? "right" : "left";
  const opposite: Record<Dock, Dock> = { top: "bottom", bottom: "top", left: "right", right: "left" };
  const required = side === "top" || side === "bottom" ? menu.height : width;
  if (room[side] < required && room[opposite[side]] > room[side]) side = opposite[side];
  const maxHeight = Math.max(0, Math.min(bounds.height - gap * 2, side === "top" || side === "bottom" ? room[side] : bounds.height));
  const height = Math.min(menu.height, maxHeight);
  let left = side === "left" ? anchor.left - width - gap : side === "right" ? anchor.right + gap : anchor.right - width;
  let top = side === "bottom" ? anchor.bottom + gap : side === "top" ? anchor.top - height - gap : anchor.bottom - height;
  left = Math.max(bounds.left + gap, Math.min(left, bounds.right - width - gap));
  top = Math.max(bounds.top + gap, Math.min(top, bounds.bottom - height - gap));
  return { left: left - bounds.left, top: top - bounds.top, width, maxHeight };
}
