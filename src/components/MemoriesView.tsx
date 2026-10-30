"use client";
import { useState } from "react";

export default function MemoriesView({
  memories,
}: {
  memories: { id: number; kind: string; subject: string | null; content: string; importance: number }[];
}) {
  const KIND_ICON: Record<string, string> = {
    milestone: "🏆",
    event: "📜",
    npc: "🎭",
    discovery: "💡",
    relationship: "🤝",
    directive: "📌",
  };
  const [filter, setFilter] = useState("all");
  const shown = memories.filter((m) => filter === "all" || m.kind === filter);
  return (
    <div>
      <select value={filter} onChange={(e) => setFilter(e.target.value)} style={{ marginBottom: 10 }}>
        <option value="all">Tudo</option>
        <option value="milestone">🏆 Marcos</option>
        <option value="event">📜 Eventos</option>
        <option value="npc">🎭 NPCs</option>
        <option value="discovery">💡 Descobertas</option>
        <option value="relationship">🤝 Relações</option>
        <option value="directive">📌 Diretrizes (fora do jogo)</option>
      </select>
      {shown.length === 0 && <p className="muted">Nada registrado ainda — a memória da campanha cresce conforme você joga.</p>}
      {shown.map((m) => (
        <div key={m.id} className="ability-item">
          <div className="sub">
            {KIND_ICON[m.kind] || "•"} {m.kind}
            {m.subject ? ` · ${m.subject}` : ""} · imp {m.importance}
          </div>
          <div style={{ fontSize: 13 }}>{m.content}</div>
        </div>
      ))}
    </div>
  );
}
