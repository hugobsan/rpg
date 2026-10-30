"use client";
import { useEffect, useRef, useState } from "react";

interface Note { id: number; role: "player" | "gm"; content: string }
interface Directive { id: number; subject: string; content: string }

/** Conversa fora do jogo com o Mestre: o jogador fala como ele mesmo; nada disso entra na história. */
export default function OocModal({ campaignId, onClose }: { campaignId: string; onClose: () => void }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [directives, setDirectives] = useState<Directive[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const feedRef = useRef<HTMLDivElement>(null);

  const load = async () => {
    const d = await fetch(`/api/campaigns/${campaignId}/ooc`).then((r) => r.json());
    setNotes(d.notes || []);
    setDirectives(d.directives || []);
  };
  useEffect(() => {
    load();
  }, [campaignId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
  }, [notes, busy]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setBusy(true);
    setError("");
    setInput("");
    setNotes((n) => [...n, { id: -Date.now(), role: "player", content: text }]);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/ooc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) setError(d.error || `Erro ${res.status}`);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const removeDirective = async (id: number) => {
    setDirectives((ds) => ds.filter((d) => d.id !== id));
    await fetch(`/api/campaigns/${campaignId}/ooc?directive=${id}`, { method: "DELETE" });
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal ooc" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3 style={{ margin: 0, flex: 1 }}>
            💬 Falar com o Mestre <span className="ooc-tag">fora do jogo</span>
          </h3>
          <button className="btn ghost small" onClick={onClose} aria-label="Fechar">✕</button>
        </div>
        <div className="modal-body">
          <p className="muted" style={{ marginTop: 0 }}>
            Aqui você fala como você mesmo, não como o personagem. Nada disso aparece na história. Orientações
            (&quot;menos combate&quot;, &quot;na próxima cena quero treinar com o Iruka&quot;) viram diretrizes que o
            Mestre segue a partir do próximo turno; perguntas só são respondidas, sem spoilers.
          </p>
          {directives.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div className="ooc-tag" style={{ marginBottom: 6 }}>Diretrizes ativas</div>
              {directives.map((d) => (
                <div key={d.id} className="ooc-directive">
                  <span>📌 {d.content}{d.subject === "proxima_cena" && <span className="muted"> · nesta cena e na próxima</span>}</span>
                  <button title="Desativar esta diretriz" aria-label="Desativar diretriz" onClick={() => removeDirective(d.id)}>✕</button>
                </div>
              ))}
            </div>
          )}
          <div className="npc-chat-feed" ref={feedRef} style={{ maxHeight: "35vh", overflowY: "auto", minHeight: 120 }}>
            {notes.map((n) => (
              <div key={n.id} className={`npc-bubble ${n.role === "player" ? "ooc-player" : "npc"}`}>
                {n.content}
              </div>
            ))}
            {busy && (
              <div className="thinking">
                <span className="dot" /><span className="dot" /><span className="dot" />
                o Mestre está respondendo...
              </div>
            )}
          </div>
          {error && <p style={{ color: "var(--danger)", fontSize: 13 }}>{error}</p>}
        </div>
        <div className="modal-foot">
          <input
            type="text"
            value={input}
            placeholder="Fale com o Mestre como jogador (fora do jogo)..."
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            disabled={busy}
            autoFocus
            style={{ flex: 1 }}
          />
          <button className="btn primary small" onClick={send} disabled={busy || !input.trim()}>➤</button>
        </div>
      </div>
    </div>
  );
}
