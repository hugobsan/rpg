"use client";
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import type {
  Campaign,
  Character,
  DiceResult,
  Scene,
  TurnEvent,
} from "@/lib/types";
import NpcModal, { playLine } from "./NpcModal";
import OocModal from "./OocModal";
import ImageViewer from "./ImageViewer";
import Gallery from "./Gallery";
import InventoryView from "./InventoryView";
import AbilitiesView from "./AbilitiesView";
import ObjectivesView from "./ObjectivesView";
import SheetView from "./SheetView";
import NpcList from "./NpcList";
import MemoriesView from "./MemoriesView";
import BooksView from "./BooksView";
import ScriptView from "./ScriptView";
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
  hasMore: boolean; // há mensagens anteriores às carregadas
  memories: { id: number; kind: string; subject: string | null; content: string; importance: number }[];
  lastImage: { id: number; data_url: string } | null;
}

const toFeed = (messages: StateShape["messages"]): FeedItem[] =>
  messages.map((m) => ({ key: `m${m.id}`, kind: m.role === "player" ? "player" : "gm", content: m.content }));

// o feed guarda mensagens salvas com chave "m<id>"; os eventos ao vivo do turno usam "k<n>"
const savedId = (i: FeedItem) => (i.key[0] === "m" ? Number(i.key.slice(1)) : null);

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
  const [oocOpen, setOocOpen] = useState(false);
  const feedRef = useRef<HTMLDivElement>(null);
  const [hasMore, setHasMore] = useState(false); // há mensagens anteriores ainda não carregadas
  const [loadingOlder, setLoadingOlder] = useState(false);
  const loadingOlderRef = useRef(false); // evita pedido duplicado enquanto um lote carrega
  const anchor = useRef<{ h: number; top: number } | null>(null); // posição do scroll antes de prepender
  const firstScroll = useRef(true);
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
      setHasMore(data.hasMore);
      const last = data.messages[data.messages.length - 1];
      if (last?.meta?.choices?.length) setChoices(last.meta.choices);
    });
  }, [reloadState]);

  // Rola até o fim quando chega mensagem nova; ao prepender anteriores, só compensa a altura
  // acrescentada (scroll instantâneo: o .feed tem scroll-behavior: smooth).
  useLayoutEffect(() => {
    const el = feedRef.current;
    if (!el) return;
    if (anchor.current) {
      el.scrollTo({ top: anchor.current.top + el.scrollHeight - anchor.current.h, behavior: "instant" });
      anchor.current = null;
      return;
    }
    // na primeira carga vai direto ao fim (rolar suave desde o topo dispararia o carregamento das anteriores)
    el.scrollTo({ top: el.scrollHeight, behavior: firstScroll.current ? "instant" : "smooth" });
    if (feed.length) firstScroll.current = false;
  }, [feed, statusText]);

  const loadOlder = async () => {
    const el = feedRef.current;
    const oldest = feed.map(savedId).find((id) => id !== null);
    if (loadingOlderRef.current || !hasMore || !el || !oldest) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/messages?before=${oldest}`);
      if (!res.ok) throw new Error(`Erro ${res.status}`);
      const page = (await res.json()) as { messages: StateShape["messages"]; hasMore: boolean };
      anchor.current = { h: el.scrollHeight, top: el.scrollTop };
      setFeed((f) => [...toFeed(page.messages), ...f]);
      setHasMore(page.hasMore);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  };

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
      // (mantém as anteriores já carregadas, antes da janela recente)
      if (regen && failed && data) {
        const first = data.messages[0]?.id ?? 0;
        setFeed((f) => [...f.filter((i) => (savedId(i) ?? Infinity) < first), ...toFeed(data.messages)]);
      }
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

        <div className="feed" ref={feedRef} onScroll={(e) => e.currentTarget.scrollTop < 200 && loadOlder()}>
          <div className="feed-inner">
            {hasMore ? (
              <button className="btn ghost small" style={{ alignSelf: "center" }} onClick={loadOlder} disabled={loadingOlder}>
                {loadingOlder ? "carregando…" : "Carregar anteriores"}
              </button>
            ) : (
              feed.length > 0 && <div className="muted" style={{ textAlign: "center", fontSize: 12 }}>início da campanha</div>
            )}
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
          <div style={{ maxWidth: 760, margin: "0 auto" }}>
            <button className="ooc-open" onClick={() => setOocOpen(true)}
              title="Converse com o Mestre como jogador, não como personagem: nada disso entra na história">
              💬 Falar com o Mestre (fora do jogo)
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
          {tab === "sheet" && player && <SheetView char={player} campaign={campaign} onChange={reloadState} />}
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

      {oocOpen && <OocModal campaignId={campaignId} onClose={() => setOocOpen(false)} onChanged={reloadState} />}

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
