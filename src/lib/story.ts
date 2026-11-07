import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { db, q } from "./db";
import { getAgent } from "./agents";
import { chat, type ChatMessage } from "./openrouter";
import { clockParts, formatClock, getClock, toMinutes } from "./clock";
import { decide, PC_ACT_MIN } from "./decisions";
import { activeDirectives } from "./retrieval";
import { addEvent } from "./knowledge";
import { executeGmTool, loadObjectives, type ToolContext } from "./tools";
import { fold, matchName, parseLooseJson } from "./contracts";
import type { Campaign, Character, Scene } from "./types";

/**
 * Campanha como estado (F2): arcos, beats (o que o MUNDO faz, com prazo e o que acontece fora de cena), relógios e
 * ganchos no banco. O código avalia gatilhos, enche relógios, marca beat vencido como perdido (o fallback vira notícia
 * pública; a missão do jogador nunca é tocada) e abre o próximo arco. O Roteirista (modelo forte, validado por código,
 * com fallback do cânone ou genérico) escreve a agenda; o Diretor monta o cartão da cena antes do Narrador.
 * Verificação sem IA: npx tsx scripts/story-check.ts
 */

// ---------- tipos ----------

export type BeatStatus = "pending" | "ready" | "active" | "done" | "missed";
export interface Trigger {
  after_beat?: string;
  day_gte?: number;
  clock?: { id: string; gte: number };
  narrative?: string; // pergunta sim/não ao Jev sobre a última narração
}
export interface Reward {
  pay?: number;
  xp?: "pequena" | "media" | "grande";
}
export interface ArcRow {
  id: string;
  campaign_id: string;
  ord: number;
  kind: "main" | "side";
  title: string;
  premise: string;
  stakes: string;
  status: "pending" | "active" | "done";
  canon_ref: string | null; // arquivo de references/<mundo>; "#ep" = beats montados por código, um por episódio
}
export interface BeatRow {
  id: string;
  campaign_id: string;
  arc_id: string;
  ord: number;
  title: string;
  situation: string;
  npcs: string[]; // elenco ("cast" é palavra reservada no Postgres)
  location: string;
  trigger: Trigger;
  due_minute: number | null;
  required: boolean;
  fallback: string;
  foreshadow: string;
  clue: string | null;
  reward: Reward | null;
  status: BeatStatus;
  resolved_at: string | null;
}
export interface ClockRow {
  id: string;
  campaign_id: string;
  arc_id: string | null;
  name: string;
  segments: number;
  filled: number;
  tick: string[]; // 'day' | 'scene'
  on_full_beat: string | null;
}
export interface HookRow {
  id: number;
  campaign_id: string;
  text: string;
  beat_id: string | null;
  status: "open" | "paid" | "dropped";
  last_touched_scene: number;
}
export interface Story {
  arcs: ArcRow[];
  beats: BeatRow[];
  clocks: ClockRow[];
  hooks: HookRow[];
}

/** id curto do beat: o que o Diretor e o Narrador copiam. */
export const sid = (id: string) => id.slice(0, 8);
const cut = (t: string | null | undefined, n: number) => (!t ? "" : t.length > n ? `${t.slice(0, n).trimEnd()}…` : t);
const str = (v: unknown, max = 300) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const words = (s: string, n: number) => s.split(/\s+/).filter(Boolean).slice(0, n).join(" ");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const int = (v: unknown) => (typeof v === "number" || (typeof v === "string" && v.trim()) ? Math.round(Number(v)) : NaN);
const dueOf = (day: number) => toMinutes(day, 23, 59);
const OPEN: BeatStatus[] = ["pending", "ready"];

// ---------- modelo fraco ----------

// ponytail: lista curta por nome; params.strongOnly=false no agente desliga a checagem
const WEAK = [/:free$/, /flash/, /luna/, /nano/, /(^|[-/_.])mini(\b|-)/, /haiku/];
export const isWeakModel = (model: string) => WEAK.some((r) => r.test(model.toLowerCase()));

// ---------- avanço por código (puro) ----------

export const agendaSize = (s: Story) => s.beats.filter((b) => OPEN.includes(b.status)).length;
export const activeArc = (s: Story) => s.arcs.find((a) => a.status === "active") ?? null;
export const activeBeat = (s: Story) => s.beats.find((b) => b.status === "active") ?? null;

/** Gatilho satisfeito: todas as condições presentes valem (sem gatilho = pronto). narrative só com o sim do Jev. */
export function triggerMet(b: BeatRow, s: Story, day: number, narrativeYes: Set<string> = new Set()): boolean {
  const t = b.trigger ?? {};
  if (t.after_beat) {
    const prev = s.beats.find((x) => x.id === t.after_beat);
    if (prev && prev.status !== "done" && prev.status !== "missed") return false;
  }
  if (t.day_gte !== undefined && day < t.day_gte) return false;
  if (t.clock) {
    const c = s.clocks.find((x) => x.id === t.clock!.id);
    if (c && c.filled < t.clock.gte) return false;
  }
  if (t.narrative && !narrativeYes.has(b.id)) return false;
  return true;
}

/** Beats do arco ativo que só esperam o sim do Jev (as outras condições já valem), até 3. */
export function narrativeCandidates(s: Story, day: number): BeatRow[] {
  const arc = activeArc(s);
  return s.beats
    .filter((b) => b.arc_id === arc?.id && b.status === "pending" && b.trigger?.narrative)
    .filter((b) => triggerMet(b, s, day, new Set([b.id])))
    .slice(0, 3);
}

export interface StepResult {
  story: Story;
  missed: BeatRow[]; // obrigatórios vencidos: o fallback vira notícia pública
  readied: BeatRow[];
  closed: BeatRow[]; // ativo fechado porque o mundo seguiu (beat seguinte disparou ou ficou parado demais)
  filled: ClockRow[]; // relógios que encheram agora
}

/**
 * Um passo da história, sem banco: enche relógios (dias e cenas que passaram), marca vencidos como perdidos (o ativo
 * nunca: o jogador está nele), deixa prontos os que o gatilho liberou, fecha o ativo quando um beat seguinte do mesmo
 * arco dispara e troca de arco quando o ativo acaba. Nada aqui mexe em missão.
 */
