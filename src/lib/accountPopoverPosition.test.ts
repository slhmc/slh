import { expect, it } from "vitest";
import { accountPopoverPosition } from "./accountPopoverPosition";

const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height });
const bounds = rect(0, 40, 1200, 740);
const menu = { width: 350, height: 400 };

it.each([
  ["top", rect(900, 50, 180, 55), { left: 730, top: 73 }],
  ["bottom", rect(900, 705, 180, 55), { left: 730, top: 257 }],
  ["left", rect(12, 650, 180, 55), { left: 200, top: 265 }],
  ["right", rect(1008, 650, 180, 55), { left: 650, top: 265 }],
] as const)("opens next to the account button with %s navigation", (dock, anchor, expected) => {
  expect(accountPopoverPosition(anchor, bounds, menu, dock)).toMatchObject(expected);
});

it("constrains large forms to the available space below top navigation", () => {
  const placement = accountPopoverPosition(rect(900, 50, 180, 55), bounds, { width: 350, height: 1000 }, "top");
  expect(placement.maxHeight).toBe(659);
  expect(placement.top + placement.maxHeight).toBeLessThanOrEqual(bounds.height - 8);
});

it("fits narrow windows and flips when the preferred side has no room", () => {
  const placement = accountPopoverPosition(rect(20, 200, 180, 55), rect(0, 40, 320, 500), menu, "right");
  expect(placement.width).toBe(304);
  expect(placement.left).toBe(8);
  expect(placement.top).toBeGreaterThanOrEqual(8);
  expect(placement.top + 400).toBeLessThanOrEqual(492);
});

it("flips side navigation inward when the anchor moves across the window", () => {
  const placement = accountPopoverPosition(rect(900, 650, 180, 55), bounds, menu, "left");
  expect(placement.left + placement.width).toBe(892);
});
