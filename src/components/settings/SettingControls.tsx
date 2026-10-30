import { Children, Fragment, cloneElement, createContext, isValidElement, useContext, useId, type ReactNode } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import { useAppStore } from "../../stores/appStore";
import styles from "../../routes/Settings/SettingsPage.module.css";

export function SettingLayout({ children }: { children: ReactNode }) {
  const compact = useAppStore(state => state.bootstrap?.settings.general.compactSettings === true);
  const minimal = useAppStore(state => state.bootstrap?.settings.appearance.minimalism === true);
  return <div className={`${styles.settingsScope} ${compact ? styles.compactSettings : ""}`} data-minimalism={minimal}>{children}</div>;
}

export function SettingGrid({ children }: { children: ReactNode }) {
  return <div className={styles.tileGrid}>{children}</div>;
}

export function SettingsSection({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  const { tr } = useI18n();
  const layout: ReactNode[] = [];
  let rows: ReactNode[] = [];
  const flush = () => { if (rows.length) { layout.push(<SettingGrid key={layout.length}>{rows}</SettingGrid>); rows = []; } };
  const flatten = (nodes: ReactNode): ReactNode[] => Children.toArray(nodes).flatMap(child =>
    isValidElement<{ children?: ReactNode }>(child) && child.type === Fragment ? flatten(child.props.children) : [child]);
  flatten(children).forEach(child => {
    if (isValidElement<{ className?: string }>(child) && child.type === SettingRow && !child.props.className) rows.push(child);
    else { flush(); layout.push(child); }
  });
  flush();
  return <div className={styles.section}><header><h2>{tr(title)}</h2><p data-minimal-text>{tr(description)}</p></header><div className={styles.sectionBody}>{layout}</div></div>;
}

const SettingLabel = createContext<string | undefined>(undefined);

export function SettingRow({ title, description, children, className = "", wide = false }: {
  title: string; description?: string; children: ReactNode; className?: string; wide?: boolean;
}) {
  const { tr } = useI18n();
  const titleId = useId();
  const toggle = Children.toArray(children).find(child => isValidElement(child) && child.type === Toggle);
  const clickable = Children.toArray(children).length === 1 && isValidElement<{ disabled?: boolean }>(toggle) && !toggle.props.disabled;
  const controls = Children.map(children, child => {
    if (!isValidElement<{ "aria-label"?: string; "aria-labelledby"?: string }>(child) || !["input", "select", "textarea"].includes(String(child.type)) || child.props["aria-label"] || child.props["aria-labelledby"]) return child;
    return cloneElement(child, { "aria-labelledby": titleId });
  });
  return <div className={`${styles.settingRow} ${wide ? styles.formSettingRow : ""} ${className} ${clickable ? styles.switchRow : ""}`} onClick={clickable ? event => {
    if (event.currentTarget.querySelector("button:disabled,input:disabled") || (event.target as HTMLElement).closest('button,input,select,textarea,a,label,[role="button"],[role="switch"]')) return;
    if (isValidElement<{ checked: boolean; onChange: (checked: boolean) => void }>(toggle)) toggle.props.onChange(!toggle.props.checked);
  } : undefined}>
    <div><strong id={titleId} data-minimal-title>{tr(title)}</strong>{description ? <p data-minimal-text>{tr(description)}</p> : null}</div>
    <div className={styles.settingControl}><SettingLabel.Provider value={tr(title)}>{controls}</SettingLabel.Provider></div>
  </div>;
}

export function Toggle({ checked, onChange, disabled, label, role = "switch" }: {
  checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; label?: string; role?: "switch" | "checkbox";
}) {
  const settingLabel = useContext(SettingLabel);
  if (role === "checkbox") return <input type="checkbox" className={styles.toggleInput} aria-label={label ?? settingLabel} checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} />;
  return <button type="button" role="switch" aria-label={label ?? settingLabel} aria-checked={checked} disabled={disabled} className={`${styles.toggle} ${checked ? styles.checked : ""}`} onClick={() => onChange(!checked)}><span /></button>;
}
