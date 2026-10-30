"use client";
import type { Scene } from "@/lib/types";
import { clockParts, period } from "@/lib/clock";
import Icon, { type IconName } from "./Icon";
import Loader from "../ui/Loader";
import { MODE_LABEL } from "./feedModel";
import s from "./SceneHeader.module.css";

/** Céu do relógio: arco do horizonte com o sol (6h às 18h) ou a lua (18h às 6h) andando por ele. */
function SkyDial({ minutes }: { minutes: number }) {
  const { hour, minute } = clockParts(minutes);
  const h = hour + minute / 60;
  const day = h >= 6 && h < 18;
  const t = day ? (h - 6) / 12 : ((h + 6) % 24) / 12;
  const a = Math.PI * (1 - t);
  const x = 18 + 13 * Math.cos(a);
  const y = 17 - 13 * Math.sin(a);
  return (
    <svg viewBox="0 0 36 21" width="36" height="21" className={`${s.dial} ${day ? s.day : s.night}`} aria-hidden="true">
      <path d="M5 17a13 13 0 0 1 26 0" className={s.arc} />
      <path d="M1.5 17.5h33" className={s.horizon} />
      {day ? (
        <circle cx={x} cy={y} r="3.2" className={s.sun} />
      ) : (
        <>
          <circle cx={x} cy={y} r="3" className={s.moon} />
          <circle cx={x + 1.4} cy={y - 1} r="2.5" className={s.moonCut} />
        </>
      )}
    </svg>
  );
}

function Action({ icon, label, onClick, busy, disabled, className = "" }: {
  icon: IconName; label: string; onClick: () => void; busy?: boolean; disabled?: boolean; className?: string;
}) {
  return (
    <button className={`${s.action} ${className}`} onClick={onClick} disabled={disabled || busy} title={label} aria-label={label}>
      {busy ? <Loader size={16} label="Pintando o ambiente" /> : <Icon name={icon} />}
      <span className={s.actionLabel}>{label}</span>
    </button>
  );
}

/** Cabeçalho da cena: modo, título, local, relógio com o céu do período e as ações da cena. */
export default function SceneHeader({ scene, clock, image, onOoc, onMap, onTable, tableHint }: {
  scene: Scene;
  clock: number | null;
  image?: { busy: boolean; onClick: () => void }; // só com a geração de imagem ligada
  onOoc: () => void;
  onMap?: () => void;
  onTable?: () => void;
  tableHint?: string; // dificuldade atual, quando foge do normal
}) {
  const per = clock === null ? null : period(clock);
  const { day, hour, minute } = clockParts(clock ?? 0);
  return (
    <header className={s.head}>
      <div className={s.scene}>
        <span className={s.mode}>{MODE_LABEL[scene.mode] || scene.mode}</span>
        <h1 className={s.title}>{scene.title || scene.location || "Cena sem nome"}</h1>
        {scene.location && scene.title && (
          <span className={s.loc}><Icon name="pin" size={13} />{scene.location}</span>
        )}
      </div>

      {clock === null ? (
        <span className={s.clock} title="O Mestre define a hora no próximo turno">
          <Icon name="clock" size={16} /><span className={s.when}>hora a definir</span>
        </span>
      ) : (
        <span className={s.clock} title="Hora na história (o Mestre avança a cada interação)">
          <SkyDial minutes={clock} />
          <span className={s.time}>
            <b className="num">{String(hour).padStart(2, "0")}:{String(minute).padStart(2, "0")}</b>
            <span className={s.when}>Dia {day} · {per}</span>
          </span>
        </span>
      )}

      <nav className={s.actions} aria-label="Ações da cena">
        {image && <Action icon="landscape" label="Ambiente" onClick={image.onClick} busy={image.busy} />}
        {onMap && <Action icon="map" label="Mapa" onClick={onMap} className={s.wide} />}
        {onTable && (
          <button className={`${s.action} ${s.wide}`} onClick={onTable} title="Mesa: dificuldade e dados" aria-label="Mesa: dificuldade e dados">
            <Icon name="sliders" />
            <span className={s.actionLabel}>Mesa</span>
            {tableHint && <span className={s.hint}>{tableHint}</span>}
          </button>
        )}
        <Action icon="chat" label="Fora do jogo" onClick={onOoc} className={s.ooc} />
      </nav>
    </header>
  );
}
