import { useEffect, useRef, useState } from "react";
import * as pixelIcons from "pixelarticons/react";
import { readArtwork, artworkTransform } from "../../lib/artwork";
import { LibraryArtwork } from "../common/LibraryChrome";
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
  rust: { background: "#51352f", foreground: "#f3dfd9" },
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

export function InstanceArtwork({ instance, size = "card", variant }: { instance: Instance; size?: "small" | "card" | "large" | "icon"; variant?: "square" | "rectangle" }) {
  const art = readArtwork(instance.iconKey);
  const ref=useRef<HTMLDivElement>(null);const [aspect,setAspect]=useState(1.6);
  useEffect(()=>{const el=ref.current;if(!el || typeof ResizeObserver === "undefined")return;const observer=new ResizeObserver(()=>{if(el.clientHeight)setAspect(el.clientWidth/el.clientHeight);});observer.observe(el);return()=>observer.disconnect();},[]);
  const transform=artworkTransform(art,variant ? variant==="square" : size==="small"||size==="icon");
  const choice = instanceIconChoices.find((item) => item.key === art.icon) ?? instanceIconChoices[0];
  const colors = instanceArtworkColors(instance);
  const Icon = (art.icon.startsWith("pixel:") ? (pixelIcons as unknown as Record<string, ComponentType<PixelIconProps>>)[art.icon.slice(6)] : undefined) ?? choice.Icon;
  return (
    <LibraryArtwork ref={ref} size={size} className={styles[instance.loaderType]} style={{ background: art.gradient ? `linear-gradient(${art.angle}deg, ${colors.background}, ${art.second})` : colors.background, color: colors.foreground }} aria-hidden="true">
      {art.image && art.blur ? <img src={art.image} alt="" style={{position:"absolute",inset:0,width:"100%",height:"100%",objectFit:"cover",filter:"blur(12px)",transform:"scale(1.2)"}} /> : null}
      <span style={{position:"absolute",left:`${transform.x}%`,top:`${transform.y}%`,width:`${transform.width/Math.max(1,aspect)}%`,height:`${transform.height/Math.max(1,1/aspect)}%`,transform:`translate(-50%,-50%) rotate(${transform.rotation}deg) scale(${art.zoom})`,display:"grid",placeItems:"center"}}>
        {art.image ? <img src={art.image} alt="" style={{width:"100%",height:"100%",minWidth:0,minHeight:0,display:"block",objectFit:art.fit,pointerEvents:"none"}} /> : <svg viewBox="0 0 24 24" preserveAspectRatio="none" style={{width:"100%",height:"100%",minWidth:0,minHeight:0,display:"block"}}><Icon size={24}/></svg>}
      </span>
    </LibraryArtwork>
  );
}

export const defaultArtworkColors = fallbackColors.vanilla;
