// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { HomeCharacterFpsControl } from "./HomeCharacterFpsControl";
vi.mock("../../i18n/I18nProvider", () => ({ useI18n: () => ({ tr: (value: string) => value }) }));
afterEach(cleanup);

it("snaps pointer input to 30 and persists once when dragging finishes", () => {
  const onCommit = vi.fn();
  const view = render(<HomeCharacterFpsControl value={20} onCommit={onCommit} />);
  const slider = view.getByRole("slider");
  fireEvent.pointerDown(slider);
  fireEvent.change(slider, { target: { value: "29" } });
  expect((slider as HTMLInputElement).value).toBe("30");
  expect(onCommit).not.toHaveBeenCalled();
  fireEvent.pointerUp(slider);
  fireEvent.blur(slider);
  expect(onCommit).toHaveBeenCalledExactlyOnceWith(30);
});

it("allows exact keyboard values around the magnet and unlimited at the end", () => {
  const onCommit = vi.fn();
  const view = render(<HomeCharacterFpsControl onCommit={onCommit} />);
  const slider = view.getByRole("slider");
  fireEvent.keyDown(slider, { key: "ArrowRight" });
  fireEvent.change(slider, { target: { value: "31" } });
  fireEvent.keyUp(slider, { key: "ArrowRight" });
  expect(onCommit).toHaveBeenLastCalledWith(31);
  fireEvent.change(slider, { target: { value: "61" } });
  fireEvent.blur(slider);
  expect(slider.getAttribute("aria-valuetext")).toBe("Unlimited");
  expect(onCommit).toHaveBeenLastCalledWith(0);
  fireEvent.click(view.getByRole("button", { name: "Set 30 FPS" }));
  expect(onCommit).toHaveBeenLastCalledWith(30);
});

it("snaps dragging to 60 while preserving unlimited and exact keyboard input", () => {
  const onCommit = vi.fn();
  const view = render(<HomeCharacterFpsControl value={50} onCommit={onCommit} />);
  const slider = view.getByRole("slider");
  fireEvent.pointerDown(slider);
  fireEvent.change(slider, { target: { value: "58" } });
  expect((slider as HTMLInputElement).value).toBe("60");
  fireEvent.pointerUp(slider);
  expect(onCommit).toHaveBeenLastCalledWith(60);
  fireEvent.keyDown(slider, { key: "ArrowLeft" });
  fireEvent.change(slider, { target: { value: "59" } });
  fireEvent.keyUp(slider, { key: "ArrowLeft" });
  expect(onCommit).toHaveBeenLastCalledWith(59);
  fireEvent.pointerDown(slider);
  fireEvent.change(slider, { target: { value: "61" } });
  fireEvent.pointerUp(slider);
  expect(onCommit).toHaveBeenLastCalledWith(0);
  fireEvent.click(view.getByRole("button", { name: "60 FPS" }));
  expect(onCommit).toHaveBeenLastCalledWith(60);
});
