import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, Export as UploadIcon, Image, Plus, SpinnerGap, Trash, X } from "../icons";
import { Dialog } from "../common/Dialog";
import common from "../common/Common.module.css";
import { useI18n } from "../../i18n/I18nProvider";
import { command } from "../../lib/tauri";
import { useWindowActivity } from "../../lib/windowActivity";
import type { Account, AccountAppearance, AccountTexture } from "../../lib/types";
import { MinecraftSkinViewer } from "./MinecraftSkinViewer";
import styles from "./AccountAppearanceDialog.module.css";
// Inline bundled textures so the portable Tauri build can use them without a
// relative asset request being rejected by CSP.
import steveSkin from "../../assets/skins/Steve.png?inline";
import alexSkin from "../../assets/skins/Alex.png?inline";
import ariSkin from "../../assets/skins/Ari.png?inline";
import efeSkin from "../../assets/skins/Efe.png?inline";
import kaiSkin from "../../assets/skins/Kai.png?inline";
import makenaSkin from "../../assets/skins/Makena.png?inline";
import noorSkin from "../../assets/skins/Noor.png?inline";
import sunnySkin from "../../assets/skins/Sunny.png?inline";
import zuriSkin from "../../assets/skins/Zuri.png?inline";

interface Props {
  account: Account | null;
  onClose: () => void;
  onChanged?: () => void | Promise<void>;
}

interface PendingSkin {
  name: string;
  bytes: number[];
  dataUrl: string;
}

const DEFAULT_SKINS = [
  { name: "Steve", model: "classic" as const, url: steveSkin },
  { name: "Alex", model: "slim" as const, url: alexSkin },
  { name: "Sunny", model: "classic" as const, url: sunnySkin },
  { name: "Noor", model: "classic" as const, url: noorSkin },
  { name: "Efe", model: "classic" as const, url: efeSkin },
  { name: "Ari", model: "classic" as const, url: ariSkin },
  { name: "Kai", model: "classic" as const, url: kaiSkin },
  { name: "Makena", model: "classic" as const, url: makenaSkin },
  { name: "Zuri", model: "classic" as const, url: zuriSkin },
];
type DefaultSkin = (typeof DEFAULT_SKINS)[number];

function skinModel(variant: string | null | undefined): "classic" | "slim" {
  return variant?.trim().toLowerCase() === "slim" ? "slim" : "classic";
}

function errorMessage(reason: unknown) {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "object" && reason !== null && "message" in reason && typeof reason.message === "string") return reason.message;
  return String(reason);
}

function mergeAppearanceState(
  base: AccountAppearance,
  snapshots: AccountAppearance[],
  preferredSkinId?: string,
  preferredCapeId?: string | null,
): AccountAppearance {
  const skinMap = new Map<string, AccountTexture>();
  const capeMap = new Map<string, AccountTexture>();
  for (const appearance of [base, ...snapshots]) {
    for (const skin of appearance.skins) skinMap.set(skin.id, { ...skin });
    for (const cape of appearance.capes) capeMap.set(cape.id, { ...cape });
  }
  const skins = [...skinMap.values()];
  const capes = [...capeMap.values()];
  // A previous cache version could retain `active: true` on every locally
  // saved skin. A profile has exactly one active skin; prefer the newly
  // uploaded one, otherwise preserve the first active server skin.
  const activeSkinId = preferredSkinId && skins.some((skin) => skin.id === preferredSkinId)
    ? preferredSkinId
    : [...skins].reverse().find((skin) => skin.active)?.id ?? skins[0]?.id;
  for (const skin of skins) skin.active = skin.id === activeSkinId;
  if (preferredCapeId !== undefined) {
    for (const cape of capes) cape.active = preferredCapeId !== null && cape.id === preferredCapeId;
  }
  return { ...snapshots[snapshots.length - 1] ?? base, skins, capes };
}

async function fileToPending(file: File): Promise<PendingSkin> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  return { name: file.name || "skin.png", bytes: Array.from(bytes), dataUrl };
}

function inlineTextureToPending(dataUrl: string, name: string): PendingSkin {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) throw new Error("Skin texture is invalid");
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return { name: `${name.toLowerCase()}.png`, bytes: Array.from(bytes), dataUrl };
}

