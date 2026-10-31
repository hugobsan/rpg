"use client";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Image from "next/image";
import type { Character, TurnEvent } from "@/lib/types";
import type { CampaignView } from "@/lib/campaignView";
import { getClock } from "@/lib/clock";
import { campaignTheme } from "@/lib/theme";
import { effectiveCost } from "@/lib/progression";
import { DIFFICULTIES, getTable } from "@/lib/table";
import { useTurn } from "./game/useTurn";
import { useJobs } from "./game/useJobs";
import NpcModal from "./NpcModal";
import OocModal from "./OocModal";
import ImageViewer from "./ImageViewer";
import Gallery from "./Gallery";
import InventoryView from "./InventoryView";
import AbilitiesView from "./AbilitiesView";
import LibraryView from "./LibraryView";
import ObjectivesView from "./ObjectivesView";
import SheetView from "./SheetView";
import NpcList from "./NpcList";
import MemoriesView from "./MemoriesView";
import BooksView from "./BooksView";
import ScriptView from "./ScriptView";
import DiceRoller from "./DiceRoller";
import MapPanel from "./map/MapPanel";
import TableRulesPanel from "./TableRulesPanel";
import Skeleton from "./ui/Skeleton";
import { toast } from "./ui/Toast";
import SceneHeader from "./game/SceneHeader";
import Composer, { type ComposerHandle, type QuickGroup } from "./game/Composer";
import SidePanel, { type PanelTab } from "./game/SidePanel";
import Icon from "./game/Icon";
import { Choices, Draft, FeedLine, Recap, TurnWait, type Cast } from "./game/Feed";
import { groupFeed, phaseOf, type Phase } from "./game/feedModel";
import { stateToasts } from "./game/stateToasts";
import s from "./GameClient.module.css";

type Tab = "sheet" | "abilities" | "inventory" | "library" | "objectives" | "npcs" | "map" | "memories" | "books" | "script" | "gallery" | "table";

const MODE_PLACEHOLDER: Record<string, string> = {
  exploration: "O que você faz?",
  dialogue: "O que você diz ou faz?",
  battle: "Sua ação no combate...",
  training: "Como você treina?",
  downtime: "O que você faz neste tempo livre?",
};
const START =
  "(Mestre: abra a aventura. Apresente a cena inicial no ponto de partida combinado, situe meu personagem no mundo e, se descrevi NPCs iniciais na configuração da campanha, crie-os agora com create_npc.)";

// celular: a lateral vira barra fixa + folha (mesmo breakpoint do DESIGN.md)
const MOBILE_Q = "(max-width: 899px)";
const onMobileChange = (cb: () => void) => {
  const m = matchMedia(MOBILE_Q);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
};
const COLLAPSE_KEY = "chronicle.sideCollapsed";
const recapKey = (id: string) => `chronicle.recap.${id}`;

