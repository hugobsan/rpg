"use client";
import type { SceneStage, StageActor } from "@/lib/types";

/**
 * Palco da cena em 2D (scene.state.stage): o jogador no centro, anéis de distância
 * (corpo a corpo, perto, médio, longe) e as zonas do lugar como fatias. Cor pela postura,
 * escudo para cobertura, triângulo para elevação. Legível de relance em batalha.
 */
const RINGS = [
  { key: "corpo_a_corpo", r: 26, label: "corpo a corpo" },
  { key: "perto", r: 48, label: "perto" },
  { key: "medio", r: 71, label: "médio" },
  { key: "longe", r: 94, label: "longe" },
] as const;
const STANCE = {
  hostil: { fill: "var(--danger-soft)", stroke: "var(--danger)", label: "hostil" },
  aliado: { fill: "var(--ok-soft)", stroke: "var(--ok)", label: "aliado" },
  neutro: { fill: "var(--bg-hover)", stroke: "var(--text-dim)", label: "neutro" },
};
const ORDER = { hostil: 0, aliado: 1, neutro: 2 };
const first = (s: string) => s.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
// "Ninja renegado 2" → N2, "Kakashi Hatake" → KH
const initials = (s: string) => {
  const w = s.trim().split(/\s+/);
  const num = /^\d+$/.test(w.at(-1) ?? "") && w.length > 1 ? w.at(-1)! : "";
  return (num ? w[0][0] + num : w.length > 1 ? w[0][0] + w[1][0] : s.slice(0, 2)).toUpperCase();
};
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
// arredondado: servidor e navegador geram o mesmo SVG (hidratação)
const polar = (r: number, a: number) => [Math.round(Math.cos(a) * r * 100) / 100, Math.round(Math.sin(a) * r * 100) / 100] as const;

export function actorDetails(a: StageActor): string {
  return [
    STANCE[a.stance]?.label,
    RINGS.find((r) => r.key === a.distance)?.label,
    a.zone,
    a.cover && `cobertura ${a.cover}`,
    a.elevated && "elevado",
    a.note,
  ]
    .filter(Boolean)
    .join(" · ");
}

