import type { HTMLAttributes, ReactNode, Ref } from "react";
import { Cube, ListBullets, SquaresFour } from "../icons";
import { useUiText } from "../../i18n/UiText";
import chrome from "./LibraryChrome.module.css";
import library from "../../routes/Library/LibraryPage.module.css";
import card from "../instance/InstanceCard.module.css";
import artwork from "../instance/InstanceArtwork.module.css";
import panel from "../instance/InstanceSidePanel.module.css";
import detail from "../../routes/Instance/InstancePage.module.css";

export function LibraryFrame({
  className = "",
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...props}
      className={`${library.layout} ${chrome.frame} ${className}`}
    />
  );
}
export function LibraryToolbar(props: HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...props} className={`${library.toolbar} ${props.className ?? ""}`} />
  );
}
export function LibraryGroupHeader(props: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...props}
      className={`${library.groupHeader} ${props.className ?? ""}`}
    />
  );
}
export function LibraryViews({
  value,
  onChange,
}: {
  value: string;
  onChange: (view: string) => void;
}) {
  const t = useUiText();
  return (
    <div
      className={library.viewSwitch}
      role="group"
      aria-label={t("library.libraryView")}
    >
      {[
        ["grid", SquaresFour, "library.gridView"],
        ["icons", Cube, "library.iconView"],
        ["list", ListBullets, "library.listView"],
      ].map(([key, Icon, label]) => {
        const Component = Icon as typeof Cube;
        return (
          <button
            type="button"
            key={String(key)}
            className={value === key ? library.active : ""}
            aria-pressed={value === key}
            aria-label={t(String(label))}
            title={t(String(label))}
            onClick={() => onChange(String(key))}
          >
            <Component size={18} />
          </button>
        );
      })}
    </div>
  );
}
export function LibraryCardSurface({
  view,
  selected,
  className = "",
  ...props
}: HTMLAttributes<HTMLElement> & { view: string; selected: boolean }) {
  const Tag = view === "list" ? "div" : "article";
  return (
    <Tag
      {...props}
      className={`${view === "list" ? card.listRow : card.card} ${view === "icons" ? card.iconCard : ""} ${selected ? card.selected : ""} ${className}`}
    />
  );
}
export function LibraryArtwork({
  size = "card",
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  size?: "small" | "card" | "large" | "icon";
}) {
  return (
    <div
      {...props}
      className={`${artwork.artwork} ${artwork[size]} ${props.className ?? ""}`}
      aria-hidden="true"
    >
      {children}
    </div>
  );
}
export function DetailFrame({
  position,
  children,
  className = "",
}: {
  position: string;
  children: ReactNode;
  className?: string;
}) {
  const positionClass =
    position === "left"
      ? detail.tabsLeft
      : position === "right"
        ? detail.tabsRight
        : position === "bottom"
          ? detail.tabsBottom
          : "";
  return (
    <div
      className={`${detail.page} ${chrome.detailFrame} ${positionClass} ${className}`}
    >
      {children}
    </div>
  );
}
export function DetailTabs(props: HTMLAttributes<HTMLElement>) {
  return (
    <nav {...props} className={`${detail.tabs} ${props.className ?? ""}`} />
  );
}

export function LibrarySidePanelSurface(props: HTMLAttributes<HTMLElement>) {
  return (
    <aside {...props} className={`${panel.panel} ${props.className ?? ""}`} />
  );
}

export function LibraryMenuSurface(
  props: HTMLAttributes<HTMLDivElement> & { ref?: Ref<HTMLDivElement> },
) {
  return (
    <div
      {...props}
      className={`${library.contextMenu} slh-context-menu ${props.className ?? ""}`}
    />
  );
}