export function stepStory(input: Story, o: { now: number | null; days: number; scenes: number; narrativeYes?: Set<string> }): StepResult {
  const s: Story = structuredClone(input);
  const out: StepResult = { story: s, missed: [], readied: [], closed: [], filled: [] };
  const forced = new Set<string>();
  for (const c of s.clocks) {
    const add = (c.tick.includes("day") ? o.days : 0) + (c.tick.includes("scene") ? o.scenes : 0);
    if (add <= 0 || c.filled >= c.segments) continue;
    c.filled = Math.min(c.segments, c.filled + add);
    if (c.filled >= c.segments) {
      out.filled.push(c);
      if (c.on_full_beat) forced.add(c.on_full_beat);
    }
  }
  const now = o.now;
  const day = now === null ? 1 : clockParts(now).day;
  const at = new Date().toISOString();
  if (now !== null)
    for (const b of s.beats) {
      if (OPEN.includes(b.status) && b.due_minute !== null && b.due_minute < now && !forced.has(b.id)) {
        b.status = "missed";
        b.resolved_at = at;
        if (b.required) out.missed.push(b);
      }
      // ponytail: ativo parado 2 dias depois do prazo fecha (o mundo seguiu); a missão dele continua aberta
      else if (b.status === "active" && b.due_minute !== null && b.due_minute < now - 2 * 1440) {
        b.status = "done";
        b.resolved_at = at;
        out.closed.push(b);
      }
    }
  for (let pass = 0; pass < 2; pass++) {
    const arc = activeArc(s);
    for (const b of s.beats) {
      if (b.status !== "pending" || b.arc_id !== arc?.id) continue;
      if (forced.has(b.id) || triggerMet(b, s, day, o.narrativeYes)) {
        b.status = "ready";
        out.readied.push(b);
      }
    }
    // o gatilho do beat seguinte (o próximo por ord no mesmo arco) disparou: o ativo acabou
    const act = activeBeat(s);
    const next = act && s.beats.filter((b) => b.arc_id === act.arc_id && b.ord > act.ord).sort((a, b) => a.ord - b.ord)[0];
    if (act && next && out.readied.includes(next)) {
      act.status = "done";
      act.resolved_at = at;
      out.closed.push(act);
    }
    // arco sem nada aberto: acaba, e o próximo (menor ord) abre
    if (arc && !s.beats.some((b) => b.arc_id === arc.id && (OPEN.includes(b.status) || b.status === "active"))) {
      arc.status = "done";
      const next = s.arcs.filter((a) => a.status === "pending").sort((a, b) => a.ord - b.ord)[0];
      if (next) next.status = "active";
      else break;
    } else break;
  }
  return out;
}

/** Elegíveis para o Diretor: o ativo, senão os prontos (obrigatório e prazo mais perto primeiro), até 3. */
export function eligibleBeats(s: Story): BeatRow[] {
  const act = activeBeat(s);
  if (act) return [act];
  return s.beats
    .filter((b) => b.status === "ready")
    .sort((a, b) => Number(b.required) - Number(a.required) || (a.due_minute ?? Infinity) - (b.due_minute ?? Infinity) || a.ord - b.ord)
    .slice(0, 3);
}

/** Próximos pendentes do arco ativo (só para plantar foreshadow). */
export function upcomingBeats(s: Story, n = 2): BeatRow[] {
  const arc = activeArc(s);
  return s.beats.filter((b) => b.arc_id === arc?.id && b.status === "pending").sort((a, b) => a.ord - b.ord).slice(0, n);
}

/** Ganchos abertos sem toque há mais de 5 cenas, até 2. */
export const staleHooks = (s: Story, sceneSeq: number) => s.hooks.filter((h) => h.status === "open" && sceneSeq - h.last_touched_scene > 5).slice(0, 2);

// ---------- Roteirista: plano e validação (puro) ----------

export interface PlanBeat {
  title: string;
  situation: string;
  cast: string[];
  location: string;
  after?: number; // índice de um beat anterior do plano
  day?: number;
  clock?: { index: number; gte: number };
  narrative?: string;
  dueDay: number;
  required: boolean;
  fallback: string;
  foreshadow: string;
  clue: string | null;
  reward: Reward | null;
}
export interface Plan {
  arc: { title: string; premise: string; stakes: string };
  beats: PlanBeat[];
  clocks: { name: string; segments: number; tick: string[]; onFullBeat?: number }[];
  hooks: { text: string; beat?: number }[];
  npcs: { name: string; agenda: string; wants: string }[];
  canonRef?: string | null;
  appendTo?: string; // id do arco "#ep" que recebe os beats (fallback do cânone continuando o mesmo arco)
  ordFrom?: number;
}

/** "Hugo é forçado a / precisa / deve / usa...": beat que exige ato do personagem do jogador. */
export function demandsPcAct(situation: string, player: string): boolean {
  const first = fold(player).split(" ")[0];
  const who = [first, "o jogador", "o personagem do jogador", "o protagonista"].filter(Boolean).join("|");
  return new RegExp(`\\b(${who}) (e forcad[oa]|precisa|deve|usa|tem que|decide|escolhe|aceita|vai ter que)\\b`).test(fold(situation));
}

/**
 * Valida a saída do Roteirista campo a campo. errors = o que voltaria na nova tentativa. Beat sem título ou que exige
 * ato do jogador sai; obrigatório sem dueDay ou fallback vira opcional (erro); beat sem prazo ganha o do anterior + 2;
 * sem gatilho, vem depois do anterior. plan null = menos de 4 beats.
 */
export function validatePlan(raw: unknown, ctx: { player: string; day: number }): { plan: Plan | null; errors: string[] } {
  const r = obj(raw);
  const errors: string[] = [];
  const a = obj(r.arc);
  const arc = { title: str(a.title, 80), premise: str(a.premise, 400), stakes: str(a.stakes, 200) };
  if (!arc.title) errors.push("arc.title vazio");
  const clocksRaw = arr(r.clocks).slice(0, 3).map(obj);
  const clockIdx = (name: unknown) => clocksRaw.findIndex((c) => fold(str(c.name, 60)) === fold(str(name, 60)) && str(name, 60));
  const kept: { b: PlanBeat; src: number }[] = [];
  const rawBeats = arr(r.beats).slice(0, 12);
  rawBeats.forEach((x, i) => {
    const o = obj(x);
    const title = str(o.title, 80);
    const situation = str(o.situation, 400);
    if (!title || !situation) return void errors.push(`beat ${i}: sem title ou situation`);
    if (demandsPcAct(situation, ctx.player)) return void errors.push(`beat ${i} ("${title}"): a situation exige ato de ${ctx.player}; escreva o que o MUNDO faz`);
    const t = obj(o.trigger);
    const b: PlanBeat = {
      title,
      situation,
      cast: arr(o.cast).map((c) => str(c, 60)).filter(Boolean).slice(0, 6),
      location: str(o.location, 80),
      dueDay: NaN,
      required: o.required === true,
      fallback: str(o.fallback, 300),
      foreshadow: str(o.foreshadow, 200),
      clue: str(o.clue, 200) || null,
      reward: null,
    };
    const after = int(t.afterBeat ?? t.after_beat);
    if (Number.isFinite(after) && after >= 0 && after < i) b.after = after;
    const d = int(t.day ?? t.day_gte);
    if (Number.isFinite(d) && d >= 1) b.day = d;
    const ck = obj(t.clock);
    const ci = clockIdx(ck.name);
    if (ci >= 0) b.clock = { index: ci, gte: Math.max(1, int(ck.gte) || 1) };
    const nar = str(t.narrative, 200);
    if (nar) b.narrative = nar;
    const due = int(o.dueDay);
    if (Number.isFinite(due)) {
      if (due >= ctx.day) b.dueDay = due;
      else errors.push(`beat ${i}: dueDay ${due} antes de hoje (Dia ${ctx.day})`);
    }
    if (b.required && (!Number.isFinite(b.dueDay) || !b.fallback)) {
      errors.push(`beat ${i} ("${title}"): required precisa de dueDay e fallback`);
      b.required = false;
    }
    const rw = obj(o.reward);
    const pay = int(rw.pay);
    const xp = ["pequena", "media", "grande"].includes(str(rw.xp, 10)) ? (str(rw.xp, 10) as Reward["xp"]) : undefined;
    if (pay > 0 || xp) b.reward = { ...(pay > 0 && { pay }), xp: xp ?? "pequena" };
    kept.push({ b, src: i });
  });
  // índices do plano bruto → do plano validado (beat descartado some do afterBeat)
  const map = new Map(kept.map((k, j) => [k.src, j]));
  let lastDue = ctx.day;
  kept.forEach(({ b }, j) => {
    b.after = b.after !== undefined ? map.get(b.after) : undefined;
    if (b.after === undefined && b.day === undefined && !b.clock && !b.narrative && j > 0) b.after = j - 1;
    if (!Number.isFinite(b.dueDay)) b.dueDay = lastDue + 2;
    lastDue = Math.max(lastDue, b.dueDay);
    if (b.after !== undefined && b.after >= j) b.after = undefined;
  });
  const beats = kept.map((k) => k.b);
  if (beats.length < 4) errors.push(`só ${beats.length} beats válidos (mínimo 4)`);
  const clocks = clocksRaw.map((c) => {
    const tick = arr(c.tick).map((t) => str(t, 8)).filter((t) => t === "day" || t === "scene");
    const full = map.get(int(c.onFullBeat));
    return { name: str(c.name, 60) || "Relógio", segments: Math.min(12, Math.max(2, int(c.segments) || 6)), tick: tick.length ? tick : ["day"], ...(full !== undefined && { onFullBeat: full }) };
  });
  const hooks = arr(r.hooks)
    .slice(0, 6)
    .map((h) => (typeof h === "string" ? { text: h } : obj(h)))
    .map((h) => ({ text: str(h.text, 200), ...(map.get(int(h.beat)) !== undefined && { beat: map.get(int(h.beat)) }) }))
    .filter((h) => h.text);
  const npcs = arr(r.npcs)
    .slice(0, 8)
    .map(obj)
    .map((n) => ({ name: str(n.name, 60), agenda: str(n.agenda, 200), wants: str(n.wants, 200) }))
    .filter((n) => n.name && (n.agenda || n.wants));
  return { plan: arc.title && beats.length >= 4 ? { arc, beats, clocks, hooks, npcs } : null, errors };
}

