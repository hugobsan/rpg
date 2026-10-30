"use client";
import { useEffect, useId, useRef, useState } from "react";
import type { Campaign, Character } from "@/lib/types";
import { attributeCap, attributePoints, DEFAULT_XP_PER_POINT, levelThatAllows, powerLevel, trainingRules } from "@/lib/progression";
import { toast } from "./ui/Toast";
import s from "./SheetView.module.css";

const reduced = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Número que corre do valor anterior ao novo. */
function useTween(value: number, ms = 650) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const start = from.current;
    from.current = value;
    if (start === value || reduced()) return setShown(value);
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms);
      setShown(Math.round(start + (value - start) * (1 - (1 - k) ** 3)));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  return shown;
}

/** Medidor de recurso: a barra cai na hora e o rastro some depois (dano); na cura o rastro sobe antes. */
function Meter({ label, color, cur, max, hint }: { label: string; color: string; cur: number; max: number; hint?: string }) {
  const shown = useTween(cur);
  const prev = useRef(cur);
  const [hit, setHit] = useState<{ d: number; id: number } | null>(null);
  useEffect(() => {
    const d = cur - prev.current;
    prev.current = cur;
    if (d) setHit({ d, id: performance.now() });
  }, [cur]);
  const pct = Math.max(0, Math.min(1, cur / Math.max(1, max)));
  const dir = hit && hit.d > 0 ? "heal" : "dmg";
  return (
    <div className={`${s.meter} ${s[dir]}${pct <= 0.25 ? ` ${s.low}` : ""}`} title={hint}>
      <div className={s.meterHead}>
        <span className={s.meterName}>{label}</span>
        <span className={s.meterVal}>
          {hit && <span key={hit.id} className={s.delta}>{hit.d > 0 ? `+${hit.d}` : hit.d}</span>}
          <b className="num">{shown}</b><span className="num">/{max}</span>
        </span>
      </div>
      <div className={s.track} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={cur}>
        <span className={s.ghost} style={{ transform: `scaleX(${pct})` }} />
        <span className={s.fill} style={{ transform: `scaleX(${pct})`, background: color }} />
        {hit && <span key={hit.id} className={s.flash} />}
      </div>
    </div>
  );
}

const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";

