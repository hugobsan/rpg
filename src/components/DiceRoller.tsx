"use client";
import { useEffect, useRef, useState } from "react";
import type { DiceResult } from "@/lib/types";

/** Texto do chip de rolagem no chat. */
export function diceText(r: DiceResult): string {
  return `🎲 ${r.notation}${r.reason ? ` (${r.reason})` : ""} → [${r.rolls.join(", ")}]${r.modifier ? ` ${r.modifier > 0 ? "+" : ""}${r.modifier}` : ""} = ${r.total}${r.dc !== undefined ? ` vs CD ${r.dc} · ${r.success ? "✓ passou" : "✗ não passou"}` : ""}`;
}

type Scene = { throwRandom(): void; dispose(): void };

/** Modal da caixa 3D: o jogador segura, arrasta e solta; os dados param nos valores de `result.rolls`. */
export default function DiceRoller({ result, onDone }: { result: DiceResult; onDone: () => void }) {
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
        });
        setPhase("ready");
      })
      .catch(() => alive && setPhase("done")); // sem WebGL: mostra só o resultado
    return () => {
      alive = false;
      scene.current?.dispose();
    };
  }, [result]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);

  useEffect(() => {
    if (phase !== "done") return;
    const t = setTimeout(close, 4000);
    return () => clearTimeout(t);
  }, [phase]);

  const color = result.dc === undefined ? "var(--accent)" : result.success ? "var(--ok)" : "var(--danger)";

  return (
    <div className="modal-backdrop">
      <div className="modal" style={{ maxWidth: 760 }} role="dialog" aria-label="Rolar dados">
        <div className="modal-head">
          <h3 style={{ margin: 0, flex: 1 }}>🎲 {result.reason || "Rolagem"}</h3>
          <span className="muted">{result.notation}{result.dc !== undefined ? ` · CD ${result.dc}` : ""}</span>
        </div>
        <div ref={box} style={{ position: "relative", height: "min(62vh, 460px)", background: "var(--bg)" }}>
          {phase !== "rolling" && phase !== "done" && (
            <div style={{ position: "absolute", left: 0, right: 0, bottom: 14, textAlign: "center", pointerEvents: "none", color: "var(--text-dim)", fontSize: 13 }}>
              {phase === "loading" ? "Preparando os dados..." : "Segure, arraste e solte para rolar"}
            </div>
          )}
        </div>
        <div className="modal-foot" style={{ alignItems: "center" }}>
          {phase === "done" && (
            <div data-testid="dice-total" style={{ flex: 1, display: "flex", alignItems: "baseline", gap: 12, color, fontFamily: "var(--serif)", minWidth: 0 }}>
              <span style={{ fontSize: 28, fontWeight: 700 }}>{result.total}</span>
              <span style={{ fontSize: 13 }}>
                [{result.rolls.join(", ")}]{result.modifier ? ` ${result.modifier > 0 ? "+" : "−"} ${Math.abs(result.modifier)}` : ""}
                {result.dc !== undefined && ` · vs CD ${result.dc} · ${result.success ? "✓ passou" : "✗ não passou"}`}
                {shown < result.rolls.length && (
                  <span className="muted"> · {result.rolls.length - shown} dado(s) rolado(s) fora da caixa</span>
                )}
              </span>
            </div>
          )}
          {phase !== "done" && <button className="btn ghost small" onClick={close}>Pular</button>}
          {phase === "ready" && <button className="btn small" onClick={() => scene.current?.throwRandom()}>Rolar</button>}
          {phase === "done" && <button className="btn primary small" autoFocus onClick={close}>Continuar</button>}
        </div>
      </div>
    </div>
  );
}
