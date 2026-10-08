import type { ComponentType } from "react";
import {
  Coffee,
  Cube,
  GameController,
  GlobeHemisphereWest,
  HardDrives,
  Image,
  PuzzlePiece,
  Stack,
  Star,
  Sword,
  Tree,
  Wrench,
  type PixelIconProps,
} from "../icons";
import type { Instance } from "../../lib/types";
import styles from "./InstanceArtwork.module.css";

export const instanceIconChoices: { key: string; label: string; Icon: ComponentType<PixelIconProps> }[] = [
  { key: "cube", label: "Block", Icon: Cube },
  { key: "package", label: "Pack", Icon: Stack },
  { key: "blocks", label: "Mods", Icon: PuzzlePiece },
  { key: "sword", label: "Sword", Icon: Sword },
  { key: "tree", label: "Tree", Icon: Tree },
  { key: "star", label: "Star", Icon: Star },
  { key: "gamepad", label: "Game", Icon: GameController },
  { key: "globe", label: "World", Icon: GlobeHemisphereWest },
  { key: "coffee", label: "Java", Icon: Coffee },
  { key: "image", label: "Art", Icon: Image },
  { key: "server", label: "Server", Icon: HardDrives },
  { key: "tools", label: "Tools", Icon: Wrench },
];

const fallbackColors: Record<Instance["loaderType"], { background: string; foreground: string }> = {
  vanilla: { background: "#3f493c", foreground: "#f0f4ed" },
  fabric: { background: "#4d4033", foreground: "#f1e8dd" },
  forge: { background: "#503d34", foreground: "#f2e5dc" },
  neoforge: { background: "#51352f", foreground: "#f3dfd9" },
  quilt: { background: "#43374e", foreground: "#eee7f5" },
  bedrock: { background: "#355b76", foreground: "#edf7ff" },
};

export function instanceArtworkColors(instance: Instance) {
  return {
    background: instance.iconBackground ?? fallbackColors[instance.loaderType].background,
    foreground: instance.iconForeground ?? fallbackColors[instance.loaderType].foreground,
  };
}

export function InstanceArtwork({ instance, size = "card" }: { instance: Instance; size?: "small" | "card" | "large" }) {
  const choice = instanceIconChoices.find((item) => item.key === instance.iconKey) ?? instanceIconChoices[0];
  const colors = instanceArtworkColors(instance);
  const Icon = choice.Icon;
  return (
    <div className={`${styles.artwork} ${styles[size]} ${styles[instance.loaderType]}`} style={{ background: colors.background, color: colors.foreground }} aria-hidden="true">
      <Icon size={size === "large" ? 48 : size === "small" ? 19 : 30} />
    </div>
  );
}
