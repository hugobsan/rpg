"use client";
import type { Character } from "@/lib/types";

export default function NpcList({ npcs, onOpen }: { npcs: Character[]; onOpen: (c: Character) => void }) {
  const active = npcs.filter((n) => n.active);
  const inactive = npcs.filter((n) => !n.active);
  const row = (n: Character) => (
    <div key={n.id} className="npc-row" onClick={() => onOpen(n)}>
      <span className="dot" style={{ background: n.active ? "var(--ok)" : "var(--border)" }} />
      <div className="info">
        <div className="nm">
          {n.name} {n.canon && <span className="pill">cânone</span>}
        </div>
        <div className="sub">{n.persona.personality || n.persona.appearance || "..."}</div>
      </div>
      <span className="muted">💬</span>
    </div>
  );
  return (
    <div>
      <h4 style={{ margin: "4px 0 8px" }}>Em cena</h4>
      {active.length ? active.map(row) : <p className="muted">Ninguém por perto.</p>}
      {inactive.length > 0 && (
        <>
          <h4 style={{ margin: "16px 0 8px" }}>Fora de cena</h4>
          {inactive.map(row)}
        </>
      )}
    </div>
  );
}
