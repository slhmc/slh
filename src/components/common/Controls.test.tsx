// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { Button } from "./Controls";
import { Check } from "../icons";

afterEach(cleanup);

it("keeps the action icon size when showing the busy indicator", () => {
  const icon = <Check size={18} />;
  const view = render(<Button icon={icon} aria-label="Save" />);
  const button = screen.getByRole("button", { name: "Save" });
  expect(button.querySelector("svg")?.getAttribute("width")).toBe("18");
  view.rerender(<Button icon={icon} busy aria-label="Save" />);
  expect(button.querySelector("svg")?.getAttribute("width")).toBe("18");
  expect(button.querySelector("svg")?.getAttribute("height")).toBe("18");
});

it("replaces its action icon while busy and restores it after completion", () => {
  const icon = <svg data-testid="action-icon" aria-hidden="true" />;
  const view = render(<Button icon={icon}>Refresh</Button>);
  const button = screen.getByRole("button", { name: "Refresh" });
  expect(screen.queryByTestId("action-icon")).not.toBeNull();
  view.rerender(<Button icon={icon} busy>Refresh</Button>);
  expect(screen.queryByTestId("action-icon")).toBeNull();
  expect(button.querySelectorAll("svg")).toHaveLength(1);
  expect(button.getAttribute("aria-busy")).toBe("true");
  expect((button as HTMLButtonElement).disabled).toBe(true);
  view.rerender(<Button icon={icon}>Refresh</Button>);
  expect(screen.queryByTestId("action-icon")).not.toBeNull();
  expect(button.hasAttribute("aria-busy")).toBe(false);
  expect((button as HTMLButtonElement).disabled).toBe(false);
});

it("preserves labels and a caller's disabled state without an action icon", () => {
  const view = render(<Button busy disabled><span>Save</span></Button>);
  const button = screen.getByRole("button", { name: "Save" });
  expect(button.querySelectorAll("svg")).toHaveLength(1);
  view.rerender(<Button disabled><span>Save</span></Button>);
  expect(button.querySelectorAll("svg")).toHaveLength(0);
  expect((button as HTMLButtonElement).disabled).toBe(true);
});
