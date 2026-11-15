import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { FinderRequest, PackCandidate } from "../../lib/modpackFinder";

const Finder = lazy(() => import("./ModpackFinderDialog").then(module => ({ default: module.ModpackFinderDialog })));
export function ModpackFinderHost() {
  const [request, setRequest] = useState<(FinderRequest & { id: number }) | null>(null);
  const nextId = useRef(0);
  const trigger = useRef<HTMLElement | null>(null);
  const navigate = useNavigate();
  useEffect(() => {
    const open = (event: Event) => { trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setRequest({ ...(event as CustomEvent<FinderRequest>).detail, id: ++nextId.current }); };
    window.addEventListener("slh-find-modpack", open);
    return () => window.removeEventListener("slh-find-modpack", open);
  }, []);
  const select = (candidate: PackCandidate) => {
    setRequest(null);
    sessionStorage.setItem(`slh.randomProject:${candidate.provider}:${candidate.project.projectId}`, JSON.stringify(candidate));
    navigate(`/discover?${new URLSearchParams({ type: "modpack", source: candidate.provider, project: candidate.project.projectId })}`, {
      state: { finderSelection: candidate },
    });
  };
  const close = () => { setRequest(null); requestAnimationFrame(() => { if (trigger.current?.isConnected) trigger.current.focus(); }); };
  return request ? <Suspense fallback={null}><Finder key={request.id} request={request} onClose={close} onSelect={select} /></Suspense> : null;
}
