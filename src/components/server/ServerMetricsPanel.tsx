import { useEffect, useState } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import { useUiText } from "../../i18n/UiText";
import { command } from "../../lib/tauri";
import { stoppedServer, type LocalServer, type ServerMetrics } from "../../lib/localServers";
import { useWindowActivity } from "../../lib/windowActivity";
import styles from "./ServerMetricsPanel.module.css";

export function ServerMetricsPanel({ server }: { server: LocalServer }) {
  const t = useUiText();
  const { locale } = useI18n();
  const active = useWindowActivity();
  const idle = stoppedServer(server) || server.status === "installing";
  const [sample, setSample] = useState<{ id: string; value: ServerMetrics } | null>(null);
  useEffect(() => {
    if (idle || !active) { setSample(null); return; }
    let alive = true;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const value = await command<ServerMetrics>("get_local_server_metrics", { serverId: server.id });
        if (alive) setSample({ id: server.id, value });
      } catch { if (alive) setSample(null); }
      finally { pending = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => { alive = false; clearInterval(timer); };
  }, [server.id, idle, active]);
  const value = !idle && sample?.id === server.id ? sample.value : null;
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const percent = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 });
  const memory = value?.memoryBytes == null ? "—" : t("serverMetrics.memoryValue", undefined, { value: number.format(value.memoryBytes / 1048576) });
  const uptime = value?.uptimeSeconds == null ? "—" : t("serverMetrics.uptimeValue", undefined, {
    hours: number.format(Math.floor(value.uptimeSeconds / 3600)),
    minutes: number.format(Math.floor(value.uptimeSeconds / 60) % 60),
  });
  return <section className={styles.panel} data-server-metrics>
    <h2>{t("serverMetrics.title")}</h2>
    <dl className={styles.values}>
      <div><dt title={t("serverMetrics.memoryHint")}>{t("serverMetrics.memory")}</dt><dd>{memory}</dd></div>
      <div><dt title={t("serverMetrics.cpuHint")}>{t("serverMetrics.cpu")}</dt><dd>{value?.cpuPercent == null ? "—" : percent.format(value.cpuPercent / 100)}</dd></div>
      <div><dt>{t("serverMetrics.uptime")}</dt><dd>{uptime}</dd></div>
    </dl>
    {idle || value?.memoryBytes == null ? <p className={styles.state}>{t(idle ? "serverMetrics.stopped" : "serverMetrics.unavailable")}</p> : null}
  </section>;
}
