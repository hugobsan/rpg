"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Campaign,
  CampaignScript,
  Character,
  Scene,
  TurnEvent,
  VoiceProfile,
} from "@/lib/types";
import NpcModal from "./NpcModal";

// ---------- helpers ----------

const MODE_LABEL: Record<string, string> = {
  exploration: "Exploração",
  dialogue: "Diálogo",
  battle: "Batalha",
  training: "Treinamento",
  downtime: "Descanso",
};
const MODE_COLOR: Record<string, string> = {
  exploration: "var(--mode-exploration)",
  dialogue: "var(--mode-dialogue)",
  battle: "var(--mode-battle)",
  training: "var(--mode-training)",
  downtime: "var(--mode-downtime)",
};

/** Renderização mínima de markdown (negrito/itálico) da narração. */
function md(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>");
}

interface FeedItem {
  key: string;
  kind: "player" | "gm" | "chip" | "dice";
  content: string;
}

interface StateShape {
  campaign: Campaign;
  scene: Scene;
  characters: Character[];
  books: { id: string; title: string; pages: number }[];
  messages: { id: number; role: string; content: string; meta: { choices?: string[] } }[];
  memories: { id: number; kind: string; subject: string | null; content: string; importance: number }[];
  lastImage: { data_url: string } | null;
}