// ---------- cânone (references/<mundo>/NN-*.md) e arco genérico ----------

const REF_DIR = path.join(process.cwd(), "references");

/** Pasta de referência do mundo: references/<x> cujo nome aparece no nome do cenário (ex.: naruto). */
export function canonDir(campaign: Pick<Campaign, "ruleset">): string | null {
  if (!campaign.ruleset.canonBased) return null;
  const key = fold(`${campaign.ruleset.name} ${campaign.ruleset.world ?? ""}`);
  const dirs = fs.existsSync(REF_DIR) ? fs.readdirSync(REF_DIR).filter((d) => fs.statSync(path.join(REF_DIR, d)).isDirectory()) : [];
  const d = dirs.find((x) => key.includes(fold(x)));
  return d ? path.join(REF_DIR, d) : null;
}
export const canonFiles = (dir: string) => fs.readdirSync(dir).filter((f) => /^\d+-.*\.md$/.test(f)).sort();

export interface Episode {
  n: number;
  title: string;
  synopsis: string; // 1-2 frases
}
/** Título do arco (linha "# ...") e episódios da seção "Sinopse dos episódios". */
export function parseCanon(text: string): { title: string; episodes: Episode[] } {
  const title = text.match(/^# (.+)$/m)?.[1].trim() ?? "";
  const sec = text.split(/^## Sinopse dos episódios.*$/m)[1]?.split(/^## /m)[0] ?? "";
  const episodes: Episode[] = [];
  for (const part of sec.split(/^### Epis[óo]dio /m).slice(1)) {
    const head = part.match(/^(\d+):\s*(.+)$/m);
    if (!head) continue;
    const para = part.split(/\n\s*\n/).map((p) => p.trim()).find((p, i) => i > 0 && p && !p.startsWith("("));
    const sentences = (para ?? "").match(/[^.!?]+[.!?]+/g) ?? [para ?? ""];
    episodes.push({ n: Number(head[1]), title: head[2].trim(), synopsis: cut(sentences.slice(0, 2).join(" ").trim(), 320) });
  }
  return { title, episodes };
}

/**
 * Arquivo de cânone pelo ponto de partida: palavras dele que aparecem no nome e no título de UM arquivo só ("konoha",
 * que está em vários, não decide); sem acerto, o 1º.
 */
export function pickCanonFile(files: string[], titles: string[], startingPoint: string): string {
  const want = new Set(fold(startingPoint).split(" ").filter((w) => w.length >= 4));
  const keys = files.map((f, i) => new Set(fold(`${f.replace(/\.md$/, "").replace(/-/g, " ")} ${titles[i]}`).split(" ")));
  const df = (w: string) => keys.filter((k) => k.has(w)).length;
  let best = 0;
  let pick = files[0];
  keys.forEach((k, i) => {
    const score = [...want].filter((w) => k.has(w) && df(w) === 1).length;
    if (score > best) (best = score), (pick = files[i]);
  });
  return pick;
}

/**
 * Fallback do Roteirista com cânone: cada episódio (a partir de `from`, até 12) vira um beat em cadeia, um dia de
 * prazo a cada episódio; os marcos (cada 3º e o último) são obrigatórios. Fallback = o cânone acontece fora de cena.
 */
export function canonPlan(file: string, text: string, o: { day: number; from?: number }): Plan | null {
  const { title, episodes } = parseCanon(text);
  const from = o.from ?? 0;
  const eps = episodes.slice(from, from + 12);
  if (!eps.length) return null;
  const last = episodes.length - 1;
  const beats: PlanBeat[] = eps.map((e, i) => ({
    title: e.title,
    situation: `No cânone, com ou sem o jogador: ${e.synopsis}`,
    cast: [],
    location: "",
    ...(i > 0 && { after: i - 1 }),
    dueDay: o.day + 1 + i,
    // ponytail: marco = cada 3º episódio e o último do arco; trocar por marcos da seção "Resumo do arco" se pesar
    required: (from + i) % 3 === 2 || from + i === last,
    fallback: `Acontece fora de cena, como no cânone: ${cut(e.synopsis, 200)}`,
    foreshadow: "",
    clue: null,
    reward: null,
  }));
  const name = title.replace(/^.*? - /, "") || file;
  return {
    arc: { title: name, premise: `Linha do tempo canônica: ${name}.`, stakes: `Os acontecimentos de "${name}" seguem com ou sem você.` },
    beats,
    clocks: [],
    hooks: [],
    npcs: [],
    canonRef: `${file}#ep`,
    ordFrom: from,
  };
}

/** Fallback sem cânone: arco mínimo montado da premissa (rumor, pedido, ameaça, consequência, virada). */
export function genericPlan(premise: string, place: string, day: number): Plan {
  const where = place || "a região";
  const p = cut(premise, 200) || "o lugar onde a história começa";
  const b = (title: string, situation: string, d: number, extra: Partial<PlanBeat> = {}): PlanBeat => ({
    title, situation, cast: [], location: where, dueDay: day + d, required: false, fallback: "", foreshadow: "", clue: null, reward: null, ...extra,
  });
  return {
    arc: { title: "Algo se move", premise: `Em ${where}, algo começa a mudar: ${p}`, stakes: "Se ninguém agir, a ameaça cresce e alguém próximo paga o preço." },
    beats: [
      b("Um rumor", `Pessoas em ${where} comentam um acontecimento estranho: algo sumiu e ninguém sabe quem levou.`, 1, { foreshadow: "Uma conversa interrompida quando alguém se aproxima." }),
      b("Um pedido de ajuda", "Alguém aflito procura quem possa investigar o sumiço e oferece pagamento.", 2, {
        after: 0, required: true, fallback: "Outra pessoa aceita o pedido; dias depois, ela não volta.", reward: { xp: "pequena" },
      }),
      b("A ameaça se mostra", "Quem está por trás do sumiço age de novo, mais perto e às claras, e deixa um rastro.", 4, {
        after: 1, required: true, fallback: "A ameaça ataca fora de cena: alguém se fere e o medo se espalha.", clue: "Um objeto deixado para trás aponta para quem fez.",
      }),
      b("A consequência", "O que foi levado reaparece usado contra os moradores; os mais fracos começam a partir.", 6, { after: 2 }),
      b("A virada", "A ameaça tenta o golpe maior que preparava desde o começo.", 8, {
        after: 3, required: true, fallback: "O golpe acontece sem resistência e muda a região: há perdas que ficam.",
      }),
    ],
    clocks: [{ name: "A ameaça cresce", segments: 6, tick: ["day"], onFullBeat: 4 }],
    hooks: [],
    npcs: [],
  };
}

// ---------- Diretor: cartão (puro) ----------

export interface Card {
  beatId: string; // id completo do beat ("" = sem beat)
  objective: string;
  conflict: string;
  npcIntents: { name: string; intent: string }[];
  clue: string | null;
  foreshadow: string | null;
  exits: string[];
  tone: string;
  secrets: string[];
  hooks: string[]; // ganchos parados (código)
  turn: number; // scenes.state.turns quando foi montado
  source: "director" | "fallback";
}

const DEFAULT_EXITS = ["Seguir o que está acontecendo", "Procurar quem saiba mais", "Ir para outro lugar"];

/** Cartão montado do beat de maior prioridade (fallback do Diretor). */
export function fallbackCard(s: Story, present: string[], sceneSeq: number, turn: number): Card {
  const b = eligibleBeats(s)[0];
  const next = upcomingBeats(s, 1)[0];
  const arc = activeArc(s);
  return {
    beatId: b?.id ?? "",
    objective: b ? words(b.title, 20) : words(arc ? `O mundo segue: ${arc.stakes}` : "Deixar o mundo reagir ao que o jogador fez", 20),
    conflict: b ? words(b.situation.replace(/^No cânone, com ou sem o jogador: /, ""), 30) : "",
    npcIntents: b ? b.npcs.filter((n) => matchName(present, n)).map((name) => ({ name, intent: words(b.title, 15) })) : [],
    clue: b?.clue ?? null,
    foreshadow: next?.foreshadow || null,
    exits: DEFAULT_EXITS,
    tone: "",
    secrets: [],
    hooks: staleHooks(s, sceneSeq).map((h) => h.text),
    turn,
    source: "fallback",
  };
}

/** Valida o cartão do Diretor: beatId da lista fechada, nomes de NPCs em cena ou do elenco, limites de palavras. */
export function validateCard(raw: unknown, ctx: { beats: BeatRow[]; names: string[] }): { card: Omit<Card, "hooks" | "turn" | "source"> | null; errors: string[] } {
  const r = obj(raw);
  const errors: string[] = [];
  const said = str(r.beatId, 40).replace(/"/g, "");
  const beat = said ? ctx.beats.find((b) => b.id === said || sid(b.id) === said.slice(0, 8)) : undefined;
  if (said && !beat) errors.push(`beatId fora da lista: ${said}`);
  if (!said && ctx.beats.length) errors.push("beatId vazio com beats na lista");
  const objective = words(str(r.objective, 300), 20);
  if (!objective) errors.push("objective vazio");
  const intents = arr(r.npcIntents)
    .map(obj)
    .map((n) => ({ name: matchName(ctx.names, str(n.name, 60)) ?? "", intent: words(str(n.intent, 200), 15) }))
    .filter((n) => n.name && n.intent);
  const exits = arr(r.exits).map((e) => words(str(e, 120), 10)).filter(Boolean).slice(0, 3);
  if (exits.length < 2) errors.push("exits precisa de 2 a 3 saídas");
  const card = {
    beatId: beat?.id ?? (ctx.beats[0]?.id || ""),
    objective,
    conflict: words(str(r.conflict, 400), 30),
    npcIntents: intents,
    clue: str(r.clue, 200) || null,
    foreshadow: str(r.foreshadow, 200) || null,
    exits: exits.length >= 2 ? exits : DEFAULT_EXITS,
    tone: words(str(r.tone, 40), 3),
    secrets: arr(r.secrets).map((x) => words(str(x, 200), 25)).filter(Boolean).slice(0, 3),
  };
  return { card: objective ? card : null, errors };
}

/** O cartão no contexto do Narrador (substitui o antigo bloco do roteiro). */
export function cardBlock(card: Card | null, beat: BeatRow | null, news: string[]): string {
  if (!card && !news.length) return "";
  const lines = ["\n--- CARTÃO DA CENA (só para você; conduza por ele sem citar) ---"];
  if (card) {
    lines.push(`Objetivo da cena: ${card.objective}`);
    if (card.conflict) lines.push(`Conflito (vem do mundo, não de regra): ${card.conflict}`);
    if (card.npcIntents.length) lines.push(`O que cada um quer agora:\n${card.npcIntents.map((n) => `- ${n.name}: ${n.intent}`).join("\n")}`);
    if (card.clue) lines.push(`Pista para entregar nesta cena (num detalhe, numa fala ou num objeto; sem explicar): ${card.clue}`);
    if (card.foreshadow) lines.push(`Plante de passagem, sem destaque: ${card.foreshadow}`);
    if (card.hooks.length) lines.push(`Ganchos esquecidos (traga um de volta se couber): ${card.hooks.join(" | ")}`);
    if (card.tone) lines.push(`Tom: ${card.tone}`);
    if (card.secrets.length) lines.push(`Segredos (NUNCA diga nem insinue): ${card.secrets.join(" | ")}`);
    lines.push(`Saídas possíveis: ${card.exits.join(" | ")}`);
  }
  if (beat)
    lines.push(
      `Beat em jogo: id "${sid(beat.id)}" — ${beat.title}. Quando ele andar, mande no bloco "beat":{"op":"advance","id":"${sid(beat.id)}"}; quando acontecer de vez, "op":"done".`
    );
  if (news.length) lines.push(`Aconteceu fora de cena (o mundo comenta, um NPC traz a notícia ou o jogador vê o resultado): ${news.join(" | ")}`);
  return lines.join("\n");
}

// ---------- banco ----------

export async function loadStory(campaignId: string): Promise<Story> {
  const [arcs, beats, clocks, hooks] = await Promise.all([
    q<ArcRow>(`SELECT * FROM arcs WHERE campaign_id = $1 ORDER BY ord`, [campaignId]),
    q<BeatRow>(`SELECT * FROM beats WHERE campaign_id = $1 ORDER BY ord`, [campaignId]),
    q<ClockRow>(`SELECT * FROM clocks WHERE campaign_id = $1 ORDER BY name`, [campaignId]),
    q<HookRow>(`SELECT * FROM hooks WHERE campaign_id = $1 ORDER BY id`, [campaignId]),
  ]);
  return { arcs, beats, clocks, hooks };
}

/** Grava o que o passo mudou (status de arcos e beats, relógios). */
async function saveDiff(before: Story, after: Story): Promise<void> {
  for (const a of after.arcs) if (before.arcs.find((x) => x.id === a.id)?.status !== a.status) await q(`UPDATE arcs SET status = $1 WHERE id = $2`, [a.status, a.id]);
  for (const b of after.beats) {
    const old = before.beats.find((x) => x.id === b.id);
    if (old?.status !== b.status) await q(`UPDATE beats SET status = $1, resolved_at = $2 WHERE id = $3`, [b.status, b.resolved_at, b.id]);
  }
  for (const c of after.clocks) if (before.clocks.find((x) => x.id === c.id)?.filled !== c.filled) await q(`UPDATE clocks SET filled = $1 WHERE id = $2`, [c.filled, c.id]);
  // gancho de beat fechado: pago; arco acabado: os abertos dele caem
  const closed = new Set(after.beats.filter((b) => b.status === "done" || b.status === "missed").map((b) => b.id));
  for (const h of after.hooks)
    if (h.status === "open" && h.beat_id && closed.has(h.beat_id)) {
      h.status = after.beats.find((b) => b.id === h.beat_id)?.status === "done" ? "paid" : "dropped";
      await q(`UPDATE hooks SET status = $1 WHERE id = $2`, [h.status, h.id]);
    }
}

export interface Play {
  mode: "exploration" | "mission" | "conversation";
  beatId?: string;
  objectiveId?: string;
  title?: string;
}
export const getPlay = (state: Record<string, unknown>): Play => (obj(state.play).mode ? (state.play as Play) : { mode: "exploration" });

async function patchState(ctx: ToolContext, patch: Record<string, unknown>) {
  await q(`UPDATE campaigns SET state = state || $1::jsonb WHERE id = $2`, [JSON.stringify(patch), ctx.campaign.id]);
  ctx.campaign.state = { ...ctx.campaign.state, ...patch };
}

/** Fecha o beat (done): missão dele concluída por código (paga e dá XP), modo volta a exploração. */
async function finishBeat(ctx: ToolContext, beatId: string, completeMission: boolean) {
  if (!beatId) return;
  await q(`UPDATE beats SET status = 'done', resolved_at = now() WHERE id = $1 AND status IN ('ready','active')`, [beatId]);
  await markCardStale(ctx.scene); // o cartão era deste beat: o próximo turno pede outro
  const play = getPlay(ctx.campaign.state);
  if (play.beatId !== beatId) return;
  if (completeMission && play.objectiveId) {
    const o = (await loadObjectives(ctx.campaign.id)).find((x) => x.id === play.objectiveId);
    if (o?.status === "aberto") await executeGmTool("update_objective", { objective: o.id, status: "concluido" }, ctx);
  }
  await patchState(ctx, { play: { mode: "exploration" } });
}

/** Beat ativou: se tem recompensa, vira missão aberta do jogador (sem prazo: o relógio nunca a perde). */
async function activateBeat(ctx: ToolContext, b: BeatRow) {
  await q(`UPDATE beats SET status = 'active' WHERE id = $1 AND status = 'ready'`, [b.id]);
  if (!b.reward) return;
  await executeGmTool(
    "add_objective",
    { title: b.title, kind: "missao", description: cut(b.situation.replace(/^No cânone, com ou sem o jogador: /, ""), 300), status: "aberto", xpSize: b.reward.xp ?? "pequena", ...(b.reward.pay && { pay: b.reward.pay, payUnit: ctx.campaign.ruleset.currency?.units.at(-1)?.key }) },
    ctx
  );
  const o = (await loadObjectives(ctx.campaign.id)).find((x) => x.status === "aberto" && fold(x.title) === fold(b.title));
  if (o) await patchState(ctx, { play: { mode: "mission", beatId: b.id, objectiveId: o.id, title: b.title } });
}

/**
 * Avança a história por código: relógios pelos dias e cenas desde a última vez (marcas em campaigns.state), vencidos,
 * prontos, arco seguinte. Obrigatório vencido = notícia pública (evento público e state.news para o próximo Narrador).
 * clearNews: depois da narração (as notícias já foram contadas). Devolve o passo (para o Diretor saber se rodar).
 */
export async function advanceStory(ctx: ToolContext, o: { narrativeYes?: Set<string>; clearNews?: boolean } = {}): Promise<StepResult> {
  const before = await loadStory(ctx.campaign.id);
  const now = getClock(ctx.campaign.state)?.minutes ?? null;
  const mark = ctx.campaign.state.storyMark as { minutes?: number; scene?: number } | undefined;
  const days = now !== null && mark?.minutes !== undefined ? clockParts(now).day - clockParts(mark.minutes).day : 0;
  const scenes = mark?.scene !== undefined ? Math.max(0, ctx.scene.seq - mark.scene) : 0;
  const step = stepStory(before, { now, days: Math.max(0, days), scenes, narrativeYes: o.narrativeYes });
  await saveDiff(before, step.story);
  // beat perdido: notícia pública (todos sabem, inclusive quem entrar depois)
  for (const b of step.missed) await addEvent(ctx.campaign.id, b.fallback, { public: true, minute: now }).catch((e) => console.warn("[história]", e));
  const play = getPlay(ctx.campaign.state);
  const closedPlay = play.beatId && step.closed.some((b) => b.id === play.beatId);
  const old = o.clearNews ? [] : (ctx.campaign.state.news as string[] | undefined) ?? [];
  await patchState(ctx, {
    storyMark: { minutes: now ?? undefined, scene: ctx.scene.seq },
    news: [...old, ...step.missed.map((b) => b.fallback)].slice(-4),
    ...(closedPlay && { play: { mode: "exploration" } }),
  });
  if (step.readied.length || step.closed.length) await markCardStale(ctx.scene);
  return step;
}

async function markCardStale(scene: Scene) {
  scene.state = { ...scene.state, cardStale: true };
  await q(`UPDATE scenes SET state = state || '{"cardStale": true}'::jsonb WHERE id = $1`, [scene.id]);
}

/**
 * Depois dos efeitos do turno: o "beat" do Narrador (done fecha e conclui a missão; advance pede cartão novo), missão
 * do beat que fechou por outro caminho, passo da história e agenda (< 4 beats abertos: Roteirista em segundo plano).
 */
export async function afterTurn(ctx: ToolContext, beat: { op: "advance" | "done"; id: string } | null): Promise<void> {
  if (beat?.op === "done") await finishBeat(ctx, beat.id, true);
  else if (beat?.op === "advance") await markCardStale(ctx.scene);
  const play = getPlay(ctx.campaign.state);
  if (play.mode === "mission" && play.objectiveId) {
    const o = (await loadObjectives(ctx.campaign.id)).find((x) => x.id === play.objectiveId);
    if (!o || o.status !== "aberto") await finishBeat(ctx, play.beatId ?? "", false);
  }
  const step = await advanceStory(ctx, { clearNews: true });
  if (agendaSize(step.story) < 4) extendInBackground(ctx.campaign.id);
}

// ponytail: trava por processo; dois servidores podiam estender juntos (a agenda só ficaria maior)
const extending = new Set<string>();
function extendInBackground(campaignId: string) {
  if (extending.has(campaignId)) return;
  extending.add(campaignId);
  writeArc(campaignId, "extend")
    .catch((e) => console.warn("[roteirista: extensão]", e))
    .finally(() => extending.delete(campaignId));
}

/**
 * Antes do Narrador: passo da história com o sim do Jev nos gatilhos narrativos; Diretor (síncrono) quando a cena não
 * tem cartão, um beat ficou pronto, o Narrador avançou o beat ou já foram 8 turnos com o mesmo cartão. Ativa o beat
 * do cartão. Devolve o bloco do contexto do Narrador e o beat em jogo (o bloco de efeitos valida contra ele).
 */
export async function prepareScene(
  ctx: ToolContext,
  chars: Character[],
  narrativeYes: Set<string>,
  emit: (text: string) => void = () => {}
): Promise<{ block: string; beat: BeatRow | null; card: Card | null }> {
  const step = await advanceStory(ctx, { narrativeYes });
  const s = step.story;
  const st = ctx.scene.state ?? {};
  const turns = (Number(st.turns) || 0) + 1;
  let card = (st.card as Card | undefined) ?? null;
  const news = (ctx.campaign.state.news as string[] | undefined) ?? [];
  if (!s.beats.length && !card) {
    await q(`UPDATE scenes SET state = state || $1::jsonb WHERE id = $2`, [JSON.stringify({ turns }), ctx.scene.id]);
    return { block: cardBlock(null, null, news), beat: null, card: null };
  }
  const stale = !card || st.cardStale === true || step.readied.length > 0 || turns - (card?.turn ?? 0) >= 8;
  if (stale) {
    emit("O Diretor está preparando a cena...");
    card = await runDirector(ctx, chars, s, turns);
    const hookIds = staleHooks(s, ctx.scene.seq).map((h) => h.id);
    if (hookIds.length) await q(`UPDATE hooks SET last_touched_scene = $1 WHERE id = ANY($2::bigint[])`, [ctx.scene.seq, hookIds]);
    const chosen = s.beats.find((b) => b.id === card!.beatId);
    if (chosen?.status === "ready") {
      await activateBeat(ctx, chosen);
      chosen.status = "active";
    }
  }
  const next = { ...st, turns, ...(card && { card }), cardStale: false };
  ctx.scene.state = next;
  await q(`UPDATE scenes SET state = $1 WHERE id = $2`, [JSON.stringify(next), ctx.scene.id]);
  const beat = s.beats.find((b) => b.id === card?.beatId && b.status === "active") ?? null;
  return { block: cardBlock(card, beat, news), beat, card };
}

/** Diretor: entrada pequena, saída validada, 1 nova tentativa com o erro, fallback = cartão do beat. */
async function runDirector(ctx: ToolContext, chars: Character[], s: Story, turn: number): Promise<Card> {
  const present = chars.filter((c) => c.kind === "npc" && c.active).map((c) => c.name);
  const fb = fallbackCard(s, present, ctx.scene.seq, turn);
  const beats = eligibleBeats(s);
  const agent = await getAgent("director").catch(() => null);
  if (!agent) return fb;
  const arc = activeArc(s);
  const clock = getClock(ctx.campaign.state);
  const [facts, [last]] = await Promise.all([
    q<{ content: string }>(`SELECT text AS content FROM events WHERE campaign_id = $1 ORDER BY id DESC LIMIT 5`, [ctx.campaign.id]),
    q<{ content: string }>(`SELECT content FROM messages WHERE campaign_id = $1 AND role = 'gm' ORDER BY id DESC LIMIT 1`, [ctx.campaign.id]),
  ]);
  const user = [
    `CENA: ${ctx.scene.location || "?"}${clock ? ` | ${formatClock(clock.minutes)}` : ""}`,
    `NPCs EM CENA: ${present.join(", ") || "(nenhum)"}`,
    arc ? `ARCO: ${arc.title} — ${arc.stakes}` : "",
    `BEATS (copie um id):\n${
      beats.map((b) => `- id "${sid(b.id)}" [${b.status === "active" ? "em andamento" : "pronto"}] ${b.title}: ${cut(b.situation, 300)}${b.npcs.length ? ` | elenco: ${b.npcs.join(", ")}` : ""}${b.clue ? ` | pista: ${b.clue}` : ""}`).join("\n") || '(vazia: beatId "")'
    }`,
    upcomingBeats(s).length ? `PRÓXIMOS (só para plantar):\n${upcomingBeats(s).map((b) => `- ${b.title}${b.foreshadow ? `: ${b.foreshadow}` : ""}`).join("\n")}` : "",
    s.clocks.length ? `RELÓGIOS: ${s.clocks.map((c) => `${c.name} ${c.filled}/${c.segments}`).join("; ")}` : "",
    facts.length ? `ÚLTIMOS FATOS:\n${facts.map((f) => `- ${cut(f.content, 160)}`).join("\n")}` : "",
    last ? `ÚLTIMA NARRAÇÃO:\n${cut(last.content.slice(-800), 800)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const names = [...present, ...beats.flatMap((b) => b.npcs)];
  const messages: ChatMessage[] = [
    { role: "system", content: agent.system_prompt },
    { role: "user", content: user },
  ];
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await chat({
      model: agent.model,
      messages,
      temperature: agent.temperature,
      max_tokens: agent.max_tokens,
      reasoning: agent.params.reasoning as Record<string, unknown> | undefined,
      agentId: "director",
      campaignId: ctx.campaign.id,
      purpose: attempt ? "cartão da cena (nova tentativa)" : "cartão da cena",
    }).catch((e) => (console.warn("[diretor]", e), null));
    if (!r) break;
    const { card, errors } = validateCard(parseLooseJson(r.content), { beats, names });
    if (card && !errors.length) return { ...card, hooks: fb.hooks, turn, source: "director" };
    if (card && attempt) return { ...card, hooks: fb.hooks, turn, source: "director" };
    messages.push({ role: "assistant", content: r.content }, { role: "user", content: `Corrija e responda só o JSON: ${errors.join("; ") || "JSON ilegível"}` });
  }
  return fb;
}

// ---------- Roteirista ----------

/** O que já aconteceu, curto: hora, beats fechados, fatos importantes, onde a história parou, diretrizes. */
async function storySoFar(campaignId: string, s: Story): Promise<string> {
  const [mems, [last], directives] = await Promise.all([
    q<{ content: string }>(`SELECT text AS content FROM events WHERE campaign_id = $1 ORDER BY id DESC LIMIT 25`, [campaignId]),
    q<{ content: string }>(`SELECT content FROM messages WHERE campaign_id = $1 AND role = 'gm' ORDER BY id DESC LIMIT 1`, [campaignId]),
    activeDirectives(campaignId),
  ]);
  const closed = s.beats.filter((b) => b.status === "done" || b.status === "missed").slice(-10);
  return [
    s.arcs.filter((a) => a.status === "done").length ? `Arcos encerrados: ${s.arcs.filter((a) => a.status === "done").map((a) => a.title).join("; ")}` : "",
    closed.length ? `Já aconteceu:\n${closed.map((b) => `- ${b.title}${b.status === "missed" ? " (fora de cena)" : ""}`).join("\n")}` : "",
    s.beats.some((b) => OPEN.includes(b.status) || b.status === "active")
      ? `Ainda na agenda (não repita):\n${s.beats.filter((b) => OPEN.includes(b.status) || b.status === "active").map((b) => `- ${b.title}`).join("\n")}`
      : "",
    mems.length ? `Fatos importantes (recentes primeiro):\n${mems.map((m) => `- ${cut(m.content, 200)}`).join("\n")}` : "",
    last ? `Onde a história parou:\n${cut(last.content.slice(-1200), 1200)}` : "",
    directives.length ? `Diretrizes do jogador:\n${directives.map((d) => `- ${cut(d.content, 200)}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Jev: beats cuja situation só acontece por ato do personagem do jogador (índices). Falhou = nenhum. */
async function pcActByJev(beats: PlanBeat[], player: string, campaignId: string): Promise<number[]> {
  const state: Record<string, unknown> = { personagem_do_jogador: player };
  const questions: Parameters<typeof decide>[0]["questions"] = {};
  beats.forEach((b, i) => {
    state[`beat_${i}`] = b.situation;
    questions[`beat_${i}`] = buildPcActQuestion(`beat_${i}`);
  });
  const a = await decide({ state, questions }, { campaignId, purpose: "roteirista: beat exige ato do jogador?" });
  if (!a) return [];
  return beats.map((_, i) => i).filter((i) => {
    const x = a[`beat_${i}`];
    return x?.type === "noul" && x.noul >= PC_ACT_MIN;
  });
}

/** Pergunta do Jev sobre um beat (a probe do jev-check usa a mesma). */
export function buildPcActQuestion(field: string) {
  return {
    type: "noul" as const,
    instructions: `A situação em \`${field}\` só acontece se o \`personagem_do_jogador\` fizer algo específico (usar um poder, tomar uma decisão, ir a um lugar, aceitar algo)?`,
    criteria: {
      true: "Sim: sem um ato do personagem do jogador a situação não acontece.",
      false: "Não: é o mundo ou um NPC agindo por conta própria; o jogador pode reagir ou não (inclui algo que acontece COM ele, como um selo que reage nele ou alguém que o procura).",
    },
  };
}

export type WriteMode = "new" | "extend" | "redo";

/**
 * Roteirista: só roda com modelo forte (params.strongOnly, padrão sim); saída validada por código + Jev, 1 nova
 * tentativa com os erros; sem plano válido, fallback por código (cânone do mundo, senão arco genérico da premissa).
 * new/redo: arco ativo novo (redo apaga o ativo e os pendentes); extend: próximo arco (ou mais episódios do arco do cânone).
 */
export async function writeArc(campaignId: string, mode: WriteMode): Promise<{ source: "llm" | "canon" | "generic"; title: string }> {
  const [[campaign], chars, writer] = await Promise.all([
    q<Campaign>(`SELECT * FROM campaigns WHERE id = $1`, [campaignId]),
    q<Character>(`SELECT id, kind, name, persona, active FROM characters WHERE campaign_id = $1`, [campaignId]),
    getAgent("scriptwriter"),
  ]);
  if (!campaign) throw new Error("Campanha não encontrada");
  if (mode === "redo") await q(`DELETE FROM arcs WHERE campaign_id = $1 AND status IN ('active','pending')`, [campaignId]);
  const s = await loadStory(campaignId);
  const player = chars.find((c) => c.kind === "player");
  const day = clockParts(getClock(campaign.state)?.minutes ?? 0).day;
  const startingPoint = String(campaign.state.startingPoint || campaign.ruleset.startingPoint || "");

  // cânone: arco "#ep" com episódios sobrando continua; senão o arquivo depois do último arco; no começo, o do ponto de partida
  const dir = canonDir(campaign);
  let canon: { file: string; text: string; from: number; appendTo?: ArcRow } | null = null;
  if (dir) {
    const files = canonFiles(dir);
    const lastArc = [...s.arcs].sort((a, b) => b.ord - a.ord).find((a) => a.canon_ref);
    const lastFile = lastArc?.canon_ref?.replace(/#ep$/, "");
    const read = (f: string) => fs.readFileSync(path.join(dir, f), "utf-8");
    if (lastArc && lastFile && files.includes(lastFile)) {
      const text = read(lastFile);
      const from = lastArc.canon_ref!.endsWith("#ep") ? Math.max(-1, ...s.beats.filter((b) => b.arc_id === lastArc.id).map((b) => b.ord)) + 1 : Infinity;
      if (from < parseCanon(text).episodes.length) canon = { file: lastFile, text, from, appendTo: lastArc };
      else {
        const next = files[files.indexOf(lastFile) + 1];
        if (next) canon = { file: next, text: read(next), from: 0 };
      }
    } else if (files.length) {
      const file = pickCanonFile(files, files.map((f) => read(f).match(/^# (.+)$/m)?.[1] ?? ""), startingPoint);
      canon = { file, text: read(file), from: 0 };
    }
  }

  let plan: Plan | null = null;
  const strongOnly = (writer.params as { strongOnly?: boolean }).strongOnly !== false;
  if (strongOnly && isWeakModel(writer.model)) console.warn(`[roteirista] ${writer.model} está marcado como fraco: usando o fallback por código`);
  else {
    const outline = canon
      ? parseCanon(canon.text).episodes.slice(canon.from === Infinity ? 0 : canon.from, (canon.from === Infinity ? 0 : canon.from) + 16).map((e) => `- Ep ${e.n}: ${e.title} — ${e.synopsis}`).join("\n")
      : "";
    const npcs = chars.filter((c) => c.kind === "npc").map((c) => c.name);
    const user = [
      `CENÁRIO: ${campaign.ruleset.name}. ${cut(campaign.ruleset.loreNotes, 1500)}`,
      `HOJE: Dia ${day}. Ponto de partida: ${startingPoint || "-"}`,
      player ? `PERSONAGEM DO JOGADOR: ${player.name}. ${cut([player.persona.backstory, player.persona.goals].filter(Boolean).join(" "), 600)}` : "",
      npcs.length ? `NPCs JÁ REGISTRADOS: ${npcs.slice(0, 40).join(", ")}` : "",
      await storySoFar(campaignId, s),
      canon ? `CÂNONE (${parseCanon(canon.text).title}), episódios em ordem:\n${outline}` : "",
      mode === "extend" ? "Escreva o PRÓXIMO arco, continuando a agenda acima." : "Escreva o arco atual, começando de onde a história está.",
    ]
      .filter(Boolean)
      .join("\n\n");
    const messages: ChatMessage[] = [
      { role: "system", content: writer.system_prompt },
      { role: "user", content: user },
    ];
    for (let attempt = 0; attempt < 2 && !plan; attempt++) {
      const r = await chat({
        model: writer.model,
        messages,
        temperature: writer.temperature,
        max_tokens: writer.max_tokens,
        reasoning: writer.params.reasoning as Record<string, unknown> | undefined,
        agentId: "scriptwriter",
        campaignId,
        purpose: attempt ? "roteiro do arco (nova tentativa)" : `roteiro do arco (${mode})`,
      }).catch((e) => (console.warn("[roteirista]", e), null));
      if (!r) break;
      const v = validatePlan(parseLooseJson(r.content), { player: player?.name ?? "", day });
      if (v.plan) {
        const flagged = await pcActByJev(v.plan.beats, player?.name ?? "o jogador", campaignId);
        if (flagged.length) v.errors.push(...flagged.map((i) => `beat "${v.plan!.beats[i].title}": exige ato de ${player?.name}; escreva o que o MUNDO faz`));
        // na nova tentativa os sinalizados saem (o resto continua valendo, se sobrar 4)
        if (attempt && flagged.length) v.plan.beats = v.plan.beats.length - flagged.length >= 4 ? dropBeats(v.plan, flagged) : [];
      }
      if (v.plan && (!v.errors.length || (attempt && v.plan.beats.length >= 4))) plan = { ...v.plan, canonRef: canon?.file ?? null };
      else messages.push({ role: "assistant", content: r.content }, { role: "user", content: `Corrija e responda só o JSON:\n- ${v.errors.join("\n- ") || "JSON ilegível"}` });
    }
  }
  let source: "llm" | "canon" | "generic" = "llm";
  if (!plan && canon && canon.from !== Infinity) {
    plan = canonPlan(canon.file, canon.text, { day, from: canon.from });
    if (plan && canon.appendTo?.canon_ref?.endsWith("#ep")) plan.appendTo = canon.appendTo.id;
    source = "canon";
  }
  if (!plan) {
    plan = genericPlan(startingPoint || campaign.ruleset.description || "", startingPoint.split(/[,.;]/)[0]?.trim() ?? "", day);
    source = "generic";
  }
  const sceneSeq = (await q<{ seq: number }>(`SELECT seq FROM scenes WHERE campaign_id = $1 AND is_current ORDER BY seq DESC LIMIT 1`, [campaignId]))[0]?.seq ?? 1;
  await savePlan(campaignId, plan, sceneSeq, chars);
  return { source, title: plan.arc.title };
}

/** Tira os beats dos índices e refaz os índices de after/clocks/hooks. */
function dropBeats(plan: Plan, idx: number[]): PlanBeat[] {
  const map = new Map<number, number>();
  plan.beats.forEach((_, i) => !idx.includes(i) && map.set(i, map.size));
  const beats = plan.beats.filter((_, i) => map.has(i)).map((b) => ({ ...b, after: b.after !== undefined ? map.get(b.after) : undefined }));
  plan.clocks = plan.clocks.map((c) => ({ ...c, onFullBeat: c.onFullBeat !== undefined ? map.get(c.onFullBeat) : undefined }));
  plan.hooks = plan.hooks.map((h) => ({ ...h, beat: h.beat !== undefined ? map.get(h.beat) : undefined }));
  return beats;
}

/** Grava o plano numa transação: arco (ativo se não há outro), beats com ids e gatilhos, relógios, ganchos, agenda dos NPCs. */
export async function savePlan(campaignId: string, plan: Plan, sceneSeq: number, chars: Pick<Character, "id" | "name" | "kind" | "persona">[] = []): Promise<string> {
  const client = await (await db()).connect();
  try {
    await client.query("BEGIN");
    let arcId = plan.appendTo;
    if (!arcId) {
      const { rows } = await client.query<{ ord: number | null; active: boolean }>(
        `SELECT MAX(ord) AS ord, bool_or(status = 'active') AS active FROM arcs WHERE campaign_id = $1`,
        [campaignId]
      );
      arcId = randomUUID();
      await client.query(
        `INSERT INTO arcs (id, campaign_id, ord, kind, title, premise, stakes, status, canon_ref) VALUES ($1,$2,$3,'main',$4,$5,$6,$7,$8)`,
        [arcId, campaignId, (rows[0]?.ord ?? -1) + 1, plan.arc.title, plan.arc.premise, plan.arc.stakes, rows[0]?.active ? "pending" : "active", plan.canonRef ?? null]
      );
    }
    const beatIds = plan.beats.map(() => randomUUID());
    const clockIds = plan.clocks.map(() => randomUUID());
    for (const [i, b] of plan.beats.entries()) {
      const trigger: Trigger = {
        ...(b.after !== undefined && { after_beat: beatIds[b.after] }),
        ...(b.day !== undefined && { day_gte: b.day }),
        ...(b.clock && clockIds[b.clock.index] && { clock: { id: clockIds[b.clock.index], gte: b.clock.gte } }),
        ...(b.narrative && { narrative: b.narrative }),
      };
      await client.query(
        `INSERT INTO beats (id, campaign_id, arc_id, ord, title, situation, npcs, location, trigger, due_minute, required, fallback, foreshadow, clue, reward)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          beatIds[i], campaignId, arcId, (plan.ordFrom ?? 0) + i, b.title, b.situation, b.cast, b.location, JSON.stringify(trigger),
          dueOf(b.dueDay), b.required, b.fallback, b.foreshadow, b.clue, b.reward ? JSON.stringify(b.reward) : null,
        ]
      );
    }
    // depois dos beats: on_full_beat aponta para um deles
    for (const [i, c] of plan.clocks.entries())
      await client.query(`INSERT INTO clocks (id, campaign_id, arc_id, name, segments, filled, tick, on_full_beat) VALUES ($1,$2,$3,$4,$5,0,$6,$7)`, [
        clockIds[i], campaignId, arcId, c.name, c.segments, c.tick, c.onFullBeat !== undefined ? beatIds[c.onFullBeat] : null,
      ]);
    for (const h of plan.hooks)
      await client.query(`INSERT INTO hooks (campaign_id, text, beat_id, status, last_touched_scene) VALUES ($1,$2,$3,'open',$4)`, [
        campaignId, h.text, h.beat !== undefined ? beatIds[h.beat] : null, sceneSeq,
      ]);
    // agenda dos NPCs já registrados (cartão do NPC em characters.persona)
    for (const n of plan.npcs) {
      const c = chars.find((x) => x.kind === "npc" && matchName([x.name], n.name));
      if (c) await client.query(`UPDATE characters SET persona = persona || $1::jsonb WHERE id = $2`, [JSON.stringify({ agenda: n.agenda, wants: n.wants }), c.id]);
    }
    await client.query("COMMIT");
    return arcId;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/** O que o jogador vê na aba Roteiro: título e o que está em jogo do arco ativo, e os relógios dele. Nunca os beats. */
export async function storyView(campaignId: string): Promise<{ arc: { title: string; stakes: string } | null; clocks: { name: string; filled: number; segments: number }[] }> {
  const s = await loadStory(campaignId);
  const arc = activeArc(s);
  return {
    arc: arc ? { title: arc.title, stakes: arc.stakes } : null,
    clocks: s.clocks.filter((c) => c.arc_id === arc?.id).map((c) => ({ name: c.name, filled: c.filled, segments: c.segments })),
  };
}
