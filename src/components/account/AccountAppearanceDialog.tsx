import { ErrorText } from "../common/ErrorText";
import { useUiText } from "../../i18n/UiText";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "../common/Controls";
import { Check, Export as UploadIcon, Image, Plus, SpinnerGap, Trash, X } from "../icons";
import { Dialog } from "../common/Dialog";
import { command } from "../../lib/tauri";
import { useWindowActivity } from "../../lib/windowActivity";
import type { Account, AccountAppearance, AccountTexture } from "../../lib/types";
import { MinecraftSkinViewer } from "./MinecraftSkinViewer";
import { SkinThumbnail } from "./SkinThumbnail";
import { defaultHomeSkin } from "../../lib/home";
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
  const uiText = useUiText();

  const model = skinModel(texture.variant);
  return (
    <button aria-pressed={selected} aria-label={texture.alias ?? uiText("accounts.texts.savedSkin", "Saved skin")} title={texture.alias ?? undefined} className={`${styles.skinCard} ${texture.active ? styles.activeSkin : ""} ${selected ? styles.selectedSkin : ""}`} type="button" disabled={busy} onClick={onSelect}>
      <SkinThumbnail skin={texture.dataUrl} model={model} label={texture.alias ?? uiText("accounts.texts.savedSkin", "Saved skin")} />
      <span>{texture.alias ?? uiText("accounts.texts.savedSkin", "Saved skin")}</span>
      {texture.active ? <i><Check size={14} /> {uiText("accounts.texts.active", "Active")}</i> : null}
    </button>
  );
}

