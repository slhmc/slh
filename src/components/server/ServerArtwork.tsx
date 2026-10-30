import { useEffect, useState } from "react";
import { cachedServerIcon, refreshServerIcon } from "../../lib/serverIconCache";
import type { ServerPresentation } from "../../lib/localServers";
import { LibraryArtwork } from "../common/LibraryChrome";
import { instanceIconChoices } from "../instance/InstanceArtwork";
import styles from "./Servers.module.css";
export function ServerArtwork({
  id,
  revision = 0,
  presentation,
  size = "card",
}: {
  id: string;
  revision?: number;
  presentation?: ServerPresentation;
  size?: "small" | "card" | "large" | "icon";
}) {
  const [image, setImage] = useState<string | null>(() => presentation?.icon?.key ? null : cachedServerIcon(id));
  const icon = presentation?.icon;
  useEffect(() => {
    let alive = true;
    if (icon?.key) {
      setImage(null);
      return;
    }
    setImage(cachedServerIcon(id));
    void refreshServerIcon(id, revision)
      .then((value) => {
        if (alive) setImage(value);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [id, revision, icon?.key]);
  const Icon = (
    instanceIconChoices.find(
      (choice) => choice.key === (icon?.key ?? "server"),
    ) ?? instanceIconChoices[10]
  ).Icon;
  return (
    <LibraryArtwork
      size={size}
      style={{
        background: icon?.background ?? "var(--color-surface-2)",
        color: icon?.foreground ?? "var(--color-text)",
      }}
    >
      {image && !icon?.key ? (
        <img className={styles.artworkImage} src={image} alt="" />
      ) : (
        <Icon size={size === "large" ? 48 : size === "small" ? 19 : 30} />
      )}
    </LibraryArtwork>
  );
}