function SkinCard({ texture, busy, selected, onSelect }: { texture: AccountTexture; busy: boolean; selected: boolean; onSelect: () => void }) {
  const { tr } = useI18n();
  const model = skinModel(texture.variant);
  return (
    <button className={`${styles.skinCard} ${texture.active ? styles.activeSkin : ""} ${selected ? styles.selectedSkin : ""}`} type="button" disabled={busy} onClick={onSelect}>
      <MinecraftSkinViewer skin={texture.dataUrl} model={model} compact label={texture.alias ?? tr("Saved skin")} />
      <span>{texture.alias ?? tr("Saved skin")}</span>
      {texture.active ? <i><Check size={14} /> {tr("Active")}</i> : null}
    </button>
  );
}

export function AccountAppearanceDialog({ account, onClose, onChanged }: Props) {
  const { tr } = useI18n();
  const fileInput = useRef<HTMLInputElement>(null);
  const [appearance, setAppearance] = useState<AccountAppearance | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [pendingSkin, setPendingSkin] = useState<PendingSkin | null>(null);
  const [variant, setVariant] = useState<"classic" | "slim">("classic");
  const [capeId, setCapeId] = useState<string | null>(null);
  const [skinChangeLockedUntil, setSkinChangeLockedUntil] = useState(0);
  const [cooldownClock, setCooldownClock] = useState(() => Date.now());
  const [selectedDefault, setSelectedDefault] = useState<DefaultSkin | null>(null);
  const [selectedSavedSkinId, setSelectedSavedSkinId] = useState<string | null>(null);
  const [cooldownFlashing, setCooldownFlashing] = useState(false);
  const filePickerActive = useRef(false);

  const skinChangeCooldownMs = 5_000;
  const skinChangeCoolingDown = skinChangeLockedUntil > cooldownClock;
  const skinChangeWaitSeconds = Math.max(0, Math.ceil((skinChangeLockedUntil - cooldownClock) / 1_000));

  const startSkinChangeCooldown = () => {
    const now = Date.now();
    setCooldownClock(now);
    setSkinChangeLockedUntil(now + skinChangeCooldownMs);
  };

  const flashCooldown = () => {
    setCooldownFlashing(true);
    window.setTimeout(() => setCooldownFlashing(false), 750);
  };

  const resetEditorDraft = () => {
    const currentSkin = (selectedSavedSkinId ? appearance?.skins.find((skin) => skin.id === selectedSavedSkinId) : undefined) ?? appearance?.skins.find((skin) => skin.active) ?? appearance?.skins[0];
    const currentCape = appearance?.capes.find((cape) => cape.active);
    setVariant(skinModel(currentSkin?.variant));
    setCapeId(currentCape?.id ?? null);
    setPendingSkin(null);
  };

  const openEditor = () => {
    resetEditorDraft();
    if (selectedDefault) {
      setVariant(selectedDefault.model);
      setPendingSkin(inlineTextureToPending(selectedDefault.url, selectedDefault.name));
    }
    setEditorOpen(true);
  };

  const closeEditor = () => {
    setPendingSkin(null);
    setSelectedDefault(null);
    setSelectedSavedSkinId(null);
    setEditorOpen(false);
  };

  const openFilePicker = () => {
    filePickerActive.current = true;
    fileInput.current?.click();
  };

  const applyAppearance = (next: AccountAppearance) => {
    const firstActiveSkin = next.skins.find((skin) => skin.active) ?? next.skins[0];
    const normalized: AccountAppearance = {
      ...next,
      skins: next.skins.map((skin) => ({ ...skin, active: skin.id === firstActiveSkin?.id })),
    };
    setAppearance(normalized);
    const activeSkin = firstActiveSkin;
    setVariant(skinModel(activeSkin?.variant));
    setCapeId(normalized.capes.find((cape) => cape.active)?.id ?? null);
  };

  const reload = async () => {
    if (!account) return;
    setLoading(true);
    setError(null);
    try {
      const next = await command<AccountAppearance>("get_account_appearance", { accountId: account.id });
      applyAppearance(next);
    } catch (reason) {
      setError(tr(errorMessage(reason)));
      // A transient Microsoft rate limit must not erase an already loaded
      // list of skins/capes from the current editor.
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setAppearance(null);
    setEditorOpen(false);
    setPendingSkin(null);
    setCapeId(null);
    setVariant("classic");
    if (account?.provider !== "offline") void reload();
  }, [account?.id, account?.provider]);

  const windowActive = useWindowActivity();
  useEffect(() => {
    if (!skinChangeCoolingDown || !windowActive) return undefined;
    setCooldownClock(Date.now());
    const timer = window.setInterval(() => setCooldownClock(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [skinChangeCoolingDown, skinChangeLockedUntil, windowActive]);

  // A native file picker can close without firing `change` or `cancel` in WebView2.
  // Keep the editor open and clear the guard when focus returns to the launcher.
  useEffect(() => {
    const handleFocus = () => {
      if (filePickerActive.current) {
        window.setTimeout(() => { filePickerActive.current = false; }, 0);
      }
    };
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, []);

  useEffect(() => {
    const input = fileInput.current;
    if (!input) return undefined;
    // `cancel` bubbles from a file input. Without stopping it, the enclosing
    // dialog treats Explorer's Cancel button as its own cancel event.
    const handleCancel = (event: Event) => {
      event.stopPropagation();
      filePickerActive.current = false;
    };
    input.addEventListener("cancel", handleCancel);
    return () => input.removeEventListener("cancel", handleCancel);
  }, []);

  const mutate = async (action: () => Promise<AccountAppearance | void>): Promise<AccountAppearance | undefined> => {
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      const merged = next && appearance ? mergeAppearanceState(appearance, [next]) : next;
      if (merged) applyAppearance(merged);
      await onChanged?.();
      if (account?.id) window.dispatchEvent(new CustomEvent("slh-account-avatar-updated", { detail: account.id }));
      return merged ?? undefined;
    } catch (reason) {
      setError(tr(errorMessage(reason)));
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  const chooseFile = async (file?: File) => {
    if (!file) return;
    try {
      setPendingSkin(await fileToPending(file));
      setEditorOpen(true);
    } catch (reason) {
      setError(tr(errorMessage(reason)));
    }
  };

  const chooseDefault = (skin: DefaultSkin) => {
    setSelectedDefault(skin);
    setSelectedSavedSkinId(null);
  };

  const chooseSavedSkin = (texture: AccountTexture) => {
    setSelectedSavedSkinId(texture.id);
    setSelectedDefault(null);
  };

  const applySelectedSkin = async () => {
    if (!appearance) return;
    const selectedSaved = selectedSavedSkinId ? appearance.skins.find((skin) => skin.id === selectedSavedSkinId) : undefined;
    if (!selectedSaved && !selectedDefault) return;
    // The active saved skin is already applied. Do not send a redundant
    // Minecraft Services upload (which would also consume the rate limit).
    if (selectedSaved?.active) return;
    if (skinChangeCoolingDown) {
      flashCooldown();
      return;
    }
    const changed = await mutate(async () => {
      const pending = selectedDefault
        ? inlineTextureToPending(selectedDefault.url, selectedDefault.name)
        : inlineTextureToPending(selectedSaved!.dataUrl!, selectedSaved!.alias ?? "saved-skin");
      return command<AccountAppearance>("upload_account_skin_bytes", {
        accountId: appearance.accountId,
        pngBytes: pending.bytes,
        fileName: pending.name,
        variant: selectedDefault?.model ?? skinModel(selectedSaved?.variant),
        existingSkinId: selectedSaved?.id,
      });
    });
    if (changed) {
      startSkinChangeCooldown();
      onClose();
    }
  };

  const deleteSavedSkin = async (texture: AccountTexture) => {
    if (!appearance) return;
    const next = await mutate(() => command<AccountAppearance>("delete_saved_account_skin", {
      accountId: appearance.accountId,
      skinId: texture.id,
    }));
    if (next) {
      // A very old cache can lack a local gallery ID even though the open UI
      // still has it. Removing it locally is safe and prevents a misleading
      // server "not found" error from blocking the intended deletion.
      applyAppearance({ ...next, skins: next.skins.filter((skin) => skin.id !== texture.id) });
      setPendingSkin(null);
      setSelectedDefault(null);
      setEditorOpen(false);
    }
  };

  const saveEditor = async () => {
    if (!appearance) return;
    const needsSkinUpload = pendingSkin !== null || variant !== skinModel(editorSkin?.variant);
    if (needsSkinUpload && skinChangeCoolingDown) {
      flashCooldown();
      return;
    }
    const saved = await mutate(async () => {
      const snapshots: AccountAppearance[] = [];
      const activeVariant = skinModel(editorSkin?.variant);
      let skinToUpload = pendingSkin;
      if (!skinToUpload && variant !== activeVariant && editorSkin?.dataUrl) {
        const response = await fetch(editorSkin.dataUrl);
        const file = new File([await response.blob()], "skin.png", { type: "image/png" });
        skinToUpload = await fileToPending(file);
      }
      if (skinToUpload) {
        snapshots.push(await command<AccountAppearance>("upload_account_skin_bytes", {
          accountId: appearance.accountId,
        pngBytes: skinToUpload.bytes,
        fileName: skinToUpload.name,
        variant,
        // Replacing the texture of a selected gallery card must retain the
        // card's local ID instead of creating another saved skin.
        existingSkinId: selectedSavedSkin?.id,
      }));
      }
      const previousCape = appearance.capes.find((cape) => cape.active)?.id ?? null;
      const capeChanged = capeId !== previousCape;
      if (capeId !== previousCape) {
        snapshots.push(await command<AccountAppearance>("select_account_cape", { accountId: appearance.accountId, capeId }));
      }
      if (snapshots.length === 0) return appearance;
      return mergeAppearanceState(appearance, snapshots, undefined, capeChanged ? capeId : undefined);
    });
    if (saved) {
      if (pendingSkin || variant !== skinModel(editorSkin?.variant)) startSkinChangeCooldown();
      applyAppearance(saved);
      setPendingSkin(null);
      setSelectedDefault(null);
      setEditorOpen(false);
    }
  };

  if (account?.provider === "offline") return null;
  const activeSkin = appearance?.skins.find((texture) => texture.active) ?? appearance?.skins[0];
  const selectedSavedSkin = selectedSavedSkinId ? appearance?.skins.find((skin) => skin.id === selectedSavedSkinId) : undefined;
  const editorSkin = selectedSavedSkin ?? activeSkin;
  const canApplySelectedSkin = Boolean(selectedDefault || (selectedSavedSkin && !selectedSavedSkin.active));
  const activeCape = appearance?.capes.find((texture) => texture.active) ?? null;
  const catalogSkin = selectedDefault?.url ?? selectedSavedSkin?.dataUrl ?? activeSkin?.dataUrl ?? null;
  const catalogModel = selectedDefault?.model ?? skinModel(selectedSavedSkin?.variant ?? activeSkin?.variant);
  const previewSkin = pendingSkin?.dataUrl ?? editorSkin?.dataUrl ?? null;
  const previewCape = appearance?.capes.find((cape) => cape.id === capeId)?.dataUrl ?? null;
  const title = editorOpen ? tr("Skin settings") : `${tr("Skin selection")} · ${account?.username ?? ""}`;

  return (
    <Dialog open={Boolean(account)} title={title} description={editorOpen ? tr("Change texture, arm type, and cape.") : tr("Choose a saved or default Minecraft skin.")} onClose={() => { if (filePickerActive.current) return; if (editorOpen) { closeEditor(); return; } onClose(); }} width="xlarge">
      <input ref={fileInput} className={styles.fileInput} type="file" accept="image/png" onChange={(event) => { filePickerActive.current = false; void chooseFile(event.target.files?.[0]); event.currentTarget.value = ""; }} />
      {loading && !appearance ? <div className={styles.loading}><SpinnerGap className={styles.spinner} size={28} /> {tr("Loading appearance")}</div> : null}
      {error ? <div className={styles.errorBar}><span><strong>{tr("Appearance could not be loaded")}</strong>{error}</span><button type="button" onClick={() => setError(null)}><X size={18} /></button></div> : null}
      {appearance && !editorOpen ? (
        <div className={styles.catalogLayout}>
          <aside className={styles.heroPane}>
            <h2>{appearance.username}</h2>
            <div className={styles.heroViewer}><MinecraftSkinViewer skin={catalogSkin} cape={activeCape?.dataUrl} model={catalogModel} interactive label={`${appearance.username} skin`} /></div>
            <p>↔ {tr("Drag to rotate")}</p>
            {appearance.provider === "microsoft" ? <div className={styles.heroActions}><button className={common.button} type="button" disabled={busy || !canApplySelectedSkin} onClick={() => void applySelectedSkin()}><Check size={17} /> {tr("Apply")}</button><button className={common.secondaryButton} type="button" disabled={busy} onClick={openEditor}><Image size={17} /> {tr("Edit")}</button></div> : <button className={common.secondaryButton} type="button" onClick={() => void openUrl("https://ely.by/skins")}>{tr("Manage on Ely.by")}</button>}
          </aside>
          <main className={styles.catalogPane}>
            <section>
              <header><div><h3>{tr("Saved skins")}</h3><p>{tr("Choose an existing skin or add a PNG file.")}</p></div>{busy ? <SpinnerGap className={styles.spinner} size={20} /> : skinChangeCoolingDown ? <span className={`${styles.cooldownBadge} ${cooldownFlashing ? styles.cooldownFlash : ""}`}>⏳ {skinChangeWaitSeconds} {tr("sec.")}</span> : null}</header>
              <div className={styles.savedGrid}>
                <button className={`${styles.skinCard} ${styles.addCard}`} type="button" disabled={!appearance.canChangeSkin || busy} onClick={openFilePicker}><Plus size={34} /><strong>{tr("Add a skin")}</strong><span>{tr("Drop or choose a PNG file")}</span></button>
                {appearance.skins.map((texture) => <SkinCard key={texture.id} texture={texture} busy={busy} selected={selectedSavedSkinId === texture.id} onSelect={() => chooseSavedSkin(texture)} />)}
              </div>
            </section>
            <section className={styles.defaultsSection}>
              <header><div><h3>{tr("Default skins")}</h3><p>{tr("Official classic Minecraft characters.")}</p></div></header>
              <div className={styles.defaultGrid}>
                {DEFAULT_SKINS.map((skin) => <button className={`${styles.defaultCard} ${selectedDefault?.name === skin.name ? styles.selectedDefault : ""}`} type="button" key={skin.name} disabled={!appearance.canChangeSkin || busy} onClick={() => chooseDefault(skin)}><MinecraftSkinViewer skin={skin.url} model={skin.model} compact label={skin.name} /><span>{skin.name}</span></button>)}
              </div>
            </section>
          </main>
        </div>
      ) : null}
      {appearance && editorOpen ? (
        <div className={styles.editorLayout}>
          <aside className={styles.editorPreview}>
            <div><MinecraftSkinViewer skin={previewSkin} cape={previewCape} model={variant} interactive label={`${appearance.username} preview`} /></div>
            <p>↔ {tr("Drag to rotate")}</p>
          </aside>
          <main className={styles.editorControls}>
            <section><h3>{tr("Texture")}</h3><button className={common.secondaryButton} type="button" disabled={!appearance.canChangeSkin || busy} onClick={openFilePicker}><UploadIcon size={18} /> {tr("Replace texture")}</button>{pendingSkin ? <small>{pendingSkin.name}</small> : null}</section>
            <section><h3>{tr("Arms")}</h3><div className={styles.armOptions}><button className={variant === "classic" ? styles.selectedOption : ""} type="button" onClick={() => setVariant("classic")}><i />{tr("Wide")}</button><button className={variant === "slim" ? styles.selectedOption : ""} type="button" onClick={() => setVariant("slim")}><i />{tr("Slim")}</button></div></section>
            <section><h3>{tr("Cape")}</h3><div className={styles.capeGrid}><button className={capeId === null ? styles.selectedCape : ""} type="button" onClick={() => setCapeId(null)}><X size={30} /><span>{tr("None")}</span></button>{appearance.capes.map((cape) => <button className={capeId === cape.id ? styles.selectedCape : ""} type="button" key={cape.id} onClick={() => setCapeId(cape.id)}>{cape.dataUrl ? <span className={styles.capePreview}><img src={cape.thumbnailDataUrl ?? cape.dataUrl} alt="" /></span> : <Image size={30} />}<span>{cape.alias ?? tr("Cape")}</span></button>)}</div></section>
            <footer>{editorSkin && !selectedDefault ? <button className={styles.deleteButton} type="button" disabled={busy} onClick={() => void deleteSavedSkin(editorSkin)}><Trash size={18} /> {tr("Delete")}</button> : null}<span className={styles.footerActions}><button className={common.secondaryButton} type="button" disabled={busy} onClick={closeEditor}><X size={17} /> {tr("Cancel")}</button><button className={common.button} type="button" disabled={busy || !appearance.canChangeSkin} onClick={() => void saveEditor()}>{busy ? <SpinnerGap className={styles.spinner} size={18} /> : <Check size={18} />} {tr("Save skin")}</button></span></footer>
          </main>
        </div>
      ) : null}
    </Dialog>
  );
}
