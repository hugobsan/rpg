"use client";
/**
 * Mapa 3D de um local (Cartógrafo), na aba Mapa. Mostra o lugar `placeId` (o atual por padrão):
 * o 3D (three, sob demanda, só renderiza quando algo muda; 2D em SVG enquanto carrega e sem
 * WebGL), os pontos de interesse clicáveis, os peões (o jogador sempre, os NPCs em cena com ele e o palco nas zonas que batem com um ponto),
 * os botões Gerar / Editar / Regerar / Remover, o "gerando" e a galeria dos outros lugares com mapa.
 * Gerar e editar viram tarefa em segundo plano (POST /maps); ao terminar, a tela relê a campanha.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import Loader from "@/components/ui/Loader";
import { toast } from "@/components/ui/Toast";
import type { Period } from "@/lib/clock";
import { expandSpec, type LocalMapInfo, type MapSpec } from "@/lib/mapSpec";
import type { Job, SceneStage, WorldMap } from "@/lib/types";
import type { LocalMapData, LocalMapHandle, LocalToken } from "./localMap";
import s from "./LocalMap.module.css";

const norm = (t: string) => t.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const first = (t: string) => norm(t).split(" ")[0] ?? "";
const THEME_VAR: Record<string, string> = {
  accent: "var(--accent)", accent2: "var(--accent-2)", danger: "var(--danger)", ok: "var(--ok)", info: "var(--info)", warn: "var(--warn)",
};
const fill = (c: string) => THEME_VAR[c] ?? c;

// spec por id + versão: voltar a um mapa já visto não busca de novo
const specCache = new Map<string, MapSpec>();

function useSpec(campaignId: string, info: LocalMapInfo | undefined) {
  const key = info ? `${info.id}:${info.updatedAt}` : "";
  const [got, setGot] = useState<{ key: string; spec: MapSpec } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!key) return;
    const hit = specCache.get(key);
    if (hit) return setGot({ key, spec: hit });
    let alive = true;
    setFailed(false);
    fetch(`/api/campaigns/${campaignId}/maps?map=${info!.id}`)
      .then((r) => (r.ok ? (r.json() as Promise<MapSpec>) : Promise.reject()))
      .then((spec) => {
        specCache.set(key, spec);
        if (alive) setGot({ key, spec });
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [campaignId, key]); // eslint-disable-line react-hooks/exhaustive-deps
  // depois de editar, o mapa antigo fica na tela até o novo chegar (mesmo id); de outro lugar, não
  const spec = info && got && got.key.split(":")[0] === String(info.id) ? got.spec : null;
  return { spec, failed: failed && !spec };
}

const NEAR = ["corpo_a_corpo", "perto", "medio", "longe"];

export default function LocalMap({ campaignId, world, maps, jobs, stage, player, npcs = [], period, placeId, onPlace, onChanged }: {
  campaignId: string;
  world: WorldMap;
  maps: LocalMapInfo[];
  jobs: Job[];
  stage: SceneStage | null;
  player: string;
  npcs?: string[]; // NPCs em cena (ativos)
  period?: Period;
  placeId: string;
  onPlace: (id: string | null) => void; // abre o mapa de outro lugar (null = o atual)
  onChanged: () => void; // relê a campanha (tarefa nova, mapa removido)
}) {
  const place = world.places.find((p) => p.id === placeId);
  const info = maps.find((m) => m.placeId === placeId);
  const busy = jobs.some((j) => j.kind === "map" && j.target === placeId && j.status === "running");
  const { spec, failed } = useSpec(campaignId, info);
  const here = placeId === world.current;
  const [selected, setSelected] = useState<number | null>(null);
  const [mode, setMode] = useState<"edit" | "remove" | null>(null);
  const [brief, setBrief] = useState("");
  const [sending, setSending] = useState(false);
  const [full, setFull] = useState(false);
  const handle = useRef<LocalMapHandle | null>(null);

  useEffect(() => {
    setSelected(null);
    setMode(null);
    setBrief("");
  }, [placeId]);
  useEffect(() => {
    if (selected !== null && !spec?.pois[selected]) setSelected(null);
  }, [spec, selected]);

  // peões no mapa do lugar atual: quem está no palco vai para a zona com nome de ponto do mapa;
  // o jogador sempre aparece (na zona dele, senão junto de quem está mais perto, senão no ponto mais central)
  // e os NPCs em cena que o palco não posiciona ficam com ele
  const npcKey = npcs.join("|");
  const tokens = useMemo<LocalToken[]>(() => {
    if (!spec || !here || !spec.pois.length) return [];
    const poiOf = (zone?: string) => {
      if (!zone) return -1;
      const z = norm(zone);
      const i = spec.pois.findIndex((p) => norm(p.name) === z);
      return i >= 0 ? i : spec.pois.findIndex((p) => norm(p.name).includes(z) || z.includes(norm(p.name)));
    };
    const actors = stage?.actors ?? [];
    const out: LocalToken[] = actors
      .map((a) => ({
        name: a.name,
        poi: poiOf(a.zone),
        kind: (player && first(a.name) === first(player) ? "player" : a.stance) as LocalToken["kind"],
      }))
      .filter((t) => t.poi >= 0);
    let you = out.find((t) => t.kind === "player")?.poi;
    if (you === undefined) {
      const closest = actors.filter((a) => poiOf(a.zone) >= 0).sort((a, b) => NEAR.indexOf(a.distance) - NEAR.indexOf(b.distance))[0];
      const dist = (i: number) => Math.hypot(spec.pois[i].at[0], spec.pois[i].at[2]);
      you = closest ? poiOf(closest.zone) : spec.pois.reduce((best, _, i) => (dist(i) < dist(best) ? i : best), 0);
      if (player) out.push({ name: player, poi: you, kind: "player" });
    }
    for (const n of npcKey ? npcKey.split("|") : [])
      if (!actors.some((a) => first(a.name) === first(n))) out.push({ name: n, poi: you, kind: "neutro" });
    return out;
  }, [spec, here, stage, player, npcKey]);
  const data = useMemo<LocalMapData | null>(() => (spec ? { spec, tokens, period } : null), [spec, tokens, period]);

  const send = async (action: "generate" | "edit" | "remove", text = "") => {
    setSending(true);
    const res = await fetch(`/api/campaigns/${campaignId}/maps`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, placeId, brief: text }),
    }).catch(() => null);
    const d = res ? await res.json().catch(() => ({})) : {};
    setSending(false);
    if (!res?.ok) return toast(d.error || "Não foi possível falar com o servidor. Tente de novo.", { kind: "alerta", title: "Mapa 3D" });
    setMode(null);
    setBrief("");
    if (action === "remove") toast(d.message, { kind: "sucesso" });
    onChanged();
  };

  if (!place) return null;
  const others = maps.filter((m) => m.placeId !== placeId);
  const poi = selected !== null ? spec?.pois[selected] : undefined;
  const people = selected !== null ? tokens.filter((t) => t.poi === selected).map((t) => t.name) : [];
  const select = (i: number | null) => setSelected(i);

  const busyLayer = busy && (
    <div className={s.busy} role="status">
      <div className={s.grid} aria-hidden="true" />
      <div className={s.busyText}>
        <Loader size={30} label="Cartógrafo desenhando" />
        <strong>O Cartógrafo está desenhando {place.name}</strong>
        <span>Leva de 1 a 3 minutos. Pode seguir jogando: você é avisado quando ficar pronto.</span>
      </div>
    </div>
  );
  const poiCard = poi && (
    <div className="map-place" key={selected}>
      <div className="map-place-head">
        <h3 className="display">{poi.name}</h3>
        <button className="btn ghost small" onClick={() => setSelected(null)}>
          Ver tudo
        </button>
      </div>
      {poi.note && <p className="map-place-desc">{poi.note}</p>}
      {people.length > 0 && (
        <p className="map-place-row">
          <span className="faint">Aqui agora: </span>
          {people.join(", ")}
        </p>
      )}
    </div>
  );
  const chips = spec && spec.pois.length > 0 && (
    <div className={s.chips} role="group" aria-label="Pontos de interesse">
      {spec.pois.map((p, i) => (
        <button key={i} className={s.chip} aria-pressed={selected === i} onClick={() => select(selected === i ? null : i)}>
          {p.name}
        </button>
      ))}
    </div>
  );

  return (
    <section className="map-section" aria-label={`Mapa 3D: ${place.name}`}>
      <div className={s.head}>
        <h3 className="display">{place.name}</h3>
        {here ? (
          <span className="pill on">Você está aqui</span>
        ) : (
          world.current && (
            <button className="btn ghost small" onClick={() => onPlace(null)}>
              Voltar ao local atual
            </button>
          )
        )}
      </div>

      {info || busy ? (
        <div className={`map3d ${s.box}`} aria-busy={busy || (!!info && !spec)}>
          {data && !full ? (
            <LocalCanvas data={data} full={false} selected={selected} onSelect={select} handle={handle}>
              <button className="btn small map3d-expand" onClick={() => setFull(true)}>
                Ampliar
              </button>
              <span className="map3d-hint">Arraste para girar · toque num ponto</span>
            </LocalCanvas>
          ) : data ? (
            <LocalSvg spec={data.spec} selected={selected} onSelect={select} />
          ) : (
            !busy &&
            (failed ? (
              <span className="map3d-hint">Não foi possível carregar o mapa. Reabra a aba para tentar de novo.</span>
            ) : (
              <span className="map3d-loading">
                <Loader size={18} label="Carregando o mapa" />
              </span>
            ))
          )}
          {busyLayer}
        </div>
      ) : (
        <div className={s.empty}>
          <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
            <path d="M3 7.5 9 4.5l6 3 6-3v12l-6 3-6-3-6 3v-12Z" strokeLinejoin="round" />
            <path d="M9 4.5v12M15 7.5v12" />
          </svg>
          <p>
            <b>{place.name}</b> ainda não tem mapa 3D. O Cartógrafo desenha a maquete do lugar com o que a história contou dele.
          </p>
          <div className={s.form}>
            <label htmlFor="map-brief">O que destacar (opcional)</label>
            <textarea id="map-brief" value={brief} maxLength={600} onChange={(e) => setBrief(e.target.value)} placeholder="ex.: a ponte sobre o rio, o portão norte, a feira" />
            <div className={s.tools}>
              <button className="btn primary small" disabled={sending} onClick={() => send("generate", brief)}>
                {sending && <Loader size={14} label="Enviando" />} Gerar mapa 3D
              </button>
            </div>
          </div>
        </div>
      )}

      {info && !busy && !mode && (
        <div className={s.tools}>
          <button className="btn small" onClick={() => setMode("edit")}>
            Editar
          </button>
          <button className="btn ghost small" disabled={sending} onClick={() => send("generate")}>
            {sending && <Loader size={14} label="Enviando" />} Regerar
          </button>
          <button className="btn ghost small" onClick={() => setMode("remove")}>
            Remover
          </button>
        </div>
      )}
      {info && !busy && mode === "edit" && (
        <div className={s.form}>
          <label htmlFor="map-edit">O que mudou no lugar?</label>
          <textarea id="map-edit" autoFocus value={brief} maxLength={600} onChange={(e) => setBrief(e.target.value)} placeholder="ex.: a ponte foi destruída; há barracas de festival na praça" />
          <div className={s.tools}>
            <button className="btn ghost small" onClick={() => setMode(null)}>
              Cancelar
            </button>
            <button className="btn primary small" disabled={sending || !brief.trim()} onClick={() => send("edit", brief)}>
              {sending && <Loader size={14} label="Enviando" />} Aplicar
            </button>
          </div>
        </div>
      )}
      {info && !busy && mode === "remove" && (
        <div className={`${s.form} ${s.confirm}`} role="alertdialog" aria-label="Remover mapa 3D">
          <p>Remover o mapa 3D de {place.name}? O Cartógrafo pode desenhar outro depois.</p>
          <div className={s.tools}>
            <button className="btn ghost small" autoFocus onClick={() => setMode(null)}>
              Cancelar
            </button>
            <button className="btn danger small" disabled={sending} onClick={() => send("remove")}>
              {sending && <Loader size={14} label="Removendo" />} Remover
            </button>
          </div>
        </div>
      )}

      {poiCard}
      {chips}

      {others.length > 0 && (
        <div className="map-section">
          <div className="overline">Mapas de outros lugares</div>
          <div className={s.gallery}>
            {others.map((m) => {
              const p = world.places.find((x) => x.id === m.placeId);
              return (
                <button key={m.id} className={s.card} onClick={() => onPlace(m.placeId)} aria-current={m.placeId === world.current}>
                  <b>{m.name}</b>
                  <span>
                    {m.placeId === world.current ? "onde você está" : p?.visits ? `${p.visits} visita${p.visits > 1 ? "s" : ""}` : "não visitado"}
                    {m.pois.length ? ` · ${m.pois.length} pontos` : ""}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {full &&
        data &&
        createPortal(
          <LocalOverlay data={data} name={place.name} selected={selected} onSelect={select} onClose={() => setFull(false)}>
            {poiCard}
            {chips}
          </LocalOverlay>,
          document.body
        )}
    </section>
  );
}

/** Monta o 3D (import dinâmico) num div; mostra o 2D até ficar pronto ou se falhar. */
function LocalCanvas({ data, full, selected, onSelect, handle, children }: {
  data: LocalMapData;
  full: boolean;
  selected: number | null;
  onSelect: (i: number | null) => void;
  handle?: RefObject<LocalMapHandle | null>;
  children?: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const h = useRef<LocalMapHandle | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "failed">("loading");
  const latest = useRef({ data, selected, onSelect });
  latest.current = { data, selected, onSelect };

  useEffect(() => {
    let alive = true;
    import("./localMap")
      .then(({ createLocalMap }) => {
        if (!alive || !box.current) return;
        h.current = createLocalMap(box.current, latest.current.data, { full, onSelect: (i) => latest.current.onSelect(i) });
        if (latest.current.selected !== null) h.current.select(latest.current.selected);
        if (handle) handle.current = h.current;
        setPhase("ready");
      })
      .catch(() => alive && setPhase("failed")); // sem WebGL: fica o 2D
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
    <div className={`map3d${full ? " full" : ""}`} style={full ? undefined : { height: "100%", border: 0, borderRadius: 0 }} data-phase={phase}>
      <div ref={box} className="map3d-canvas" />
      {phase !== "ready" && <LocalSvg spec={data.spec} selected={selected} onSelect={onSelect} />}
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

/** Planta 2D (de cima) do spec: carregamento e fallback sem WebGL. */
function LocalSvg({ spec, selected, onSelect }: { spec: MapSpec; selected: number | null; onSelect: (i: number | null) => void }) {
  // mais baixos primeiro: o telhado fica por cima do chão
  const prims = useMemo(() => expandSpec(spec).sort((a, b) => a.at[1] + a.size[1] - (b.at[1] + b.size[1])), [spec]);
  const h = spec.size / 2, fs = spec.size / 30;
  return (
    <svg className="map2d" viewBox={`${-h} ${-h} ${spec.size} ${spec.size}`} role="img" aria-label={`Planta de ${spec.title}`}>
      <rect x={-h} y={-h} width={spec.size} height={spec.size} fill={fill(spec.ground.color)} />
      {spec.areas.map((a, i) =>
        a.round ? (
          <ellipse key={i} cx={a.at[0]} cy={a.at[1]} rx={a.size[0] / 2} ry={a.size[1] / 2} fill={fill(a.color)} />
        ) : (
          <rect key={i} x={a.at[0] - a.size[0] / 2} y={a.at[1] - a.size[1] / 2} width={a.size[0]} height={a.size[1]} fill={fill(a.color)} />
        )
      )}
      {spec.paths.map((p, i) => (
        <polyline key={i} points={p.points.map((q) => q.join(",")).join(" ")} fill="none" stroke={fill(p.color)} strokeWidth={p.width} strokeLinecap="round" strokeLinejoin="round" />
      ))}
      {prims.map((p, i) => {
        const t = `translate(${p.at[0]} ${p.at[2]}) rotate(${-p.rot[1]})`;
        const c = fill(p.color);
        if (p.shape === "extrude")
          return <polygon key={i} transform={`${t} scale(${p.size[0]} ${p.size[2]})`} points={p.points!.map((q) => q.join(",")).join(" ")} fill={c} opacity={p.opacity} />;
        if (p.shape === "box" || p.shape === "pyramid" || p.shape === "torus")
          return <rect key={i} transform={t} x={-p.size[0] / 2} y={-p.size[2] / 2} width={p.size[0]} height={p.size[2]} fill={c} opacity={p.opacity} />;
        return <ellipse key={i} transform={t} rx={p.size[0] / 2} ry={p.size[2] / 2} fill={c} opacity={p.opacity} />;
      })}
      {spec.pois.map((p, i) => (
        <g
          key={i}
          transform={`translate(${p.at[0]} ${p.at[2]})`}
          className={`map2d-place${i === selected ? " is-here" : ""}`}
          role="button"
          tabIndex={0}
          aria-label={p.name}
          onClick={() => onSelect(i === selected ? null : i)}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onSelect(i === selected ? null : i)}
        >
          <circle r={fs * 0.45} style={{ strokeWidth: fs * 0.12 }} />
          <text y={-fs * 0.7} textAnchor="middle" style={{ fontSize: fs, strokeWidth: fs * 0.12 }}>
            {p.name}
          </text>
        </g>
      ))}
    </svg>
  );
}

/** Mapa local em tela cheia (portal no body): 3D grande com zoom, ponto escolhido e lista ao lado. */
function LocalOverlay({ data, name, selected, onSelect, onClose, children }: {
  data: LocalMapData;
  name: string;
  selected: number | null;
  onSelect: (i: number | null) => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const handle = useRef<LocalMapHandle | null>(null);
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
  const n = data.spec.pois.length;
  return (
    <div className="map-overlay" role="dialog" aria-modal="true" aria-label={`Mapa 3D: ${name}`}>
      <header className="map-overlay-head">
        <div>
          <h2 className="display">{name}</h2>
          <span className="muted">
            Mapa 3D · {n} {n === 1 ? "ponto" : "pontos"}
          </span>
        </div>
        <button className="btn ghost small" onClick={() => (onSelect(null), handle.current?.focus())}>
          Ver tudo
        </button>
        <button className="btn small" onClick={onClose} autoFocus>
          Fechar
        </button>
      </header>
      <div className="map-overlay-body">
        <LocalCanvas data={data} full selected={selected} onSelect={onSelect} handle={handle}>
          <span className="map3d-hint">Arraste para girar · botão direito move · roda aproxima</span>
        </LocalCanvas>
        <aside className="map-overlay-side">{children}</aside>
      </div>
    </div>
  );
}