/** Ficha. Com onChange (só o jogador), mostra os pontos livres e o + por atributo. Também é a ficha do NPC no modal. */
export default function SheetView({ char, campaign, onChange }: { char: Character; campaign: Campaign; onChange?: () => void }) {
  const rs = campaign.ruleset;
  const sh = char.sheet;
  const rank = rs.ranks.find((r) => r.key === sh.rank);
  const { level, next } = powerLevel(rs, sh.xp);
  const pts = attributePoints(rs, sh);
  const per = rs.xpPerAttributePoint ?? DEFAULT_XP_PER_POINT;
  const perHour = trainingRules(rs).hoursPerAttributePoint;
  const [busy, setBusy] = useState(false);
  // balão do atributo: hover no mouse, toque alterna, foco do teclado abre
  const [tip, setTip] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const open = hover ?? tip;
  const tipId = useId();

  const raise = async (key: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/campaigns/${campaign.id}/attributes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });
      if (!res.ok) toast((await res.json().catch(() => ({}))).error || "Não deu para subir o atributo.", { kind: "alerta" });
      onChange?.();
    } finally {
      setBusy(false);
    }
  };

  const base = level?.xpRequired ?? 0;
  const xpPct = next ? Math.max(0, Math.min(1, (sh.xp - base) / Math.max(1, next.xpRequired - base))) : 1;
  const openAttr = rs.attributes.find((a) => a.key === open);
  const npc = char.kind === "npc";
  const known = rs.attributes.some((a) => sh.attributes[a.key] !== undefined);

  return (
    <div className={s.sheet}>
      {/* no modal do NPC o nome já está no cabeçalho */}
      {!npc ? (
        <header className={s.head}>
          <span className={s.crest} aria-hidden="true">{initials(char.name)}</span>
          <div className={s.who}>
            <h3 className={s.name}>{char.name}</h3>
            <div className={s.rank}>{rank?.label || sh.rank || "sem cargo"}</div>
          </div>
        </header>
      ) : (
        (rank || sh.rank) && <div className={s.rank}>Cargo: {rank?.label || sh.rank}</div>
      )}

      {(!npc || sh.xp > 0) && <div className={s.level} title="O nível de poder vem só da XP e define o teto dos atributos. Não é cargo: o cargo só muda pela história.">
        <div className={s.levelHead}>
          <span><span className={s.levelLabel}>Nível de poder</span> <b>{level?.label || "inicial"}</b></span>
          <span className="num">{sh.xp} XP</span>
        </div>
        <div className={s.xpTrack}><span style={{ transform: `scaleX(${xpPct})` }} /></div>
        {!npc && <div className={s.levelFoot}>
          {next ? <>faltam <b className="num">{next.xpRequired - sh.xp}</b> XP para {next.label}</> : "nível máximo"}
          {level?.attributeCap !== undefined && <> · teto de atributo <b className="num">{level.attributeCap}</b></>}
        </div>}
      </div>}

      {onChange && (
        pts.free > 0 ? (
          <div className={s.points}>
            <span className={`${s.pointsN} num`}>{pts.free}</span>
            <span>ponto{pts.free === 1 ? "" : "s"} livre{pts.free === 1 ? "" : "s"} para distribuir. Use o <b>+</b> de um atributo.</span>
          </div>
        ) : (
          <div className={s.pointsNone}>
            Próximo ponto livre em <b className="num">{per - (Math.max(0, sh.xp) % per)}</b> XP (1 a cada {per} XP)
          </div>
        )
      )}

      <div className={s.meters}>
        {rs.resources.map((r) => {
          const v = sh.resources[r.key];
          return v ? <Meter key={r.key} label={r.label} color={r.color} cur={v.current} max={v.max} hint={r.description} /> : null;
        })}
      </div>

      {npc && !known && <p className={s.blank}>Ficha ainda em branco: o Mestre preenche conforme a história revela quem é {char.name}.</p>}
      {(!npc || known) && <div className={s.attrs} onPointerLeave={() => setHover(null)}>
        {rs.attributes.map((a) => {
          const v = sh.attributes[a.key] ?? a.default;
          const cap = attributeCap(rs, sh.xp, a.key);
          const atCap = v >= cap;
          const hours = sh.trainingHours?.[a.key];
          const plusTip = atCap ? "no teto do nível atual" : `+1 ${a.label} (gasta 1 ponto livre)`;
          return (
            <div key={a.key} className={`${s.attr}${open === a.key ? ` ${s.on}` : ""}`}>
              <button type="button" className={s.attrBtn} aria-expanded={tip === a.key} aria-controls={tipId}
                onPointerEnter={(e) => e.pointerType === "mouse" && setHover(a.key)}
                onFocus={(e) => e.currentTarget.matches(":focus-visible") && setTip(a.key)}
                onBlur={() => setTip((t) => (t === a.key ? null : t))}
                onClick={() => setTip((t) => (t === a.key ? null : a.key))}>
                <span key={v} className={`${s.attrV} num`}>{sh.attributes[a.key] ?? "-"}</span>
                <span className={s.attrK}>{a.label}</span>
                {!!hours && <span className={s.train} style={{ transform: `scaleX(${Math.min(1, hours / (perHour * v || 1))})` }} />}
              </button>
              {onChange && pts.free > 0 && (
                <button type="button" className={s.plus} aria-label={plusTip} title={plusTip}
                  disabled={busy || atCap} onClick={() => raise(a.key)}>
                  <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
                </button>
              )}
            </div>
          );
        })}
        {openAttr && (() => {
          const v = sh.attributes[openAttr.key] ?? openAttr.default;
          const cap = attributeCap(rs, sh.xp, openAttr.key);
          const wait = v >= cap ? levelThatAllows(rs, openAttr.key, v) : undefined;
          const hours = sh.trainingHours?.[openAttr.key];
          return (
            <div id={tipId} className={s.tip} role="tooltip">
              <b>{openAttr.label}</b>
              {openAttr.description && <p>{openAttr.description}</p>}
              {rs.diceNotes && <p className={s.tipDim}>{rs.diceNotes.split(/\.\s/)[0]}.</p>}
              <p className={s.tipDim}>
                Teto no nível atual: {Math.min(cap, openAttr.max)}
                {v > cap ? ` (${v} veio da criação e fica como está)` : ""}
                {wait ? `; sobe a partir do nível ${wait.label}` : ""}. Máximo {openAttr.max}.
              </p>
              {!!hours && <p className={s.tipDim}>Treino: {hours} de {perHour * v} h para o próximo +1.</p>}
            </div>
          );
        })()}
      </div>}

      {Object.entries(sh.extra || {}).some(([, v]) => v) && (
        <dl className={s.extra}>
          {Object.entries(sh.extra).filter(([, v]) => v).map(([k, v]) => (
            <div key={k}>
              <dt>{rs.extraFields.find((x) => x.key === k)?.label || k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
