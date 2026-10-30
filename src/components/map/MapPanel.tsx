"use client";
/**
 * Mapa do mundo e palco da cena, para uma aba da lateral do jogo.
 *
 * Props: o que a tela de jogo já tem do GET /api/campaigns/[id]
 * - campaign: lê campaign.state.map (WorldMap; campanha antiga já chega com o mapa montado das
 *   cenas) e campaign.state.clock (luz do período do dia no 3D)
 * - scene: lê scene.state.stage (SceneStage) e scene.mode (em batalha o palco vem primeiro)
 * - characters: o jogador (nome do peão) e os NPCs ativos (peões junto do jogador)
 *
 * O diorama 3D (three) carrega sob demanda e só renderiza quando algo se mexe; enquanto carrega,
 * e sem WebGL, fica a visão 2D (SVG). "Ampliar" abre o mapa em tela cheia, com zoom.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import Loader from "@/components/ui/Loader";
import { formatClock, getClock, period } from "@/lib/clock";
import type { Campaign, Character, MapPlace, Scene, SceneStage, WorldMap } from "@/lib/types";
import type { DioramaData, DioramaHandle, DioramaToken } from "./diorama";
import StageView from "./StageView";

const KIND_LABEL: Record<string, string> = {
  cidade: "cidade", vila: "vila", bairro: "bairro", predio: "prédio", casa: "casa", sala: "sala",
  torre: "torre", templo: "templo", floresta: "floresta", campo: "campo", montanha: "montanha",
  agua: "água", caverna: "caverna", ruina: "ruína", estrada: "caminho", base: "base", nave: "nave",
  portal: "portal", regiao: "região", lugar: "lugar",
};
const placed = (p: MapPlace) => Number.isFinite(p.x) && Number.isFinite(p.y);
const first = (s: string) => s.trim().split(/\s+/)[0]?.toLowerCase() ?? "";

function readMap(state: Record<string, unknown>): WorldMap | null {
  const m = state?.map as WorldMap | undefined;
  return m && Array.isArray(m.places) && Array.isArray(m.routes) ? m : null;
}
function readStage(state: Record<string, unknown>): SceneStage | null {
  const s = state?.stage as SceneStage | undefined;
  return s && Array.isArray(s.actors) && Array.isArray(s.zones) ? s : null;
}

export default function MapPanel({ campaign, scene, characters }: { campaign: Campaign; scene: Scene; characters: Character[] }) {
  const map = readMap(campaign.state);
  const stage = readStage(scene.state);
  const player = characters.find((c) => c.kind === "player")?.name ?? "";
  const clock = getClock(campaign.state);
  const per = clock ? period(clock.minutes) : undefined;
  const [selected, setSelected] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  const dio = useRef<DioramaHandle | null>(null);

  // NPCs ativos e quem está no palco (com a postura), menos o jogador
  const data = useMemo<DioramaData | null>(() => {
    if (!map) return null;
    const tokens: DioramaToken[] = characters.filter((c) => c.kind === "npc" && c.active).map((c) => ({ name: c.name }));
    for (const a of stage?.actors ?? []) {
      if (first(a.name) === first(player)) continue;
      const npc = tokens.find((t) => t.name.toLowerCase() === a.name.toLowerCase() || (!a.name.includes(" ") && first(t.name) === first(a.name)));
      if (npc) npc.stance = a.stance;
      else tokens.push({ name: a.name, stance: a.stance });
    }
    return { map, tokens, player, period: per };
  }, [map, stage, characters, player, per]);

  useEffect(() => {
    if (selected && !map?.places.some((p) => p.id === selected)) setSelected(null);
  }, [map, selected]);

  const places = map?.places.filter(placed) ?? [];
  const shown = selected ?? map?.current ?? null;
  const backHome = () => {
    setSelected(null);
    dio.current?.focus();
  };
  const card = map && shown && (
    <PlaceCard map={map} id={shown} characters={characters} player={player} onPick={setSelected} onBack={backHome} />
  );
  const stageBlock =
    stage || scene.mode === "battle" ? (
      <section className="map-section" aria-label="Palco da cena">
        <div className="overline">Palco da cena</div>
        {stage ? (
          <StageView stage={stage} player={player} />
        ) : (
          <p className="muted map-empty">O Mestre ainda não posicionou os combatentes. O palco aparece aqui assim que ele montar a cena.</p>
        )}
      </section>
    ) : null;
  const battleFirst = scene.mode === "battle" && !!stage;

  return (
    <div className="map-panel">
      {battleFirst && stageBlock}
      {data && places.length ? (
        <section className="map-section" aria-label="Mapa do mundo">
          {full ? (
            <div className="map3d">
              <WorldSvg map={data.map} selected={selected} onSelect={setSelected} />
            </div>
          ) : (
            <Diorama data={data} full={false} selected={selected} onSelect={setSelected} handle={dio}>
              <button className="btn small map3d-expand" onClick={() => setFull(true)}>
                Ampliar
              </button>
              <span className="map3d-hint">Arraste para girar · toque num lugar</span>
            </Diorama>
          )}
          {card}
        </section>
      ) : (
        <section className="map-section map-empty">
          <div className="overline">Mapa do mundo</div>
          <p className="muted">O mapa se desenha conforme a história anda: cada lugar por onde você passa aparece aqui, ligado ao anterior.</p>
        </section>
      )}
      {!battleFirst && stageBlock}
      {full &&
        data &&
        createPortal(
          <MapOverlay
            data={data}
            name={campaign.name}
            selected={selected}
            onSelect={setSelected}
            onClose={() => setFull(false)}
            card={card}
            stage={stageBlock}
          />,
          document.body
        )}
    </div>
  );
}

/** Monta o diorama 3D (import dinâmico) num div; mostra a visão 2D até ficar pronto ou se falhar. */
function Diorama({ data, full, selected, onSelect, handle, children }: {
  data: DioramaData;
  full: boolean;
  selected: string | null;
  onSelect: (id: string | null) => void;
  handle?: RefObject<DioramaHandle | null>;
  children?: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const h = useRef<DioramaHandle | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "failed">("loading");
  const latest = useRef({ data, selected, onSelect });
  latest.current = { data, selected, onSelect };

  useEffect(() => {
    let alive = true;
    import("./diorama")
      .then(({ createDiorama }) => {
        if (!alive || !box.current) return;
        h.current = createDiorama(box.current, latest.current.data, { full, onSelect: (id) => latest.current.onSelect(id) });
        if (latest.current.selected) h.current.select(latest.current.selected);
        if (handle) handle.current = h.current;
        setPhase("ready");
      })
      .catch(() => alive && setPhase("failed")); // sem WebGL: fica a visão 2D
    return () => {
      alive = false;
      h.current?.dispose();
      h.current = null;
      if (handle) handle.current = null;
    };
  }, [full, handle]);
  useEffect(() => h.current?.update(data), [data]);
  useEffect(() => h.current?.select(selected), [selected]);

  return (
    <div className={`map3d${full ? " full" : ""}`} data-phase={phase} aria-busy={phase === "loading"}>
      <div ref={box} className="map3d-canvas" />
      {phase !== "ready" && <WorldSvg map={data.map} selected={selected} onSelect={onSelect} />}
      {phase === "loading" && (
        <span className="map3d-loading">
          <Loader size={18} label="Montando o mapa 3D" />
        </span>
      )}
      {phase === "ready" && children}
      {phase === "failed" && <span className="map3d-hint">Visão 2D: este navegador não abriu o 3D</span>}
    </div>
  );
}

/** Visão 2D do mapa: locais e rotas em SVG (carregamento e fallback sem WebGL). */
function WorldSvg({ map, selected, onSelect }: { map: WorldMap; selected: string | null; onSelect: (id: string | null) => void }) {
  const places = map.places.filter(placed);
  if (!places.length) return null;
  const byId = new Map(places.map((p) => [p.id, p]));
  const xs = places.map((p) => p.x!), ys = places.map((p) => -p.y!);
  const pad = 1.4;
  const minX = Math.min(...xs) - pad, minY = Math.min(...ys) - pad;
  const w = Math.max(Math.max(...xs) + pad - minX, 6), h = Math.max(Math.max(...ys) + pad - minY, 4);
  const ext = Math.max(w, h * 1.3); // largura útil, seja o mapa largo ou alto
  const fs = Math.max(0.3, ext / 30); // ~11 px no painel
  return (
    <svg className="map2d" viewBox={`${minX} ${minY} ${w} ${h}`} role="img" aria-label="Mapa do mundo em 2D">
      {map.routes.map((r) => {
        const a = byId.get(r.from), b = byId.get(r.to);
        if (!a || !b) return null;
        const mx = (a.x! + b.x!) / 2 - (b.y! - a.y!) * 0.12, my = -(a.y! + b.y!) / 2 - (b.x! - a.x!) * 0.12;
        return (
          <path
            key={r.from + r.to}
            d={`M${a.x} ${-a.y!} Q${mx} ${my} ${b.x} ${-b.y!}`}
            className={`map2d-route${r.travel || r.label ? " is-known" : ""}`}
            style={{ strokeWidth: fs * 0.12 }}
          />
        );
      })}
      {places.map((p) => {
        const r = (ext / 75) * (p.parent ? 0.7 : 1);
        const here = p.id === map.current;
        return (
          <g
            key={p.id}
            transform={`translate(${p.x} ${-p.y!})`}
            className={`map2d-place${here ? " is-here" : ""}${p.id === selected ? " is-selected" : ""}${p.visits ? "" : " is-faint"}`}
            role="button"
            tabIndex={0}
            aria-label={p.name}
            onClick={() => onSelect(p.id)}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onSelect(p.id)}
          >
            {here && <circle r={r * 1.45} className="map2d-halo" />}
            <circle r={r} style={{ strokeWidth: fs * 0.1 }} />
            <text y={-r - fs * 0.3} textAnchor="middle" style={{ fontSize: fs * (here ? 1.05 : 0.9) }}>
              {p.name}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** Cartão do local: tipo, onde fica, visitas, descrição, rotas, o que há dentro e quem está lá. */
function PlaceCard({ map, id, characters, player, onPick, onBack }: {
  map: WorldMap;
  id: string;
  characters: Character[];
  player: string;
  onPick: (id: string) => void;
  onBack: () => void;
}) {
  const byId = (x?: string) => map.places.find((p) => p.id === x);
  const p = byId(id);
  if (!p) return null;
  const parent = byId(p.parent);
  const here = p.id === map.current;
  const kids = map.places.filter((k) => k.parent === p.id);
  const routes = map.routes
    .filter((r) => r.from === p.id || r.to === p.id)
    .map((r) => ({ to: byId(r.from === p.id ? r.to : r.from), info: [r.travel, r.label].filter(Boolean).join(", ") }))
    .filter((r): r is { to: MapPlace; info: string } => !!r.to);
  const people = here ? [player || "Você", ...characters.filter((c) => c.kind === "npc" && c.active).map((c) => c.name)] : [];
  const link = (q: MapPlace) => (
    <button key={q.id} className="map-link" onClick={() => onPick(q.id)}>
      {q.name}
    </button>
  );
  const list = (items: ReactNode[]) => items.flatMap((n, i) => (i ? [", ", n] : [n]));

  return (
    <div className="map-place" key={p.id}>
      <div className="map-place-head">
        <h3 className="display">{p.name}</h3>
        {here ? <span className="pill on">Você está aqui</span> : map.current && <button className="btn ghost small" onClick={onBack}>Voltar ao local atual</button>}
      </div>
      <p className="map-place-meta muted">
        {KIND_LABEL[p.kind] ?? p.kind}
        {parent && <> · em {link(parent)}</>}
        {" · "}
        {p.visits ? `${p.visits} visita${p.visits > 1 ? "s" : ""}` : "conhecido, não visitado"}
        {p.discoveredAt !== undefined && ` · descoberto no ${formatClock(p.discoveredAt)}`}
      </p>
      {p.description && <p className="map-place-desc">{p.description}</p>}
      {routes.length > 0 && (
        <p className="map-place-row">
          <span className="faint">Caminhos: </span>
          {list(routes.map((r) => <span key={r.to.id}>{link(r.to)}{r.info && <span className="muted"> ({r.info})</span>}</span>))}
        </p>
      )}
      {kids.length > 0 && (
        <p className="map-place-row">
          <span className="faint">Dentro: </span>
          {list(kids.map(link))}
        </p>
      )}
      {people.length > 0 && (
        <p className="map-place-row">
          <span className="faint">Aqui agora: </span>
          {people.join(", ")}
        </p>
      )}
    </div>
  );
}

/** Mapa em tela cheia (portal no body): 3D grande com zoom, cartão do local e palco ao lado. */
function MapOverlay({ data, name, selected, onSelect, onClose, card, stage }: {
  data: DioramaData;
  name: string;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onClose: () => void;
  card: ReactNode;
  stage: ReactNode;
}) {
  const handle = useRef<DioramaHandle | null>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", k);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);
  const n = data.map.places.length;
  return (
    <div className="map-overlay" role="dialog" aria-modal="true" aria-label="Mapa do mundo">
      <header className="map-overlay-head">
        <div>
          <h2 className="display">Mapa do mundo</h2>
          <span className="muted">
            {name} · {n} {n === 1 ? "lugar" : "lugares"}
          </span>
        </div>
        <button className="btn ghost small" onClick={() => handle.current?.focus()}>
          Ver tudo
        </button>
        <button className="btn small" onClick={onClose} autoFocus>
          Fechar
        </button>
      </header>
      <div className="map-overlay-body">
        <Diorama data={data} full selected={selected} onSelect={onSelect} handle={handle}>
          <span className="map3d-hint">Arraste para girar · botão direito move · roda aproxima</span>
        </Diorama>
        <aside className="map-overlay-side">
          {card}
          {stage}
        </aside>
      </div>
    </div>
  );
}
