"use client";
import { useState } from "react";
import type { Campaign, Character } from "@/lib/types";
import { attributeCap, attributePoints, levelThatAllows, powerLevel, trainingRules } from "@/lib/progression";

/** Ficha. Com onChange (só o jogador), mostra os pontos livres e o + por atributo. */
export default function SheetView({ char, campaign, onChange }: { char: Character; campaign: Campaign; onChange?: () => void }) {
  const rs = campaign.ruleset;
  const s = char.sheet;
  const rank = rs.ranks.find((r) => r.key === s.rank);
  const { level, next } = powerLevel(rs, s.xp);
  const pts = attributePoints(rs, s);
  const perHour = trainingRules(rs).hoursPerAttributePoint;
  const [busy, setBusy] = useState(false);
  const raise = async (key: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/campaigns/${campaign.id}/attributes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });
      if (!res.ok) alert((await res.json().catch(() => ({}))).error || "Não deu para subir o atributo.");
      onChange?.();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <h3 style={{ margin: "4px 0 2px" }}>{char.name}</h3>
      <div className="muted">
        <b style={{ color: "var(--text)" }}>Cargo:</b> {rank?.label || s.rank || "—"}
      </div>
      <div className="muted" style={{ marginBottom: 10 }}
        title="Nível de poder vem só da XP e define o teto dos atributos. Não é cargo: o cargo só muda pela história.">
        <b style={{ color: "var(--text)" }}>Nível de poder:</b> {level?.label || "—"} ({s.xp} XP
        {next ? `, próximo nível aos ${next.xpRequired}` : ""}){level?.attributeCap !== undefined && ` · teto de atributo ${level.attributeCap}`}
      </div>
      {onChange && (
        <div className="muted" style={{ marginBottom: 8 }}>
          <b style={{ color: pts.free ? "var(--accent)" : "var(--text)" }}>{pts.free} ponto{pts.free === 1 ? "" : "s"} livre{pts.free === 1 ? "" : "s"}</b>
          {` · 1 a cada ${rs.xpPerAttributePoint ?? 50} XP`}
        </div>
      )}
      {rs.resources.map((r) => {
        const v = s.resources[r.key];
        if (!v) return null;
        const pct = Math.max(0, Math.min(100, (v.current / Math.max(1, v.max)) * 100));
        return (
          <div key={r.key} className="bar-row">
            <div className="bar-name"><span>{r.label}</span><span>{v.current}/{v.max}</span></div>
            <div className="bar-outer">
              <div className="bar-inner" style={{ width: `${pct}%`, background: r.color }} />
            </div>
          </div>
        );
      })}
      <div className="attr-grid">
        {rs.attributes.map((a, i) => {
          const v = s.attributes[a.key] ?? a.default;
          const cap = attributeCap(rs, s.xp, a.key);
          const wait = v >= cap ? levelThatAllows(rs, a.key, v) : undefined;
          const hours = s.trainingHours?.[a.key];
          const plusTip = v >= cap ? (wait ? `aguarda o nível ${wait.label}` : "no máximo") : pts.free ? `+1 ${a.label} (gasta 1 ponto livre)` : "sem pontos livres";
          return (
            <div key={a.key} className="attr-cell has-tip" tabIndex={0}>
              <div className="v">{s.attributes[a.key] ?? "-"}</div>
              <div className="k">{a.label}</div>
              {onChange && (
                <button className="btn ghost small" style={{ padding: "0 8px", marginTop: 3 }} aria-label={plusTip} title={plusTip}
                  disabled={busy || !pts.free || v >= cap} onClick={() => raise(a.key)}>+</button>
              )}
              {/* mesmo balão da criação de personagem; colunas da direita abrem para a esquerda */}
              <div className={`attr-tip${i % 4 >= 2 ? " right" : ""}`}>
                {[
                  a.description,
                  rs.diceNotes?.split(/\.\s/)[0],
                  `Teto no nível de poder atual: ${Math.min(cap, a.max)}${v > cap ? ` (${v} veio da criação e fica como está)` : ""}${wait ? `; sobe a partir do nível ${wait.label}` : ""}. Máximo ${a.max}.`,
                  hours ? `Treino: ${hours}/${perHour * v} h para o próximo +1.` : "",
                ].filter(Boolean).join("\n\n")}
              </div>
            </div>
          );
        })}
      </div>
      {Object.entries(s.extra || {}).filter(([, v]) => v).map(([k, v]) => {
        const f = rs.extraFields.find((x) => x.key === k);
        return (
          <div key={k} className="muted" style={{ marginBottom: 3 }}>
            <b style={{ color: "var(--text)" }}>{f?.label || k}:</b> {v}
          </div>
        );
      })}
    </div>
  );
}
