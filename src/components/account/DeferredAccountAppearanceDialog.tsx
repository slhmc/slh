import { lazy, Suspense, useEffect, useState } from "react";
import type { Account } from "../../lib/types";

const Appearance = lazy(() => import("./AccountAppearanceDialog").then(module => ({ default: module.AccountAppearanceDialog })));

/** Load the editor only after first use, then retain its cooldown across closes. */
export function DeferredAccountAppearanceDialog(props: {
  account: Account | null;
  onClose: () => void;
  onChanged?: () => void | Promise<void>;
}) {
  const [opened, setOpened] = useState(false);
  useEffect(() => { if (props.account) setOpened(true); }, [props.account]);
  return opened || props.account ? <Suspense fallback={null}><Appearance {...props} /></Suspense> : null;
}
