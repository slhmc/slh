import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useAppStore } from "../../stores/appStore";
import { useUiText } from "../../i18n/UiText";
import { Dialog } from "./Dialog";
import { Button } from "./Controls";
type Request = { title: string; description: string; names?: string[] };
const Context = createContext<(request: Request) => Promise<boolean>>(async () => false);
export const useConfirmation = () => useContext(Context);
export function ConfirmationProvider({ children }: { children: ReactNode }) {
  const t = useUiText();
  const enabled = useAppStore(state => state.bootstrap?.settings.general.confirmDestructiveActions !== false);
  type Pending = Request & { resolve: (confirmed: boolean) => void };
  const [request, setRequest] = useState<Pending | null>(null);
  const pending = useRef<Pending | null>(null);
  useEffect(() => () => pending.current?.resolve(false), []);
  const confirm = useCallback((value: Request) => {
    if (!enabled) return Promise.resolve(true);
    if (pending.current) return Promise.resolve(false);
    return new Promise<boolean>(resolve => {
      const item = { ...value, resolve };
      pending.current = item;
      setRequest(item);
    });
  }, [enabled]);
  const finish = (confirmed: boolean) => { pending.current?.resolve(confirmed); pending.current = null; setRequest(null); };
  return <Context.Provider value={confirm}>{children}<Dialog open={!!request} title={request?.title ?? ""} onClose={() => finish(false)} width="small" footer={<><Button variant="ghost" autoFocus onClick={() => finish(false)}>{t("common.cancel")}</Button><Button variant="danger" onClick={() => finish(true)}>{t("common.delete")}</Button></>}>
    {request ? <><p>{request.description}</p>{request.names?.length ? <ul>{request.names.map((name, i) => <li key={i}><bdi>{name}</bdi></li>)}</ul> : null}</> : null}
  </Dialog></Context.Provider>;
}