export default function GameClient({ campaignId, initial }: { campaignId: string; initial?: CampaignView | null }) {
  const [phases, setPhases] = useState<Phase[]>([]);
  const [ghost, setGhost] = useState(""); // rascunho descartado (narration_reset): fica esmaecido até o novo chegar
  const [openNpc, setOpenNpc] = useState<Character | null>(null);
  const draftRef = useRef("");
  const stateRef = useRef<CampaignView | null>(null);

  const onEvent = (ev: TurnEvent) => {
    const p = phaseOf(ev);
    if (p) setPhases((ps) => (ps[ps.length - 1] === p ? ps : [...ps.filter((x) => x !== p), p]));
    if (ev.type === "narration_reset") setGhost(draftRef.current);
    else if (ev.type === "narration_delta" || ev.type === "narration" || ev.type === "done" || ev.type === "error") setGhost("");
    if (ev.type === "npc_message")
      toast(ev.preview ? `“${ev.preview}”` : "Abra a conversa para ler.", {
        title: `${ev.name} quer falar com você`,
        action: {
          label: "Abrir conversa",
          onClick: () => {
            const npc = stateRef.current?.characters.find((c) => c.id === ev.npcId);
            if (npc) setOpenNpc(npc);
          },
        },
      });
  };

  const {
    state, setState, reload: reloadState, error, setError,
    feed, draft, choices, busy, status, send, regenerate,
    pendingDice, rolling, roll, releaseDice,
    feedRef, hasMore, loadingOlder, loadOlder,
  } = useTurn(campaignId, { initial, onEvent });
  draftRef.current = draft;
  stateRef.current = state;

  // retratos, mapas 3D, biblioteca, perfis de NPC: ao terminar, relê a campanha e avisa
  const jobs = useJobs(campaignId, state?.jobs, (ended) => {
    reloadState();
    for (const j of ended)
      if (j.status === "error") toast(j.error || "Tente de novo.", { kind: "alerta", title: `Falhou: ${j.label}` });
      else toast(j.label, { kind: "sucesso", title: "Pronto" });
  });

  // O HTML já traz o feed: até hidratar, a coluna invertida mostra o fim (sem pular do topo para o fim)
  const [hydrated, setHydrated] = useState(false);
  useLayoutEffect(() => setHydrated(true), []);
  useLayoutEffect(() => {
    const el = feedRef.current;
    if (hydrated && el) el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
  }, [hydrated, feedRef]);

  // avisos pela diferença de estado (dano, XP, itens, NPCs, missões, tempo)
  const prevState = useRef(state);
  useEffect(() => {
    const prev = prevState.current;
    prevState.current = state;
    if (prev && state && prev !== state) for (const t of stateToasts(prev, state)) toast(t.text, { kind: t.kind, title: t.title });
  }, [state]);

  const [tab, setTab] = useState<Tab>("sheet");
  const mobile = useSyncExternalStore(onMobileChange, () => matchMedia(MOBILE_Q).matches, () => false);
  const [drawer, setDrawer] = useState(false);
  const [collapsed, setCollapsedState] = useState(false);
  useEffect(() => {
    try { setCollapsedState(localStorage.getItem(COLLAPSE_KEY) === "1"); } catch {}
  }, []);
  const setCollapsed = (v: boolean) => {
    setCollapsedState(v);
    try { localStorage.setItem(COLLAPSE_KEY, v ? "1" : "0"); } catch {}
  };
  useEffect(() => { if (!mobile) setDrawer(false); }, [mobile]);

  // "Anteriormente...": uma vez por aba do navegador, ao abrir campanha com narração
  const [recap, setRecap] = useState(false);
  useEffect(() => {
    if (!initial?.messages.some((m) => m.role === "gm")) return;
    try { if (sessionStorage.getItem(recapKey(campaignId))) return; } catch {}
    setRecap(true);
  }, [initial, campaignId]);
  const closeRecap = () => {
    setRecap(false);
    try { sessionStorage.setItem(recapKey(campaignId), "1"); } catch {}
  };

  const composer = useRef<ComposerHandle>(null);
  const [imageFull, setImageFull] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
  const [regenOpen, setRegenOpen] = useState(false);
  const [regenReason, setRegenReason] = useState("");
  const [oocOpen, setOocOpen] = useState(false);

  const characters = state?.characters;
  const npcs = useMemo(() => characters?.filter((c) => c.kind === "npc") ?? [], [characters]);
  const player = characters?.find((c) => c.kind === "player");

  // tirar/trazer NPCs da cena, otimista: a lista muda na hora; o que o servidor recusar volta, com aviso
  const setNpcActive = async (list: Character[], on: boolean) => {
    const mark = (ids: Set<string>, value: (c: Character) => boolean) =>
      setState((st) => st && { ...st, characters: st.characters.map((c) => (ids.has(c.id) ? { ...c, active: value(c) } : c)) });
    const before = new Map(list.map((n) => [n.id, n.active]));
    mark(new Set(before.keys()), () => on);
    const res = await Promise.all(
      list.map((n) =>
        fetch(`/api/campaigns/${campaignId}/npcs/${n.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ active: on }),
        }).catch(() => null)
      )
    );
    const failed = new Set(list.filter((_, i) => !res[i]?.ok).map((n) => n.id));
    if (failed.size) {
      mark(failed, (c) => before.get(c.id) ?? c.active);
      toast("Não deu para mudar quem está em cena.", { kind: "alerta" });
    } else if (list.length > 1) toast(`${list.length} NPCs saíram de cena.`);
    else toast(on ? `${list[0].name} entrou na cena.` : `${list[0].name} saiu de cena.`);
    reloadState();
  };
  // estável entre os pedaços do streaming: os itens do feed (memo) não re-renderizam
  const cast = useMemo<Cast>(
    () => ({ npcs: new Map(npcs.map((n) => [n.name.toLowerCase(), n])), player: player?.name, campaignId, onNpc: setOpenNpc }),
    [npcs, player?.name, campaignId]
  );
  const groups = useMemo(() => groupFeed(feed), [feed]);
  // ações rápidas do composer: técnicas (com o custo efetivo) e itens da ficha
  const ruleset = state?.campaign.ruleset;
  const quick = useMemo<QuickGroup[]>(() => {
    if (!player || !ruleset) return [];
    const res = (k: string) => ruleset.resources.find((r) => r.key === k)?.label ?? k;
    return [
      {
        label: ruleset.abilitiesLabel || "Habilidades",
        items: player.sheet.abilities.map((a) => {
          const c = effectiveCost(ruleset, a);
          return { name: a.name, note: c?.amount ? `${c.amount} ${res(c.resource)}` : undefined, title: a.effect || a.description };
        }),
      },
      { label: "Itens", items: player.sheet.inventory.map((i) => ({ name: i.name, note: i.qty > 1 ? `×${i.qty}` : undefined, title: i.description })) },
    ].filter((g) => g.items.length);
  }, [player, ruleset]);
  const sceneImage = state?.lastImage ?? null;

  const turnStarted = () => {
    setPhases([]);
    setGhost("");
    if (recap) closeRecap();
  };
  const sendTurn = (text: string) => {
    const ok = send(text);
    if (ok) turnStarted();
    return ok;
  };
  const regen = (feedback: string) => {
    setRegenOpen(false);
    if (regenerate(feedback)) turnStarted();
  };

  const generateImage = async () => {
    setImageBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/image`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Falha ao gerar imagem");
      setState((st) => st && { ...st, lastImage: { id: Number(data.id), url: data.url } });
      setImageFull(true);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), { kind: "alerta", title: "Imagem do ambiente" });
    } finally {
      setImageBusy(false);
    }
  };

  if (error && !state) return <div className="container"><div className="error-box">{error}</div></div>;
  if (!state)
    return (
      <div className={s.layout} aria-busy="true">
        <div className={s.main}>
          <div className={s.loadingHead}><Skeleton w={110} h={12} /><Skeleton w="40%" h={20} /></div>
          <div className={s.feed}><div className={s.inner}><Skeleton lines={4} /><Skeleton lines={3} /><Skeleton lines={5} /></div></div>
        </div>
      </div>
    );

  const { campaign, scene } = state;
  const clock = getClock(campaign.state)?.minutes ?? null;
  const unread = state.inbox?.reduce((n, i) => n + i.unread, 0) ?? 0;
  const difficulty = getTable(campaign.state).difficulty;
  const lastGm = feed.findLast((i) => i.kind === "gm")?.content;
  const placeholder =
    choices.length && campaign.style !== "open"
      ? "Escolha uma opção acima ou escreva a sua ação..."
      : MODE_PLACEHOLDER[scene.mode] ?? "O que você faz?";

  const tabs: PanelTab<Tab>[] = [
    { key: "sheet", label: "Ficha", icon: "sheet", mobile: true },
    { key: "abilities", label: campaign.ruleset.abilitiesLabel || "Habilidades", icon: "spark" },
    { key: "inventory", label: "Inventário", icon: "bag" },
    { key: "library", label: "Biblioteca", icon: "library" },
    { key: "objectives", label: "Missões", icon: "flag", mobile: true },
    { key: "npcs", label: "NPCs", icon: "people", badge: unread, mobile: true },
    { key: "map", label: "Mapa", icon: "map", mobile: true },
    { key: "memories", label: "Marcos", icon: "bookmark" },
    { key: "books", label: "Livros", icon: "book" },
    { key: "script", label: "Roteiro", icon: "scroll" },
    { key: "gallery", label: "Galeria", icon: "image" },
    { key: "table", label: "Mesa", icon: "sliders", end: true },
  ];
  // header e atalhos abrem uma aba: no desktop expande o painel, no celular sobe a folha
  const show = (k: Tab) => {
    setTab(k);
    setCollapsed(false);
    if (mobile) setDrawer(true);
  };

  const panel = (() => {
    switch (tab) {
      case "sheet":
        return (
          <>
            {sceneImage && (
              <div className={s.sceneImage}>
                <button className={s.sceneImageOpen} onClick={() => setImageFull(true)} aria-label="Ver a imagem do ambiente em tela cheia">
                  {/* miniatura redimensionada pelo Next; a tela cheia usa o original */}
                  <Image src={sceneImage.url} alt={`Ambiente: ${scene.location || scene.title}`} width={768} height={480} sizes="(max-width: 900px) 92vw, 360px" />
                </button>
                <button className="scene-image-close" title="Tirar da ficha (continua na Galeria)" aria-label="Tirar imagem da ficha"
                  onClick={async () => {
                    setState((st) => st && { ...st, lastImage: null });
                    await fetch(`/api/campaigns/${campaignId}`, {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ hideSheetImageId: sceneImage.id }),
                    });
                  }}><Icon name="close" size={14} /></button>
              </div>
            )}
            {player && <SheetView char={player} campaign={campaign} onChange={reloadState} />}
          </>
        );
      case "abilities":
        return player && <AbilitiesView char={player} ruleset={campaign.ruleset} />;
      case "inventory":
        return player && <InventoryView char={player} campaignId={campaignId} disabled={busy} onChange={reloadState} />;
      case "library":
        return <LibraryView campaignId={campaignId} ruleset={campaign.ruleset} jobs={jobs} onChange={reloadState} />;
      case "objectives":
        return <ObjectivesView state={campaign.state} />;
      case "npcs":
        return <NpcList npcs={npcs} onOpen={setOpenNpc} inbox={state.inbox} onSetActive={setNpcActive} />;
      case "map":
        return <MapPanel campaign={campaign} scene={scene} characters={state.characters} maps={state.maps} jobs={jobs} onChanged={reloadState} />;
      case "memories":
        return <MemoriesView memories={state.memories} />;
      case "books":
        return <BooksView campaignId={campaignId} books={state.books} onChange={reloadState} />;
      case "script":
        return <ScriptView script={campaign.script} campaignId={campaignId} onChange={reloadState} />;
      case "gallery":
        return <Gallery campaignId={campaignId} refreshKey={sceneImage?.id} onDeleted={reloadState} />;
      case "table":
        return <TableRulesPanel campaign={campaign} onChange={reloadState} />;
    }
  })();

  return (
    <div className={`${s.layout} theme-root`} data-theme={campaignTheme(campaign)} data-mode={scene.mode}>
      <main className={s.main}>
        <SceneHeader
          scene={scene}
          clock={clock}
          image={state.ui.imageGeneration ? { busy: imageBusy, onClick: generateImage } : undefined}
          onOoc={() => setOocOpen(true)}
          onMap={() => show("map")}
          onTable={() => show("table")}
          tableHint={difficulty === "normal" ? undefined : DIFFICULTIES.find((d) => d.key === difficulty)?.label}
          jobs={jobs.filter((j) => j.status === "running")}
        />

        <div className={s.feedWrap}>
          {recap && <Recap name={campaign.name} scene={scene} last={lastGm} onClose={closeRecap} />}
          <div className={`${s.feed} ${hydrated ? "" : s.fromEnd}`} ref={feedRef}
            onScroll={(e) => hydrated && e.currentTarget.scrollTop < 200 && loadOlder()}>
            <div className={s.inner}>
              {hasMore ? (
                loadingOlder ? (
                  <div aria-busy="true" className={s.older}><Skeleton lines={3} /></div>
                ) : (
                  <button className={`btn ghost small ${s.center}`} onClick={loadOlder}>Carregar anteriores</button>
                )
              ) : (
                feed.length > 0 && <div className="divider"><span /></div>
              )}

              {feed.length === 0 && !busy && (
                <div className={s.start}>
                  <span className={s.startGlyph} aria-hidden="true" />
                  <h2>A aventura aguarda</h2>
                  <p className="muted">O Mestre abre a primeira cena a partir do seu personagem e do ponto de partida escolhido.</p>
                  <button className="btn primary" onClick={() => sendTurn(START)}>Iniciar aventura</button>
                </div>
              )}

              {groups.map((g) => <FeedLine key={g.key} item={g.item} chips={g.chips} cast={cast} />)}
              {draft ? <Draft text={draft} cast={cast} /> : ghost && busy ? <Draft text={ghost} cast={cast} ghost /> : null}

              {pendingDice && (
                <button className={`btn primary ${s.roll}`} onClick={roll}>
                  <Icon name="d20" size={20} />
                  Rolar dados
                  <span className={s.rollWhat}>{pendingDice.reason ? `${pendingDice.reason} · ` : ""}{pendingDice.notation}</span>
                </button>
              )}
              {busy && !pendingDice && <TurnWait status={status} phases={phases} />}
              {error && <div className="error-box">{error}</div>}

              {!busy && !pendingDice && feed.some((i) => i.kind === "player") && (
                <button className={s.regen} onClick={() => { setRegenReason(""); setRegenOpen(true); }}>
                  <Icon name="regen" size={14} /> Gerar novamente
                </button>
              )}
              {!busy && !pendingDice && choices.length > 0 && (
                <Choices choices={choices} onPick={sendTurn} onEdit={(c) => composer.current?.fill(c)} />
              )}
            </div>
          </div>
        </div>

        <Composer
          ref={composer}
          onSend={sendTurn}
          busy={busy}
          placeholder={placeholder}
          quick={quick}
          onOoc={() => setOocOpen(true)}
        />
      </main>

      <SidePanel tabs={tabs} active={tab} onSelect={show} collapsed={collapsed} onCollapse={setCollapsed}
        mobile={mobile} drawer={drawer} onDrawer={setDrawer}>
        {panel}
      </SidePanel>

      {imageFull && sceneImage && (
        <ImageViewer items={[{ src: sceneImage.url }]} index={0} onIndex={() => {}} onClose={() => setImageFull(false)} />
      )}
      {regenOpen && (
        <div className="modal-backdrop" onClick={() => setRegenOpen(false)} onKeyDown={(e) => e.key === "Escape" && setRegenOpen(false)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="regen-title" style={{ maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><h3 id="regen-title">Gerar a resposta do Mestre novamente</h3></div>
            <div className="modal-body">
              <p className="muted" style={{ marginTop: 0 }}>
                O turno é desfeito (dano, XP, itens, NPCs e memórias voltam ao que eram antes da sua última ação)
                e o Mestre responde de novo à mesma ação.
              </p>
              <label className="field" style={{ marginBottom: 0 }}>
                <span>O que você quer diferente? (opcional)</span>
                <textarea autoFocus value={regenReason} onChange={(e) => setRegenReason(e.target.value)}
                  placeholder="Ex.: o Iruka não falaria assim; menos descrição e mais ação; já anoiteceu..." />
              </label>
            </div>
            <div className="modal-foot">
              <button className="btn ghost small" onClick={() => setRegenOpen(false)}>Cancelar</button>
              <button className="btn small" onClick={() => regen("")}>Gerar sem motivo</button>
              <button className="btn primary small" disabled={!regenReason.trim()} onClick={() => regen(regenReason)}>Gerar com esse ajuste</button>
            </div>
          </div>
        </div>
      )}

      {rolling && <DiceRoller result={rolling} force={state.ui.diceForce} onDone={releaseDice} />}

      {oocOpen && <OocModal campaignId={campaignId} onClose={() => setOocOpen(false)} onChanged={reloadState} />}

      {openNpc && (
        <NpcModal
          campaignId={campaignId}
          npc={state?.characters.find((c) => c.id === openNpc.id) ?? openNpc}
          campaign={campaign}
          profiling={jobs.some((j) => j.kind === "character" && j.target === openNpc.id && j.status === "running")}
          onChanged={reloadState}
          onToggleActive={(n) => {
            setOpenNpc(null);
            setNpcActive([n], !n.active);
          }}
          onClose={() => {
            setOpenNpc(null);
            reloadState();
          }}
        />
      )}
    </div>
  );
}
