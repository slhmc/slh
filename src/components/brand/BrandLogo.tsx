import icon from "../../assets/brand/Smile_LauncHer_logo.png";
import horizontal from "../../assets/brand/SLHmain.png";
import wordmark from "../../assets/brand/SLH.png";
import styles from "./BrandLogo.module.css";

export type BrandLogoVariant = "icon" | "horizontal" | "wordmark";

export function BrandLogo({ variant = "icon", className = "" }: { variant?: BrandLogoVariant; className?: string }) {
  const source = variant === "icon" ? icon : variant === "horizontal" ? horizontal : wordmark;
  return (
    <img
      className={`${styles.logo} ${styles[variant]} ${className}`}
      src={source}
      alt={variant === "icon" ? "SLH" : "Smile LauncHer"}
      draggable={false}
    />
  );
}

