import { useUiText } from "../../i18n/UiText";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { ProjectGalleryImage } from "../../lib/types";
import type { RootContent } from "hast";
import styles from "../../routes/Discover/DiscoverPage.module.css";

const schema = { ...defaultSchema, tagNames: [...(defaultSchema.tagNames ?? []), "iframe"],
  attributes: { ...defaultSchema.attributes, iframe: ["src"] } };

function containsVideo(node: RootContent): boolean {
  return (node.type === "element" && node.tagName === "iframe") || ("children" in node && node.children.some(containsVideo));
}

export function descriptionUrl(value: string): string | null {
  try {
    let url = new URL(value, "https://www.curseforge.com");
    if (url.hostname === "www.curseforge.com" && url.pathname === "/linkout") {
      let remote = url.searchParams.get("remoteUrl");
      if (!remote) return null;
      for (let i = 0; i < 3 && !/^https?:\/\//i.test(remote); i++) remote = decodeURIComponent(remote);
      url = new URL(remote);
    }
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function VideoPreview({ src }: { src?: string }) {
  const uiText = useUiText();
  try {
    const url = new URL(src ?? "");
    if (!["www.youtube.com", "youtube.com", "www.youtube-nocookie.com"].includes(url.hostname) || url.protocol !== "https:") return null;
    const id = url.pathname.match(/^\/embed\/([a-zA-Z0-9_-]{11})$/)?.[1];
    if (!id) return null;
    const watch = `https://www.youtube.com/watch?v=${id}`;
    // Descriptions sometimes wrap an iframe in a sponsor link. Stop that link
    // when activating the preview, and never execute the supplied iframe.
    return <a className={styles.descriptionVideo} href={watch} aria-label={uiText("common.texts.youtube", "YouTube")}
      onClick={(event) => { event.preventDefault(); event.stopPropagation(); void openUrl(watch); }}
      >
      <img src={`https://i.ytimg.com/vi/${id}/hqdefault.jpg`} alt="" loading="lazy" />
      <span>{uiText("common.texts.youtube663ec3", "▶ YouTube ↗")}</span>
    </a>;
  } catch { return null; }
}

export function MarkdownRenderer({ markdown, onImage }: { markdown: string; onImage: (image: ProjectGalleryImage) => void }) {
  return <div className={styles.markdown}><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw, [rehypeSanitize, schema]]}
    components={{
      a: ({ href, children, node }) => {
        if (node?.children.some(containsVideo)) return <span>{children}</span>;
        const url = href ? descriptionUrl(href) : null;
        return url ? <a className={styles.markdownLink} href={url} onClick={(event) => { event.preventDefault(); void openUrl(url); }}>{children}</a> : <span>{children}</span>;
      },
      img: ({ src, alt, width }) => {
        const url = src ? descriptionUrl(src) : null;
        if (!url) return null;
        const parsed = new URL(url);
        const video = parsed.hostname === "www.youtube.com" && parsed.pathname === "/watch" ? parsed.searchParams.get("v") : null;
        if (video && /^[a-zA-Z0-9_-]{11}$/.test(video)) return <VideoPreview src={`https://www.youtube.com/embed/${video}`} />;
        const secure = url.replace(/^http:/, "https:");
        return <img className={styles.markdownImage} src={secure} alt={alt ?? ""} width={width} loading="lazy" referrerPolicy="no-referrer"
          onClick={(event) => { event.preventDefault(); event.stopPropagation(); onImage({ url: secure, thumbnailUrl: null, title: alt || null, description: null }); }} />;
      },
      iframe: ({ src }) => <VideoPreview src={src} />,
      details: ({ children }) => <details className={styles.markdownDetails}>{children}</details>,
      summary: ({ children }) => <summary>{children}</summary>,
    }}
  >{markdown}</ReactMarkdown></div>;
}