export function AccountAppearanceDialog({ account, onClose, onChanged }: Props) {
  const uiText = useUiText();

  const fileInput = useRef<HTMLInputElement>(null);
  const panelId = useId();
  const [libraryTab, setLibraryTab] = useState<"skin" | "cape">("skin");
  const [editorTab, setEditorTab] = useState<"skin" | "cape">("skin");
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
    setVariant(currentSkin ? skinModel(currentSkin.variant) : defaultHomeSkin(account?.providerUuid).model);
    setCapeId(currentCape?.id ?? null);
    setPendingSkin(null);
  };

  const openEditor = () => {
    resetEditorDraft();
    if (selectedDefault) {
      setVariant(selectedDefault.model);
      setPendingSkin(inlineTextureToPending(selectedDefault.url, selectedDefault.name));
    }
    setEditorTab("skin");
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
      setError(uiText(errorMessage(reason)));
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
    setLibraryTab("skin");
    setEditorTab("skin");
    if (account) void reload();
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
      setError(uiText(errorMessage(reason)));
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  const chooseFile = async (file?: File) => {
    if (!file) return;
    try {
      setPendingSkin(await fileToPending(file));
      setEditorTab("skin");
      setEditorOpen(true);
    } catch (reason) {
      setError(uiText(errorMessage(reason)));
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
    const needsSkinUpload = pendingSkin !== null || variant !== baseEditorModel;
    if (needsSkinUpload && skinChangeCoolingDown) {
      flashCooldown();
      return;
    }
    const saved = await mutate(async () => {
      const snapshots: AccountAppearance[] = [];
      const activeVariant = baseEditorModel;
      let skinToUpload = pendingSkin;
      if (!skinToUpload && variant !== activeVariant) {
        const response = await fetch(editorSkin?.dataUrl ?? fallbackSkin.dataUrl!);
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
      if (appearance.canChangeCape && capeId !== previousCape) {
        snapshots.push(await command<AccountAppearance>("select_account_cape", { accountId: appearance.accountId, capeId }));
      }
      if (snapshots.length === 0) return appearance;
      return mergeAppearanceState(appearance, snapshots, undefined, capeChanged ? capeId : undefined);
    });
    if (saved) {
      if (pendingSkin || variant !== baseEditorModel) startSkinChangeCooldown();
      applyAppearance(saved);
      setPendingSkin(null);
      setSelectedDefault(null);
      setEditorOpen(false);
    }
  };

  const activeSkin = appearance?.skins.find((texture) => texture.active) ?? appearance?.skins[0];
  const selectedSavedSkin = selectedSavedSkinId ? appearance?.skins.find((skin) => skin.id === selectedSavedSkinId) : undefined;
  const editorSkin = selectedSavedSkin ?? activeSkin;
  const fallbackSkin = defaultHomeSkin(account?.providerUuid);
  const baseEditorModel = editorSkin ? skinModel(editorSkin.variant) : fallbackSkin.model;
  const canApplySelectedSkin = Boolean(selectedDefault || (selectedSavedSkin && !selectedSavedSkin.active));
  const activeCape = appearance?.capes.find((texture) => texture.active) ?? null;
  const catalogSkin = selectedDefault?.url ?? selectedSavedSkin?.dataUrl ?? activeSkin?.dataUrl ?? fallbackSkin.dataUrl;
  const catalogModel = selectedDefault?.model ?? (selectedSavedSkin || activeSkin ? skinModel(selectedSavedSkin?.variant ?? activeSkin?.variant) : fallbackSkin.model);
  const previewSkin = pendingSkin?.dataUrl ?? editorSkin?.dataUrl ?? fallbackSkin.dataUrl;
  const previewCape = appearance?.capes.find((cape) => cape.id === capeId)?.dataUrl ?? null;
  const title = editorOpen ? uiText("accounts.texts.skinSettings", "Skin settings") : `${uiText("accounts.texts.skinSelection", "Skin selection")} · ${account?.username ?? ""}`;

  const selectedName = selectedDefault?.name ?? selectedSavedSkin?.alias ?? activeSkin?.alias ?? uiText("accounts.texts.savedSkin", "Saved skin");
  const editorHasChanges = Boolean(pendingSkin || variant !== baseEditorModel
    || (appearance?.canChangeCape && capeId !== (activeCape?.id ?? null)));
  const changeTabWithKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="tab"]:not(:disabled)')];
    const index = tabs.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    event.preventDefault();
    tabs[next]?.focus();
    tabs[next]?.click();
  };
  const requestClose = () => {
    if (busy || filePickerActive.current) return;
    if (editorOpen) closeEditor(); else onClose();
  };
  const capeGallery = appearance ? <div className={styles.capeGrid}>
              <button className={capeId === null ? styles.selectedCape : ""} aria-pressed={capeId === null} type="button" disabled={busy || !appearance.canChangeCape} onClick={() => setCapeId(null)}><X size={24} /><span>{uiText("accounts.texts.none", "None")}</span></button>
              {appearance.capes.map(cape => <button className={capeId === cape.id ? styles.selectedCape : ""} aria-pressed={capeId === cape.id} type="button" key={cape.id} disabled={busy || !appearance.canChangeCape} onClick={() => setCapeId(cape.id)} title={cape.alias ?? undefined}>{cape.dataUrl ? <span className={styles.capePreview}><img src={cape.thumbnailDataUrl ?? cape.dataUrl} alt="" /></span> : <Image size={24} />}<span>{cape.alias ?? uiText("accounts.texts.cape", "Cape")}</span></button>)}
            </div> : null;
  const catalogCapeOpen = !editorOpen && libraryTab === "cape";
  const capeChanged = capeId !== (activeCape?.id ?? null);
  const applySelectedCape = async () => {
    if (!appearance?.canChangeCape || !capeChanged) return;
    const next = await mutate(() => command<AccountAppearance>("select_account_cape", { accountId: appearance.accountId, capeId }));
    if (next) onClose();
  };
  const footer = <div className={styles.footerLayout}>
    <div className={styles.footerContext}>
      {editorOpen && editorSkin && !selectedDefault ? <Button variant="danger" className={styles.deleteButton} aria-label={uiText("common.delete", "Delete")} title={uiText("common.delete", "Delete")} disabled={busy} onClick={() => void deleteSavedSkin(editorSkin)}><Trash size={16} /><span>{uiText("common.delete", "Delete")}</span></Button>
        : appearance ? <span title={selectedName}>{selectedName}</span> : null}
      {skinChangeCoolingDown ? <span role="status" className={`${styles.cooldownBadge} ${cooldownFlashing ? styles.cooldownFlash : ""}`}>{skinChangeWaitSeconds} {uiText("accounts.texts.sec", "sec.")}</span> : null}
    </div>
    <div className={styles.footerActions}>
      <Button disabled={busy} onClick={requestClose}>{editorOpen ? <><span className={styles.fullBack}>{uiText("accounts.appearance.backToSkins", "Back to skins")}</span><span className={styles.shortBack}>{uiText("common.texts.back", "Back")}</span></> : uiText("common.close", "Close")}</Button>
      {appearance?.provider === "elyby" ? <Button variant="primary" onClick={() => void openUrl("https://ely.by/skins")}>{uiText("accounts.texts.manageOnElyBy", "Manage on Ely.by")}</Button>
        : editorOpen ? <Button variant="primary" disabled={!editorHasChanges || !appearance?.canChangeSkin} busy={busy} onClick={() => void saveEditor()}><Check size={16} />{uiText("accounts.texts.saveSkin", "Save skin")}</Button>
        : catalogCapeOpen ? <Button variant="primary" disabled={!capeChanged || !appearance?.canChangeCape} busy={busy} onClick={() => void applySelectedCape()}><Check size={16} />{uiText("accounts.texts.apply", "Apply")}</Button>
        : appearance ? <><Button disabled={busy || !appearance.canChangeSkin} onClick={openEditor}><Image size={16} />{uiText("accounts.appearance.customize", "Customize")}</Button><Button variant="primary" disabled={!canApplySelectedSkin || !appearance.canChangeSkin} busy={busy} onClick={() => void applySelectedSkin()}><Check size={16} />{uiText("accounts.texts.apply", "Apply")}</Button></> : null}
    </div>
  </div>;

  return (
    <Dialog open={Boolean(account)} title={title} description={editorOpen ? uiText("accounts.appearance.editorHint", "Choose the skin model or switch to capes. Save to apply your changes.") : uiText("accounts.appearance.catalogHint", "Select a skin to preview it, then apply it or customize its appearance.")} onClose={requestClose} width="xlarge" className={styles.appearanceDialog} bodyClassName={styles.dialogBody} footer={footer}>
      <input ref={fileInput} className={styles.fileInput} type="file" accept="image/png" onChange={(event) => { filePickerActive.current = false; void chooseFile(event.target.files?.[0]); event.currentTarget.value = ""; }} />
      {loading && !appearance ? <div className={styles.loading}><SpinnerGap className={styles.spinner} size={24} />{uiText("accounts.texts.loadingAppearance", "Loading appearance")}</div> : null}
      {error ? <div className={styles.errorBar} role="alert"><span><strong>{uiText("accounts.texts.appearanceCouldNotBeLoaded", "Appearance could not be loaded")}</strong><ErrorText message={error} /></span><Button variant="ghost" aria-label={uiText("common.close", "Close")} onClick={() => setError(null)}><X size={16} /></Button></div> : null}
      {appearance ? <div className={styles.layout}>
        <aside className={styles.previewPane}>
          <div className={styles.previewName}><strong title={appearance.username}><bdi>{appearance.username}</bdi></strong><span title={pendingSkin?.name ?? selectedName}>{pendingSkin?.name ?? selectedName}</span></div>
          <div className={styles.heroViewer}><MinecraftSkinViewer skin={editorOpen ? previewSkin : catalogSkin} cape={previewCape} model={editorOpen ? variant : catalogModel} interactive label={`${appearance.username} skin`} /></div>
          <p className={styles.rotateHint}>{uiText("accounts.texts.dragToRotate", "Drag to rotate")}</p>
          {appearance.provider === "offline" ? <details className={styles.skinNote}><summary>{uiText("accounts.appearance.localSkin", "Local skin")}</summary><p>{uiText("accounts.offlineSkinHint", "Saved on this computer. Used in Minecraft 1.7.2 and newer; other players may need a compatible skin system. Restart the game after changing your skin.")}</p></details> : null}
        </aside>
        {!editorOpen ? <section className={styles.workspace}>
          <div className={styles.toolbar}>
            <div className={styles.tabs} role="tablist" aria-label={uiText("accounts.texts.skinSettings", "Skin settings")} onKeyDown={changeTabWithKeyboard}>
              <button id={`${panelId}-catalog-skin-tab`} role="tab" aria-selected={libraryTab === "skin"} aria-controls={`${panelId}-library`} tabIndex={libraryTab === "skin" ? 0 : -1} type="button" onClick={() => setLibraryTab("skin")}>{uiText("accounts.appearance.skin", "Skin")}</button>
              <button id={`${panelId}-catalog-cape-tab`} role="tab" aria-selected={libraryTab === "cape"} aria-controls={`${panelId}-library`} tabIndex={libraryTab === "cape" ? 0 : -1} type="button" disabled={!appearance.canChangeCape} onClick={() => setLibraryTab("cape")}>{uiText("accounts.texts.cape", "Cape")}</button>
            </div>
            {libraryTab === "skin" ? <Button disabled={!appearance.canChangeSkin || busy} onClick={openFilePicker}><Plus size={16} />{uiText("accounts.texts.addASkin", "Add a skin")}</Button> : null}
          </div>
          <div id={`${panelId}-library`} className={styles.scrollPane} role="tabpanel" aria-labelledby={`${panelId}-catalog-${libraryTab}-tab`} tabIndex={0}>
            {libraryTab === "skin" ? <><section className={styles.librarySection} aria-labelledby={`${panelId}-saved-heading`}>
              <h3 id={`${panelId}-saved-heading`}>{uiText("accounts.texts.savedSkins", "Saved skins")}</h3>
              {appearance.skins.length ? <div className={styles.skinGrid}>{appearance.skins.map(texture => <SkinCard key={texture.id} texture={texture} busy={busy} selected={selectedSavedSkinId === texture.id} onSelect={() => chooseSavedSkin(texture)} />)}</div>
                : <div className={styles.emptyState}><Image size={30} /><h3>{uiText("accounts.appearance.noSavedSkins", "No saved skins yet")}</h3></div>}
            </section>
            <section className={styles.librarySection} aria-labelledby={`${panelId}-default-heading`}>
              <h3 id={`${panelId}-default-heading`}>{uiText("accounts.texts.defaultSkins", "Default skins")}</h3>
              <div className={styles.skinGrid}>{DEFAULT_SKINS.map(skin => <button className={`${styles.skinCard} ${selectedDefault?.name === skin.name ? styles.selectedSkin : ""}`} type="button" key={skin.name} aria-label={skin.name} aria-pressed={selectedDefault?.name === skin.name} disabled={!appearance.canChangeSkin || busy} onClick={() => chooseDefault(skin)}><SkinThumbnail skin={skin.url} model={skin.model} label={skin.name} /><span>{skin.name}</span></button>)}</div>
            </section></> : capeGallery}
          </div>
        </section> : <section className={styles.workspace}>
          <div className={styles.toolbar}><div className={styles.tabs} role="tablist" aria-label={uiText("accounts.texts.skinSettings", "Skin settings")} onKeyDown={changeTabWithKeyboard}>
            <button id={`${panelId}-skin-tab`} type="button" role="tab" aria-selected={editorTab === "skin"} aria-controls={`${panelId}-editor`} tabIndex={editorTab === "skin" ? 0 : -1} onClick={() => setEditorTab("skin")}>{uiText("accounts.appearance.skin", "Skin")}</button>
            <button id={`${panelId}-cape-tab`} type="button" role="tab" aria-selected={editorTab === "cape"} aria-controls={`${panelId}-editor`} tabIndex={editorTab === "cape" ? 0 : -1} disabled={!appearance.canChangeCape} onClick={() => setEditorTab("cape")}>{uiText("accounts.texts.cape", "Cape")}</button>
          </div></div>
          <div id={`${panelId}-editor`} className={styles.scrollPane} role="tabpanel" aria-labelledby={`${panelId}-${editorTab}-tab`} tabIndex={0}>
            {editorTab === "skin" ? <div className={styles.skinSettings}>
              <section><h3>{uiText("accounts.texts.texture", "Texture")}</h3><p>{uiText("accounts.appearance.pngHint", "PNG, 64 × 64 or 64 × 32 pixels, up to 2 MB.")}</p><Button disabled={!appearance.canChangeSkin || busy} onClick={openFilePicker}><UploadIcon size={16} />{uiText("accounts.texts.replaceTexture", "Replace texture")}</Button>{pendingSkin ? <p className={styles.fileName}>{pendingSkin.name}</p> : null}</section>
              <section><h3>{uiText("accounts.texts.arms", "Arms")}</h3><div className={styles.armOptions} role="group" aria-label={uiText("accounts.texts.arms", "Arms")}><button className={variant === "classic" ? styles.selectedOption : ""} type="button" aria-pressed={variant === "classic"} disabled={busy} onClick={() => setVariant("classic")}><i />{uiText("accounts.texts.wide", "Wide")}</button><button className={variant === "slim" ? styles.selectedOption : ""} type="button" aria-pressed={variant === "slim"} disabled={busy} onClick={() => setVariant("slim")}><i />{uiText("accounts.appearance.slimArms", "Slim")}</button></div></section>
            </div> : capeGallery}
          </div>
        </section>}
      </div> : null}
    </Dialog>
  );
}
