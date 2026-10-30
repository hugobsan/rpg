"use client";
import { Fragment, memo, useEffect, useMemo, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import type { Character } from "@/lib/types";
import type { CampaignView } from "@/lib/campaignView";
import { useTurn, type FeedItem } from "./game/useTurn";
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
import DiceRoller from "./DiceRoller";
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

/** Item do chat; memo: o streaming da narração re-renderiza a tela a cada pedaço e o feed não muda. */
const FeedLine = memo(function FeedLine({ item, npcs, campaignId }: { item: FeedItem; npcs: Character[]; campaignId: string }) {
  if (item.kind === "player") return <div className="msg-player">{item.content}</div>;
  if (item.kind !== "gm")
    return <div className={`event-chip ${item.kind}${item.outcome ? ` ${item.outcome}` : ""}`}>{item.content}</div>;
  return (
    <div className="msg-gm">
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
  );
});

const SIDE_KEY = "chronicle.sideWidth";
const SIDE_DEFAULT = 340;
// entre 260px e o que deixa pelo menos 420px para o chat (máx. 760px)
const clampSide = (w: number) =>
  Math.round(Math.min(Math.max(w, 260), Math.min(760, (typeof window !== "undefined" ? window.innerWidth : 1400) - 420)));

export default function GameClient({ campaignId, initial }: { campaignId: string; initial?: CampaignView | null }) {
  const {
    state, setState, reload: reloadState, error, setError,
    feed, draft, choices, busy, status: statusText, send, regenerate,
    pendingDice, rolling, roll, releaseDice,
    feedRef, hasMore, loadingOlder, loadOlder,
  } = useTurn(campaignId, { initial });
  const [input, setInput] = useState("");
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
  const [regenOpen, setRegenOpen] = useState(false);
  const [regenReason, setRegenReason] = useState("");
  const [openNpc, setOpenNpc] = useState<Character | null>(null);
  const [oocOpen, setOocOpen] = useState(false);
  const characters = state?.characters;
  const npcs = useMemo(() => characters?.filter((c) => c.kind === "npc") ?? [], [characters]);
  const sceneImage = state?.lastImage ?? null;

  const sendTurn = (text: string) => {
    if (send(text)) setInput("");
  };
  const regen = (feedback: string) => {
    setRegenOpen(false);
    regenerate(feedback);
  };

  const generateImage = async () => {
    setImageBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/image`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Falha ao gerar imagem");
      setState((s) => s && { ...s, lastImage: { id: Number(data.id), url: data.url } });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImageBusy(false);
    }
  };

  if (error && !state) return <div className="container"><div className="error-box">{error}</div></div>;
  if (!state) return <div className="container"><p className="muted">Carregando campanha...</p></div>;

  const { campaign, scene } = state;
  const player = state.characters.find((c) => c.kind === "player");
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
          {state.ui.imageGeneration && (
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
            {feed.map((item) => <FeedLine key={item.key} item={item} npcs={npcs} campaignId={campaignId} />)}
            {draft && (
              <div className="msg-gm"><span dangerouslySetInnerHTML={{ __html: md(draft) }} /></div>
            )}
            {pendingDice && (
              <button className="btn primary" style={{ alignSelf: "center" }} onClick={roll}>
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
              <img src={sceneImage.url} alt="Cena atual" className="scene-image" onClick={() => setImageFull(true)} />
              <button className="scene-image-close" title="Tirar da ficha (continua na Galeria)" aria-label="Tirar imagem da ficha"
                onClick={async () => {
                  setState((s) => s && { ...s, lastImage: null });
                  await fetch(`/api/campaigns/${campaignId}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ hideSheetImageId: sceneImage.id }),
                  });
                }}>✕</button>
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
          {tab === "gallery" && <Gallery campaignId={campaignId} refreshKey={sceneImage?.id} onDeleted={reloadState} />}
          {tab === "script" && <ScriptView script={campaign.script} campaignId={campaignId} onChange={reloadState} />}
        </div>
      </aside>

      {imageFull && sceneImage && (
        <ImageViewer items={[{ src: sceneImage.url }]} index={0} onIndex={() => {}} onClose={() => setImageFull(false)} />
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
              <button className="btn ghost small" onClick={() => regen("")}>Gerar sem motivo</button>
              <button className="btn primary small" disabled={!regenReason.trim()}
                onClick={() => regen(regenReason)}>Gerar com esse ajuste</button>
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
