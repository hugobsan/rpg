"use client";
import { Fragment, useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import type {
  Campaign,
  CampaignScript,
  Character,
  DiceResult,
  Scene,
  TurnEvent,
} from "@/lib/types";
import NpcModal, { playLine } from "./NpcModal";
import ImageViewer from "./ImageViewer";
import Gallery from "./Gallery";
import InventoryView from "./InventoryView";
import AbilitiesView from "./AbilitiesView";
import ObjectivesView from "./ObjectivesView";
import DiceRoller, { diceText } from "./DiceRoller";
import { formatClock, getClock, period, PERIOD_ICON } from "@/lib/clock";

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
  outcome?: "ok" | "fail"; // rolagem com CD: passou ou não
}

interface StateShape {
  campaign: Campaign;
  scene: Scene;
  characters: Character[];
  books: { id: string; title: string; pages: number }[];
  messages: { id: number; role: string; content: string; meta: { choices?: string[] } }[];
  memories: { id: number; kind: string; subject: string | null; content: string; importance: number }[];
  lastImage: { id: number; data_url: string } | null;
}

const toFeed = (messages: StateShape["messages"]): FeedItem[] =>
  messages.map((m) => ({ key: `m${m.id}`, kind: m.role === "player" ? "player" : "gm", content: m.content }));

const SIDE_KEY = "chronicle.sideWidth";
const SIDE_DEFAULT = 340;
// entre 260px e o que deixa pelo menos 420px para o chat (máx. 760px)
const clampSide = (w: number) =>
  Math.round(Math.min(Math.max(w, 260), Math.min(760, (typeof window !== "undefined" ? window.innerWidth : 1400) - 420)));