export default function StageView({ stage, player }: { stage: SceneStage; player: string }) {
  const me = stage.actors.find((a) => first(a.name) === first(player));
  const actors = stage.actors.filter((a) => a !== me);
  // fatias: zonas declaradas + zonas citadas pelos atores; sem zonas, o círculo inteiro
  const zones = [...stage.zones.map((z) => z.name)];
  for (const a of actors) if (a.zone && !zones.some((z) => z.toLowerCase() === a.zone!.toLowerCase())) zones.push(a.zone);
  const sector = (a: StageActor) => Math.max(0, zones.findIndex((z) => z.toLowerCase() === (a.zone ?? "").toLowerCase()));
  const n = Math.max(1, zones.length);
  const span = (2 * Math.PI) / n;
  const start = -Math.PI / 2 - span / 2;
  const tokens = actors.map((a) => {
    const ring = RINGS.find((r) => r.key === a.distance) ?? RINGS[2];
    const s = zones.length ? sector(a) : 0;
    const peers = actors.filter((b) => (zones.length ? sector(b) === s : true) && b.distance === a.distance);
    const k = peers.indexOf(a);
    const ringIdx = RINGS.indexOf(ring);
    const a0 = zones.length ? start + s * span : -Math.PI / 2 + ringIdx * 0.55;
    const ang = zones.length ? a0 + (span * (k + 1)) / (peers.length + 1) : a0 + (2 * Math.PI * k) / peers.length;
    const [x, y] = polar(ring.r, ang);
    return { a, x, y, ang };
  });
  const melee = actors.some((a) => a.stance === "hostil" && a.distance === "corpo_a_corpo");
  const hostile = actors.filter((a) => a.stance === "hostil").length;
  const allies = actors.filter((a) => a.stance === "aliado").length;
  const sorted = [...actors].sort(
    (a, b) => ORDER[a.stance] - ORDER[b.stance] || RINGS.findIndex((r) => r.key === a.distance) - RINGS.findIndex((r) => r.key === b.distance)
  );

  return (
    <div className="stage">
      <svg
        viewBox="-128 -124 256 248"
        role="img"
        aria-label={`Palco da cena: ${hostile} hostil(is), ${allies} aliado(s), ${actors.length - hostile - allies} neutro(s)`}
      >
        {[...RINGS].reverse().map((r) => (
          <circle
            key={r.key}
            r={r.r}
            style={{
              fill: r.key === "corpo_a_corpo" && melee ? "var(--danger-soft)" : "none",
              stroke: r.key === "corpo_a_corpo" && melee ? "var(--danger)" : "var(--border-strong)",
              strokeDasharray: r.key === "longe" ? "3 4" : undefined,
            }}
          />
        ))}
        {RINGS.map((r) => (
          <text key={r.key} y={r.r - 3} className="stage-ring-label" textAnchor="middle">
            {r.label}
          </text>
        ))}
        {zones.length > 1 &&
          zones.map((_, i) => {
            const [x1, y1] = polar(16, start + i * span);
            const [x2, y2] = polar(104, start + i * span);
            return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} className="stage-sector" />;
          })}
        {zones.map((z, i) => {
          const [x, y] = polar(zones.length > 1 ? 110 : 108, zones.length > 1 ? start + (i + 0.5) * span : -Math.PI / 2);
          return (
            <text key={z} x={x} y={y + 3} textAnchor={Math.abs(x) < 20 ? "middle" : x > 0 ? "start" : "end"} className="stage-zone">
              {cut(z, 16)}
            </text>
          );
        })}
        <g className="stage-token is-player">
          <title>{`${player || "Você"}${me ? `: ${actorDetails(me)}` : ""}`}</title>
          <circle r={12} style={{ fill: "var(--accent-soft)", stroke: "var(--accent)" }} />
          <text y={3.4} textAnchor="middle" style={{ fill: "var(--accent)" }}>
            {initials(player || "Você")}
          </text>
        </g>
        {tokens.map(({ a, x, y, ang }) => {
          const c = STANCE[a.stance] ?? STANCE.neutro;
          const toward = ang + Math.PI; // lado virado para o jogador
          const [ax, ay] = polar(14, toward - Math.PI / 2);
          const [bx, by] = polar(14, toward + Math.PI / 2);
          return (
            <g key={a.name} className="stage-token" transform={`translate(${x.toFixed(1)} ${y.toFixed(1)})`}>
              <title>{`${a.name}: ${actorDetails(a)}`}</title>
              {a.cover === "total" && <circle r={14} className="stage-cover" />}
              {a.cover === "parcial" && <path d={`M${ax} ${ay} A14 14 0 0 1 ${bx} ${by}`} className="stage-cover" />}
              <circle r={10} style={{ fill: c.fill, stroke: c.stroke }} />
              <text y={3.2} textAnchor="middle">
                {initials(a.name)}
              </text>
              {a.elevated && <path d="M-4 -13 L4 -13 L0 -19 Z" className="stage-elevated" />}
            </g>
          );
        })}
      </svg>
      {me?.zone && <p className="stage-caption">Você está em: {me.zone}</p>}
      {sorted.length > 0 && (
        <ul className="stage-list">
          {sorted.map((a) => (
            <li key={a.name}>
              <span className="stage-dot" style={{ background: (STANCE[a.stance] ?? STANCE.neutro).stroke }} />
              <span>
                <strong>{a.name}</strong> <span className="muted">{actorDetails(a).replace(`${STANCE[a.stance]?.label} · `, "")}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {stage.zones.some((z) => z.note) && (
        <p className="stage-caption">
          {stage.zones
            .filter((z) => z.note)
            .map((z) => `${z.name}: ${z.note}`)
            .join(" · ")}
        </p>
      )}
    </div>
  );
}
