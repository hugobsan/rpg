import Icon from "../game/Icon";
import p from "../SidePanels.module.css";

/** Minúsculas e sem acento: "Jutsu" acha "jútsu". */
export const fold = (t: string) => t.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Barra de busca das abas laterais (Biblioteca, Jutsus, Inventário). */
export default function SearchBox({ value, onChange, label, placeholder }: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  placeholder: string;
}) {
  return (
    <label className={p.search}>
      <span className="sr-only">{label}</span>
      <Icon name="search" size={16} />
      <input type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
    </label>
  );
}