export default function GameClient({ campaignId }: { campaignId: string }) {
  const [state, setState] = useState<StateShape | null>(null);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [choices, setChoices] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [statusText, setStatusText] = useState("");
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"sheet" | "abilities" | "inventory" | "objectives" | "npcs" | "memories" | "books" | "script" | "gallery">("sheet");
  const [imageFull, setImageFull] = useState(false);
  // largura da barra lateral, ajustável pela alça entre ela e o chat (lembrada neste navegador)
  const [sideW, setSideW] = useState(SIDE_DEFAULT);
  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(SIDE_KEY));
      if (saved) setSideW(clampSide(saved));
    } catch {}
  }, []);
  const saveSide = (w: number) => {
    try { localStorage.setItem(SIDE_KEY, String(w)); } catch {}
  };
  const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    let w = sideW;
    const move = (ev: PointerEvent) => setSideW((w = clampSide(window.innerWidth - ev.clientX)));
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      saveSide(w);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
  const [imageBusy, setImageBusy] = useState(false);
  const [sceneImage, setSceneImage] = useState<string | null>(null);
  const [sceneImageId, setSceneImageId] = useState<number | null>(null);
  const [imageGen, setImageGen] = useState(false); // só mostra "Ver ambiente" depois de ler a config
  const [regenOpen, setRegenOpen] = useState(false);
  const [regenReason, setRegenReason] = useState("");
  const [openNpc, setOpenNpc] = useState<Character | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const keyCounter = useRef(0);

  const nextKey = () => `k${++keyCounter.current}`;

  // Animação 3D dos dados: a partir de um evento "dice", o resto do turno fica retido
  // até o jogador rolar (um botão por rolagem, em fila).
  const diceAnim = useRef(true);
  const held = useRef<TurnEvent[]>([]);
  const reloadAfterHeld = useRef(false);
  const [pendingDice, setPendingDice] = useState<DiceResult | null>(null);
  const [rolling, setRolling] = useState<DiceResult | null>(null);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => {
        diceAnim.current = d.ui?.diceAnimation !== false;
        setImageGen(d.ui?.imageGeneration !== false);
      })
      .catch(() => {});
  }, []);

  const showEvent = (ev: TurnEvent) => {
    if (ev.type === "tool") setFeed((f) => [...f, { key: nextKey(), kind: "chip", content: ev.summary }]);
    else if (ev.type === "dice")
      setFeed((f) => [
        ...f,
        {
          key: nextKey(),
          kind: "dice",
          content: diceText(ev.result),
          outcome: ev.result.dc === undefined ? undefined : ev.result.success ? "ok" : "fail",
        },
      ]);
    else if (ev.type === "narration") setFeed((f) => [...f, { key: nextKey(), kind: "gm", content: ev.content }]);
    else if (ev.type === "choices") setChoices(ev.choices);
    else if (ev.type === "time")
      setState((s) => s && { ...s, campaign: { ...s.campaign, state: { ...s.campaign.state, clock: { minutes: ev.minutes } } } });
  };

  // libera os eventos retidos até a próxima rolagem (all: libera tudo, sem animar)
  const drainHeld = (all = false) => {
    while (held.current.length) {
      const ev = held.current[0];
      if (ev.type === "dice" && !all) return setPendingDice(ev.result);
      held.current.shift();
      showEvent(ev);
    }
    setPendingDice(null);
    if (reloadAfterHeld.current) {
      reloadAfterHeld.current = false;
      reloadState();
    }
  };

  const releaseDice = () => {
    const ev = held.current.shift();
    if (ev) showEvent(ev);
    setRolling(null);
    drainHeld();
  };

  const reloadState = useCallback(async () => {
    const res = await fetch(`/api/campaigns/${campaignId}`);
    if (!res.ok) {
      setError("Campanha não encontrada.");
      return;
    }
    const data = (await res.json()) as StateShape;
    setState(data);
    setSceneImage(data.lastImage?.data_url ?? null); // null quando apagada ou tirada da ficha
    setSceneImageId(data.lastImage?.id ?? null);
    return data;
  }, [campaignId]);

  useEffect(() => {
    reloadState().then((data) => {
      if (!data) return;
      setFeed(toFeed(data.messages));
      const last = data.messages[data.messages.length - 1];
      if (last?.meta?.choices?.length) setChoices(last.meta.choices);
    });
  }, [reloadState]);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: "smooth" });
  }, [feed, statusText]);

  // ---------- turno ----------

  // regen: gera de novo a resposta do último turno (o servidor volta o estado de antes dele)
  const sendTurn = async (text: string, regen?: { feedback: string }) => {
    if (busy || (!regen && !text.trim())) return;
    setRegenOpen(false);
    setBusy(true);
    setError("");
    setChoices([]);
    setRolling(null);
    drainHeld(true);
    if (regen) {
      // tira do chat o que veio depois da última ação do jogador
      setFeed((f) => {
        const lastPlayer = f.map((i) => i.kind).lastIndexOf("player");
        return lastPlayer >= 0 ? f.slice(0, lastPlayer + 1) : f;
      });
    } else {
      setFeed((f) => [...f, { key: nextKey(), kind: "player", content: text }]);
      setInput("");
    }
    setStatusText("O Mestre está pensando...");
    let stateDirty = false;
    let failed = false;
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/turn`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(regen ? { regenerate: true, feedback: regen.feedback } : { input: text }),
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
            case "dice":
            case "narration":
            case "choices":
            case "time":
              if (diceAnim.current && (ev.type === "dice" || held.current.length)) {
                held.current.push(ev);
                if (ev.type === "dice" && held.current.length === 1) setPendingDice(ev.result);
              } else showEvent(ev);
              break;
            case "scene":
              stateDirty = true;
              break;
            case "state":
              stateDirty = true;
              break;
            case "error":
              failed = true;
              setError(ev.message);
              break;
            case "done":
              break;
          }
        }
      }
    } catch (e) {
      failed = true;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setStatusText("");
      // ficha/cena só atualizam depois da rolagem, para não adiantar o resultado
      if (held.current.length && !failed) {
        reloadAfterHeld.current = true;
        return;
      }
      drainHeld(true);
      const data = await reloadState();
      // se o "gerar novamente" falhou, o chat volta a refletir o que está salvo
      if (regen && failed && data) setFeed(toFeed(data.messages));
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
      setSceneImageId(Number(data.id));
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
  const clock = getClock(campaign.state);

  return (
    <div className="game-layout" style={{ "--side-w": `${sideW}px` } as CSSProperties}>
      <div className="game-main">
        <div className="scene-banner">
          <span className="mode-badge" style={{ color: modeColor }}>
            {MODE_LABEL[scene.mode] || scene.mode}
          </span>
          <span style={{ fontFamily: "var(--serif)", fontSize: 15 }}>{campaign.name}</span>
          {scene.location && <span className="loc">📍 {scene.location}</span>}
          {clock ? (
            <span className="loc" title="Hora na história (o Mestre avança a cada interação)">
              {PERIOD_ICON[period(clock.minutes)]} {formatClock(clock.minutes)} · {period(clock.minutes)}
            </span>
          ) : (
            <span className="loc" title="O Mestre define a hora no próximo turno">🕐 hora ainda não definida</span>
          )}
          <span style={{ flex: 1 }} />
          {imageGen && (
            <button className="btn ghost small" onClick={() => generateImage()} disabled={imageBusy}>
              {imageBusy ? "pintando..." : "🖼 Ver ambiente"}
            </button>
          )}
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
                <div key={item.key} className="msg-gm">
                  {/* linha a linha para pôr o 🔊 nas falas de NPC (**Nome:** "fala") */}
                  {item.content.split("\n").map((line, i) => {
                    const m = line.match(/^\*\*([^*]+?):\*\*\s*(.+)$/);
                    const npc = m && npcs.find((n) => n.name.toLowerCase() === m[1].trim().toLowerCase());
                    return (
                      <Fragment key={i}>
                        {i > 0 && "\n"}
                        <span dangerouslySetInnerHTML={{ __html: md(line) }} />
                        {npc && m && (
                          <button className="speak" title={`Ouvir ${npc.name}`}
                            onClick={() => playLine(campaignId, npc, m[2])}>🔊</button>
                        )}
                      </Fragment>
                    );
                  })}
                </div>
              ) : (
                <div key={item.key} className={`event-chip ${item.kind}${item.outcome ? ` ${item.outcome}` : ""}`}>{item.content}</div>
              )
            )}
            {pendingDice && (
              <button className="btn primary" style={{ alignSelf: "center" }} onClick={() => setRolling(pendingDice)}>
                🎲 Rolar dados · {pendingDice.reason ? `${pendingDice.reason} ` : ""}({pendingDice.notation})
              </button>
            )}
            {busy && (
              <div className="thinking">
                <span className="dot" /><span className="dot" /><span className="dot" />
                {statusText}
              </div>
            )}
            {error && <div className="error-box">{error}</div>}
            {!busy && !pendingDice && feed.some((i) => i.kind === "player") && (
              <button className="btn ghost small" style={{ alignSelf: "flex-start" }}
                onClick={() => { setRegenReason(""); setRegenOpen(true); }}>
                ↻ Gerar novamente
              </button>
            )}
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
        <div className="side-resizer" onPointerDown={startResize}
          onDoubleClick={() => { setSideW(SIDE_DEFAULT); saveSide(SIDE_DEFAULT); }}
          title="Arraste para ajustar a largura · duplo clique volta ao padrão" />
        <div className="side-tabs">
          {(
            [
              ["sheet", "Ficha"],
              ["abilities", campaign.ruleset.abilitiesLabel || "Habilidades"],
              ["inventory", "Inventário"],
              ["objectives", "Missões"],
              ["npcs", `NPCs (${npcs.filter((n) => n.active).length})`],
              ["memories", "Marcos"],
              ["books", "Livros"],
              ["script", "Roteiro"],
              ["gallery", "Galeria"],
            ] as const
          ).map(([k, label]) => (
            <button key={k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>
              {label}
            </button>
          ))}
        </div>
        <div className="side-body">
          {sceneImage && tab === "sheet" && (
            <div style={{ marginBottom: 12, position: "relative" }}>
              <img src={sceneImage} alt="Cena atual" className="scene-image" onClick={() => setImageFull(true)} />
              {sceneImageId && (
                <button className="scene-image-close" title="Tirar da ficha (continua na Galeria)" aria-label="Tirar imagem da ficha"
                  onClick={async () => {
                    setSceneImage(null);
                    await fetch(`/api/campaigns/${campaignId}`, {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ hideSheetImageId: sceneImageId }),
                    });
                  }}>✕</button>
              )}
            </div>
          )}
          {tab === "sheet" && player && <SheetView char={player} campaign={campaign} />}
          {tab === "abilities" && player && <AbilitiesView char={player} ruleset={campaign.ruleset} />}
          {tab === "inventory" && player && (
            <InventoryView char={player} campaignId={campaignId} disabled={busy} onChange={reloadState} />
          )}
          {tab === "objectives" && <ObjectivesView state={campaign.state} />}
          {tab === "npcs" && (
            <NpcList npcs={npcs} onOpen={setOpenNpc} />
          )}
          {tab === "memories" && <MemoriesView memories={state.memories} />}
          {tab === "books" && (
            <BooksView campaignId={campaignId} books={state.books} onChange={reloadState} />
          )}
          {tab === "gallery" && <Gallery campaignId={campaignId} refreshKey={sceneImage} onDeleted={reloadState} />}
          {tab === "script" && <ScriptView script={campaign.script} campaignId={campaignId} onChange={reloadState} />}
        </div>
      </aside>

      {imageFull && sceneImage && (
        <ImageViewer items={[{ src: sceneImage }]} index={0} onIndex={() => {}} onClose={() => setImageFull(false)} />
      )}
      {regenOpen && (
        <div className="modal-backdrop" onClick={() => setRegenOpen(false)}>
          <div className="modal" style={{ maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><h3 style={{ margin: 0 }}>Gerar a resposta do Mestre novamente</h3></div>
            <div className="modal-body">
              <p className="muted" style={{ marginTop: 0 }}>
                O turno é desfeito (dano, XP, itens, NPCs e memórias voltam ao que eram antes da sua última ação)
                e o Mestre responde de novo à mesma ação.
              </p>
              <label className="field" style={{ marginBottom: 0 }}>
                <span>O que você quer diferente? (opcional)</span>
                <textarea autoFocus value={regenReason} onChange={(e) => setRegenReason(e.target.value)}
                  placeholder="Ex: o Iruka não falaria assim; quero menos descrição e mais ação; respeite que já anoiteceu..." />
              </label>
            </div>
            <div className="modal-foot">
              <button className="btn ghost small" onClick={() => setRegenOpen(false)}>Cancelar</button>
              <button className="btn ghost small" onClick={() => sendTurn("", { feedback: "" })}>Gerar sem motivo</button>
              <button className="btn primary small" disabled={!regenReason.trim()}
                onClick={() => sendTurn("", { feedback: regenReason })}>Gerar com esse ajuste</button>
            </div>
          </div>
        </div>
      )}

      {rolling && <DiceRoller result={rolling} onDone={releaseDice} />}

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
  const [show, setShow] = useState(false);
  return (
    <div>
      <div className="ability-item" style={{ marginBottom: 12 }}>
        <div className="name">Para que serve o roteiro</div>
        <div className="sub" style={{ lineHeight: 1.5 }}>
          É o planejamento interno do Mestre, feito pelo agente Roteirista a partir do seu personagem e do ponto
          de partida da campanha. Ele divide a história em <b>arcos</b> e, em cenários baseados numa obra, ancora
          cada arco nos <b>eventos canônicos</b> daquele momento da linha do tempo (⚓), além de plantar ganchos
          ligados ao seu passado e aos seus objetivos.
          <br /><br />
          Durante o jogo o Mestre consulta o roteiro para saber em que ponto da história está e anota o progresso
          (✎), marcando arcos como ativos ou concluídos. Ele é um guia, não um trilho: suas escolhas podem desviar
          a história, e o Mestre adapta. Regenerar cria um plano novo e descarta as anotações de progresso.
        </div>
      </div>
      {!script && <p className="muted">Esta campanha ainda não tem roteiro. Gere um para o Mestre ter um plano de arcos.</p>}
      {script && !show && (
        <button className="btn ghost small" onClick={() => setShow(true)}>
          👁 Mostrar o roteiro (contém spoilers do que o Mestre planejou)
        </button>
      )}
      {script && show && (
        <>
          <button className="btn ghost small" onClick={() => setShow(false)} style={{ marginBottom: 8 }}>Esconder roteiro</button>
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