export default function GameClient({ campaignId }: { campaignId: string }) {
  const [state, setState] = useState<StateShape | null>(null);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [choices, setChoices] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [statusText, setStatusText] = useState("");
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"sheet" | "npcs" | "memories" | "books" | "script">("sheet");
  const [imageBusy, setImageBusy] = useState(false);
  const [sceneImage, setSceneImage] = useState<string | null>(null);
  const [openNpc, setOpenNpc] = useState<Character | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const keyCounter = useRef(0);

  const nextKey = () => `k${++keyCounter.current}`;

  const reloadState = useCallback(async () => {
    const res = await fetch(`/api/campaigns/${campaignId}`);
    if (!res.ok) {
      setError("Campanha não encontrada.");
      return;
    }
    const data = (await res.json()) as StateShape;
    setState(data);
    if (data.lastImage) setSceneImage(data.lastImage.data_url);
    return data;
  }, [campaignId]);

  useEffect(() => {
    reloadState().then((data) => {
      if (!data) return;
      const items: FeedItem[] = data.messages.map((m) => ({
        key: `m${m.id}`,
        kind: m.role === "player" ? "player" : "gm",
        content: m.content,
      }));
      setFeed(items);
      const last = data.messages[data.messages.length - 1];
      if (last?.meta?.choices?.length) setChoices(last.meta.choices);
    });
  }, [reloadState]);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: "smooth" });
  }, [feed, statusText]);

  // ---------- turno ----------

  const sendTurn = async (text: string) => {
    if (busy || !text.trim()) return;
    setBusy(true);
    setError("");
    setChoices([]);
    setFeed((f) => [...f, { key: nextKey(), kind: "player", content: text }]);
    setInput("");
    setStatusText("O Mestre está pensando...");
    let stateDirty = false;
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/turn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: text }),
      });
      if (!res.ok || !res.body) throw new Error(`Erro ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";
        for (const part of parts) {
          const line = part.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          const ev = JSON.parse(line.slice(6)) as TurnEvent;
          switch (ev.type) {
            case "status":
              setStatusText(ev.text);
              break;
            case "tool":
              setFeed((f) => [...f, { key: nextKey(), kind: "chip", content: ev.summary }]);
              break;
            case "dice":
              setFeed((f) => [
                ...f,
                {
                  key: nextKey(),
                  kind: "dice",
                  content: `🎲 ${ev.result.notation}${ev.result.reason ? ` (${ev.result.reason})` : ""} → [${ev.result.rolls.join(", ")}]${ev.result.modifier ? ` ${ev.result.modifier > 0 ? "+" : ""}${ev.result.modifier}` : ""} = ${ev.result.total}`,
                },
              ]);
              break;
            case "narration":
              setFeed((f) => [...f, { key: nextKey(), kind: "gm", content: ev.content }]);
              break;
            case "choices":
              setChoices(ev.choices);
              break;
            case "scene":
              stateDirty = true;
              break;
            case "state":
              stateDirty = true;
              break;
            case "error":
              setError(ev.message);
              break;
            case "done":
              break;
          }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setStatusText("");
      if (stateDirty || true) reloadState();
    }
  };

  const generateImage = async () => {
    setImageBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/image`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Falha ao gerar imagem");
      setSceneImage(data.dataUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImageBusy(false);
    }
  };

  if (error && !state) return <div className="container"><div className="error-box">{error}</div></div>;
  if (!state) return <div className="container"><p className="muted">Carregando campanha...</p></div>;

  const { campaign, scene, characters } = state;
  const player = characters.find((c) => c.kind === "player");
  const npcs = characters.filter((c) => c.kind === "npc");
  const modeColor = MODE_COLOR[scene.mode] || "var(--accent)";

  return (
    <div className="game-layout">
      <div className="game-main">
        <div className="scene-banner">
          <span className="mode-badge" style={{ color: modeColor }}>
            {MODE_LABEL[scene.mode] || scene.mode}
          </span>
          <span style={{ fontFamily: "var(--serif)", fontSize: 15 }}>{campaign.name}</span>
          {scene.location && <span className="loc">📍 {scene.location}</span>}
          <span style={{ flex: 1 }} />
          <button className="btn ghost small" onClick={generateImage} disabled={imageBusy}>
            {imageBusy ? "pintando..." : "🖼 Ver ambiente"}
          </button>
        </div>

        <div className="feed" ref={feedRef}>
          <div className="feed-inner">
            {feed.length === 0 && !busy && (
              <div style={{ textAlign: "center", padding: "60px 20px" }}>
                <h2>A aventura aguarda</h2>
                <p className="muted">O Mestre abrirá a primeira cena com base no seu personagem e no ponto de partida escolhido.</p>
                <button
                  className="btn primary"
                  onClick={() =>
                    sendTurn(
                      "(Mestre: abra a aventura. Apresente a cena inicial no ponto de partida combinado, situe meu personagem no mundo e, se descrevi NPCs iniciais na configuração da campanha, crie-os agora com create_npc.)"
                    )
                  }
                >
                  ⚔ Iniciar aventura
                </button>
              </div>
            )}
            {feed.map((item) =>
              item.kind === "player" ? (
                <div key={item.key} className="msg-player">{item.content}</div>
              ) : item.kind === "gm" ? (
                <div key={item.key} className="msg-gm" dangerouslySetInnerHTML={{ __html: md(item.content) }} />
              ) : (
                <div key={item.key} className={`event-chip ${item.kind}`}>{item.content}</div>
              )
            )}
            {busy && (
              <div className="thinking">
                <span className="dot" /><span className="dot" /><span className="dot" />
                {statusText}
              </div>
            )}
            {error && <div className="error-box">{error}</div>}
            {!busy && choices.length > 0 && (
              <div className="choices">
                {choices.map((c, i) => (
                  <button key={i} className="choice-btn" onClick={() => sendTurn(c)}>
                    {c}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="composer">
          <div className="composer-inner">
            <textarea
              value={input}
              placeholder={
                campaign.style === "guided" && choices.length
                  ? "Escolha uma opção acima (ou descreva como executa a sua escolha)..."
                  : "O que você faz?"
              }
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendTurn(input);
                }
              }}
              disabled={busy}
            />
            <button className="btn primary" onClick={() => sendTurn(input)} disabled={busy || !input.trim()}>
              ➤
            </button>
          </div>
        </div>
      </div>

      <aside className="game-side">
        <div className="side-tabs">
          {(
            [
              ["sheet", "Ficha"],
              ["npcs", `NPCs (${npcs.filter((n) => n.active).length})`],
              ["memories", "Marcos"],
              ["books", "Livros"],
              ["script", "Roteiro"],
            ] as const
          ).map(([k, label]) => (
            <button key={k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>
              {label}
            </button>
          ))}
        </div>
        <div className="side-body">
          {sceneImage && tab === "sheet" && (
            <img src={sceneImage} alt="Cena atual" className="scene-image" style={{ marginBottom: 12 }} />
          )}
          {tab === "sheet" && player && <SheetView char={player} campaign={campaign} />}
          {tab === "npcs" && (
            <NpcList npcs={npcs} onOpen={setOpenNpc} />
          )}
          {tab === "memories" && <MemoriesView memories={state.memories} />}
          {tab === "books" && (
            <BooksView campaignId={campaignId} books={state.books} onChange={reloadState} />
          )}
          {tab === "script" && <ScriptView script={campaign.script} campaignId={campaignId} onChange={reloadState} />}
        </div>
      </aside>

      {openNpc && (
        <NpcModal
          campaignId={campaignId}
          npc={openNpc}
          campaign={campaign}
          onClose={() => {
            setOpenNpc(null);
            reloadState();
          }}
        />
      )}
    </div>
  );
}

// ---------- subcomponentes da sidebar ----------

export function SheetView({ char, campaign }: { char: Character; campaign: Campaign }) {
  const rs = campaign.ruleset;
  const s = char.sheet;
  const rank = rs.ranks.find((r) => r.key === s.rank);
  const nextRank = rs.ranks.find((r) => r.xpRequired > (rank?.xpRequired ?? 0));
  return (
    <div>
      <h3 style={{ margin: "4px 0 2px" }}>{char.name}</h3>
      <div className="muted" style={{ marginBottom: 10 }}>
        {rank?.label || s.rank || "—"} · {s.xp} XP
        {nextRank ? ` (próximo: ${nextRank.label} aos ${nextRank.xpRequired})` : ""}
      </div>
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
        {rs.attributes.map((a, i) => (
          <div key={a.key} className="attr-cell has-tip" tabIndex={0}>
            <div className="v">{s.attributes[a.key] ?? "-"}</div>
            <div className="k">{a.label}</div>
            {/* mesmo balão da criação de personagem; colunas da direita abrem para a esquerda */}
            <div className={`attr-tip${i % 4 >= 2 ? " right" : ""}`}>
              {[a.description, rs.diceNotes?.split(/\.\s/)[0], `Máximo ${a.max}`].filter(Boolean).join("\n\n")}
            </div>
          </div>
        ))}
      </div>
      {Object.entries(s.extra || {}).filter(([, v]) => v).map(([k, v]) => {
        const f = rs.extraFields.find((x) => x.key === k);
        return (
          <div key={k} className="muted" style={{ marginBottom: 3 }}>
            <b style={{ color: "var(--text)" }}>{f?.label || k}:</b> {v}
          </div>
        );
      })}
      {s.abilities.length > 0 && (
        <>
          <h4 style={{ margin: "14px 0 8px" }}>Habilidades</h4>
          {s.abilities.map((a) => {
            const milestones = (a.milestones || []).slice().sort((x, y) => x.threshold - y.threshold);
            const progress = a.progress ?? null;
            const cur = progress === null ? null : [...milestones].reverse().find((m) => m.threshold <= progress);
            const next = progress === null ? null : milestones.find((m) => m.threshold > progress);
            return (
              <div key={a.name} className="ability-item">
                <div className="name">
                  {a.name} {a.rank && <span className="pill">{a.rank}</span>}
                  {progress !== null && <span className="pill">{progress}%</span>}
                </div>
                <div className="sub">
                  {rs.abilityTypes.find((t) => t.key === a.type)?.label || a.type}
                  {a.description ? ` — ${a.description}` : ""}
                </div>
                {progress !== null && (
                  <div className="bar-outer" style={{ height: 7, marginTop: 6 }}>
                    <div className="bar-inner" style={{ width: `${progress}%`, background: "var(--accent)" }} />
                  </div>
                )}
                {cur && <div className="sub" style={{ marginTop: 5 }}>▸ {cur.description}</div>}
                {next && (
                  <div className="sub" style={{ opacity: 0.7 }}>
                    próximo marco aos {next.threshold}%: {next.description}
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}
      {s.inventory.length > 0 && (
        <>
          <h4 style={{ margin: "14px 0 8px" }}>Inventário</h4>
          {s.inventory.map((i) => (
            <div key={i.name} className="muted" style={{ marginBottom: 3 }}>
              {i.qty}x <b style={{ color: "var(--text)" }}>{i.name}</b>
              {i.description ? ` — ${i.description}` : ""}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function NpcList({ npcs, onOpen }: { npcs: Character[]; onOpen: (c: Character) => void }) {
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

function MemoriesView({
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

function BooksView({
  campaignId,
  books,
  onChange,
}: {
  campaignId: string;
  books: { id: string; title: string; pages: number }[];
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const upload = async (f: File) => {
    setBusy(true);
    setMsg("Indexando (páginas + chunks + embeddings)...");
    const fd = new FormData();
    fd.append("file", f);
    fd.append("title", f.name.replace(/\.\w+$/, ""));
    const res = await fetch(`/api/campaigns/${campaignId}/books`, { method: "POST", body: fd });
    const data = await res.json();
    setBusy(false);
    setMsg(res.ok ? `✓ ${data.pages} páginas, ${data.chunks} chunks indexados.` : `Erro: ${data.error}`);
    onChange();
  };
  return (
    <div>
      {books.map((b) => (
        <div key={b.id} className="ability-item">
          <div className="name">📖 {b.title}</div>
          <div className="sub">{b.pages} páginas indexadas</div>
        </div>
      ))}
      {books.length === 0 && <p className="muted">Nenhum material indexado. O Mestre consulta livros via busca semântica e leitura de páginas.</p>}
      <input
        type="file"
        accept=".pdf,.txt,.md"
        disabled={busy}
        onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
        style={{ marginTop: 8 }}
      />
      {msg && <p className="muted">{msg}</p>}
    </div>
  );
}

function ScriptView({
  script,
  campaignId,
  onChange,
}: {
  script: CampaignScript | null;
  campaignId: string;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const regen = async () => {
    if (script && !confirm("Regenerar o roteiro descarta o atual (notas de progresso inclusas). Continuar?")) return;
    setBusy(true);
    await fetch(`/api/campaigns/${campaignId}/script`, { method: "POST" });
    setBusy(false);
    onChange();
  };
  const STATUS: Record<string, string> = { active: "▶ ativo", done: "✓ concluído", pending: "· pendente" };
  return (
    <div>
      {!script && <p className="muted">Sem roteiro. O Roteirista pode montar arcos, eventos canônicos e ganchos baseados no seu personagem.</p>}
      {script && (
        <>
          <p style={{ fontSize: 13, fontStyle: "italic" }}>{script.premise}</p>
          {script.arcs.map((a, i) => (
            <div key={i} className="ability-item" style={{ opacity: a.status === "done" ? 0.55 : 1 }}>
              <div className="name">
                {a.title} <span className="pill">{STATUS[a.status] || a.status}</span>
              </div>
              <div className="sub">{a.summary}</div>
              {a.canonEvents.length > 0 && (
                <div className="sub" style={{ marginTop: 4 }}>⚓ {a.canonEvents.join(" · ")}</div>
              )}
              {a.notes.length > 0 && (
                <div className="sub" style={{ marginTop: 4 }}>✎ {a.notes.slice(-3).join(" · ")}</div>
              )}
            </div>
          ))}
        </>
      )}
      <button className="btn ghost small" onClick={regen} disabled={busy} style={{ marginTop: 8 }}>
        {busy ? "gerando..." : script ? "Regenerar roteiro" : "Gerar roteiro"}
      </button>
      <div style={{ marginTop: 14, display: "flex", flexWrap: "wrap", gap: 6 }}>
        <a className="btn ghost small" style={{ whiteSpace: "nowrap", textDecoration: "none" }} href={`/api/campaigns/${campaignId}/export?what=ruleset`}>⬇ Exportar mecânica (JSON)</a>
        <a className="btn ghost small" style={{ whiteSpace: "nowrap", textDecoration: "none" }} href={`/api/campaigns/${campaignId}/export?what=full`}>⬇ Exportar campanha</a>
      </div>
    </div>
  );
}

export type { VoiceProfile };
