"use client";
import { useEffect, useRef, useState } from "react";
import type { DiceResult } from "@/lib/types";
import type { DiceLook } from "./dice3d/scene";
import Loader from "./ui/Loader";
import s from "./DiceRoller.module.css";

const signed = (n: number) => `${n >= 0 ? "+" : "−"} ${Math.abs(n)}`;

/** "CD 15 + 2 Difícil + 3 Combate = 20" quando as regras da mesa ajustaram; senão "CD 17". */
export function dcText(r: DiceResult): string {
  if (r.dc === undefined) return "";
  if (r.baseDc === undefined || !r.dcAdjust?.length) return `CD ${r.dc}`;
  return `CD ${r.baseDc} ${r.dcAdjust.map((a) => `${signed(a.value)} ${a.label}`).join(" ")} = ${r.dc}`;
}

/** Texto do chip de rolagem no chat. */
export function diceText(r: DiceResult): string {
  return `🎲 ${r.notation}${r.reason ? ` (${r.reason})` : ""} → [${r.rolls.join(", ")}]${r.modifier ? ` ${r.modifier > 0 ? "+" : ""}${r.modifier}` : ""} = ${r.total}${r.dc !== undefined ? ` vs CD ${r.dc} · ${r.success ? "✓ passou" : "✗ não passou"}${r.sure ? " (garantido)" : ""}` : ""}${r.crit ? ` · ${r.crit === "success" ? "20 natural" : "1 natural"}` : ""}`;
}

/** Cores do tema atual resolvidas em rgb (o three.js não entende var() nem color-mix()). */
function themeLook(el: HTMLElement): Partial<DiceLook> {
  const probe = document.createElement("span");
  el.appendChild(probe);
  const read = (v: string) => ((probe.style.color = `var(${v})`), getComputedStyle(probe).color);
  const look = { die: read("--bg-panel"), ink: read("--accent"), trim: read("--accent"), floor: read("--bg-sunken"), wall: read("--bg-raise") };
  probe.remove();
  return look;
}

type Scene = { throwRandom(): void; dispose(): void };

/** Modal da caixa 3D: o jogador segura, arrasta e solta; os dados param nos valores de `result.rolls`. */
export default function DiceRoller({ result, force, onDone }: { result: DiceResult; force?: number; onDone: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const scene = useRef<Scene | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "rolling" | "done">("loading");
  const [shown, setShown] = useState(result.rolls.length);
  // o pai re-renderiza durante o stream; a ref evita reiniciar o fechamento automático
  const done = useRef(onDone);
  done.current = onDone;
  const closed = useRef(false);
  const close = () => {
    if (closed.current) return;
    closed.current = true;
    done.current();
  };

  useEffect(() => {
    let alive = true;
    import("./dice3d/scene")
      .then(({ createDiceScene, diceSpecs }) => {
        if (!alive || !box.current) return;
        const sides = parseInt(result.notation.match(/d(\d+)/i)?.[1] || "20", 10);
        const { dice, shown } = diceSpecs(result.rolls, sides);
        setShown(shown);
        scene.current = createDiceScene(box.current, dice, {
          onThrow: () => setPhase("rolling"),
          onSettled: () => setPhase("done"),
        }, themeLook(box.current), force);
        setPhase("ready");
      })
      .catch(() => alive && setPhase("done")); // sem WebGL: mostra só o resultado
    return () => {
      alive = false;
      scene.current?.dispose();
    };
  }, [result, force]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);

  useEffect(() => {
    if (phase !== "done") return;
    const t = setTimeout(close, result.dc !== undefined ? 5000 : 4000); // veredito pede um respiro a mais
    return () => clearTimeout(t);
  }, [phase, result.dc]);

  const tone = phase !== "done" || result.dc === undefined ? "" : result.success ? s.ok : s.fail;
  const adjusted = result.baseDc !== undefined && !!result.dcAdjust?.length;

  return (
    <div className="modal-backdrop">
      <div className={`modal ${s.modal} ${tone}`} role="dialog" aria-label="Rolar dados">
        <div className={s.head}>
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 2 21 7v10l-9 5-9-5V7l9-5Z" /><path d="M3 7l9 5 9-5M12 12v10" />
          </svg>
          <div className={s.title}>
            <h3>{result.reason || "Rolagem"}</h3>
            <div>{result.notation}</div>
          </div>
          {result.dc !== undefined && (
            <div className={s.dc} title={dcText(result)}><span>CD</span><b>{result.dc}</b></div>
          )}
        </div>
        {adjusted && (
          <div className={s.adjust}>
            Regras da mesa: CD pedida <b>{result.baseDc}</b>
            {result.dcAdjust!.map((a) => <span key={a.label}> {signed(a.value)} {a.label}</span>)} = <b>{result.dc}</b>
          </div>
        )}
        <div ref={box} className={s.box}>
          {phase === "loading" && <div className={s.hint}><Loader size={22} label="Preparando os dados" showLabel /></div>}
          {phase === "ready" && <div className={s.hint}>Segure, arraste e solte para rolar</div>}
          {phase === "done" && (
            <div className={`${s.result} ${tone}`} data-testid="dice-total" aria-live="assertive">
              <span className={s.total}>{result.total}</span>
              {result.dc !== undefined && <span className={s.verdict}>{result.success ? "Sucesso" : "Falha"}</span>}
              {result.crit && (
                <span className={s.crit}>{result.crit === "success" ? "Crítico · 20 natural" : "Desastre · 1 natural"}</span>
              )}
              <span className={s.math}>
                [{result.rolls.join(", ")}]{result.modifier ? ` ${signed(result.modifier)}` : ""} = {result.total}
                {result.dc !== undefined && ` contra CD ${result.dc}`}
                {shown < result.rolls.length && ` · ${result.rolls.length - shown} dado(s) fora da caixa`}
              </span>
            </div>
          )}
        </div>
        <div className={s.foot}>
          {phase !== "done" && <span className={s.note}>Esc pula a animação</span>}
          {phase !== "done" && <button className="btn ghost small" onClick={close}>Pular</button>}
          {phase === "ready" && <button className="btn small" onClick={() => scene.current?.throwRandom()}>Rolar</button>}
          {phase === "done" && <button className="btn primary small" autoFocus onClick={close}>Continuar</button>}
        </div>
      </div>
    </div>
  );
}
