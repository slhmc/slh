import { openModpackFinder } from "../../lib/modpackFinder";
import { useUiText } from "../../i18n/UiText";
import { Button } from "../../components/common/Controls";
import { ArrowClockwise } from "../../components/icons";
import styles from "./HomeDiscoverSearch.module.css";
export function HomeDiscoverSearch() {
  const t = useUiText();
  return <Button className={styles.random} icon={<ArrowClockwise size={18} />} onClick={() => openModpackFinder({ random: true })}>{t("packFinder.random")}</Button>;
}
