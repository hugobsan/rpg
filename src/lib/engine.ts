import { q } from "./db";
import { getAgent } from "./agents";
import { chat, ChatMessage, estimateTokens } from "./openrouter";
import { abilityPromptLine, currentMilestone, nextMilestone, rulesetPromptSummary } from "./ruleset";
import { activeDirectives, excerpt, indexHistory, searchBookChunks, type ChunkHit } from "./retrieval";
import { listBooks } from "./books";
import { decideLeaks, decideTurn, type LeakInput } from "./decisions";
import { knownLine, recordFact, sceneKnowledge, type Known } from "./knowledge";
import { getAdvanced } from "./advanced";
import { attributeCap, attributePoints, controlLabel, costMultOf, powerLevel } from "./progression";
import { clockParts, formatClock, getClock, period } from "./clock";
import { hydrateSheets } from "./library";
import { getObjectives } from "./objectives";
import { regenNotes, snapshotOption, takeSnapshot } from "./turnSnapshot";
import { currencyPromptLine, formatMoney } from "./money";
import { playerFixesLine } from "./corrections";
import { CONTINUE_INPUT } from "./continueScene";
import { characterInWords, executeGmTool, NARRATOR_TOOLS, type ToolContext } from "./tools";
import { interpret, askOracle, resolveSteps, resultsBlock } from "./resolver";
import { annotate, applyEffects } from "./effects";
import {
  type EffectOption,
  type Effects,
  type EffectsCtx,
  type Interpretation,
  type InterpStep,
  optionSteps,
  parseLooseJson,
  proseIssues,
  resolveName,
  splitNarration,
  type StepResult,
  validateEffects,
} from "./contracts";
import { activeArc, loadStory, narrativeCandidates, prepareScene, afterTurn } from "./story";
import { Campaign, Character, Scene, TurnEvent } from "./types";

// ---------- carregamento de estado ----------

export async function getCampaign(id: string): Promise<Campaign> {
  // sem a coluna script (roteiro antigo, legado); o arco ativo vem junto (momento da história)
  const rows = await q<Campaign>(
    `SELECT c.id, c.name, c.style, c.ruleset, c.state,
       (SELECT jsonb_build_object('title', a.title, 'premise', a.premise, 'stakes', a.stakes) FROM arcs a
         WHERE a.campaign_id = c.id AND a.status = 'active' ORDER BY a.ord LIMIT 1) AS arc
     FROM campaigns c WHERE c.id = $1`,
    [id]
  );
  if (!rows.length) throw new Error("Campanha não encontrada");
  return rows[0];
}

export async function getCurrentScene(campaignId: string): Promise<Scene> {
  const rows = await q<Scene>(
    `SELECT * FROM scenes WHERE campaign_id = $1 AND is_current ORDER BY seq DESC LIMIT 1`,
    [campaignId]
  );
  if (rows.length) return rows[0];
  const created = await q<Scene>(
    `INSERT INTO scenes (campaign_id, seq, mode, title) VALUES ($1, 1, 'exploration', 'Início') RETURNING *`,
    [campaignId]
  );
  return created[0];
}

/** Personagens da campanha com as habilidades hidratadas pela biblioteca (gravar de volta só com dehydrateSheet). */
export async function getCharacters(campaignId: string): Promise<Character[]> {
  return hydrateSheets(
    await q<Character>(`SELECT * FROM characters WHERE campaign_id = $1 ORDER BY kind DESC, name`, [campaignId])
  );
}

/** Ficha em texto, com números (conversa fora do jogo e Roteirista; o Narrador vê a ficha em palavras). */
export function sheetSummary(c: Character, full: boolean, rs: Campaign["ruleset"]): string {
  const s = c.sheet;
  const res = Object.entries(s.resources)
    .map(([k, v]) => `${k} ${v.current}/${v.max}`)
    .join(", ");
  const attrs = Object.entries(s.attributes)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  const cargo = rs.ranks.find((r) => r.key === s.rank)?.label || s.rank || "-";
  const { level, next } = powerLevel(rs, s.xp);
  const lines = [
    `${c.name} (${c.kind}${c.canon ? ", canônico" : ""}${c.active ? "" : ", FORA DE CENA"}) — cargo: ${cargo} | nível de poder: ${level?.label ?? "-"} (pela XP, não é cargo), xp: ${s.xp}${next ? ` (próximo nível aos ${next.xpRequired})` : ""}`,
    `  recursos: ${res} | atributos: ${attrs}`,
  ];
  if (c.kind === "player") {
    const capped = rs.attributes.filter((a) => (s.attributes[a.key] ?? 0) >= attributeCap(rs, s.xp, a.key)).map((a) => a.key);
    const pts = attributePoints(rs, s);
    lines.push(
      `  teto de atributo do nível: ${level?.attributeCap ?? "-"}${capped.length ? ` (no teto ou acima: ${capped.join(", ")})` : ""} | pontos livres: ${pts.free} (o jogador distribui)`
    );
  }
  const extra = Object.entries(s.extra || {})
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join("; ");
  if (extra) lines.push(`  ${extra}`);
  if (rs.currency && (c.kind === "player" || s.money !== undefined)) lines.push(`  dinheiro: ${formatMoney(s.money ?? 0, rs.currency)}`);
  if (costMultOf(s.costMult) !== 1) lines.push(`  ${controlLabel(rs).toLowerCase()}: custo das técnicas ×${String(costMultOf(s.costMult)).replace(".", ",")} (já no custo abaixo)`);
  if (s.abilities.length)
    lines.push(
      `  habilidades:\n` +
        s.abilities
          .map((a) => {
            let line = `    - ${abilityPromptLine(rs, a, Infinity, s)}`;
            const cur = currentMilestone(a);
            const next = nextMilestone(a);
            if (cur) line += ` — atual: ${cur.description}`;
            if (next) line += ` | próximo marco aos ${next.threshold}%: ${next.description}`;
            if (a.incomplete && !a.removed) line += ` [INCOMPLETA na biblioteca: complete com edit_ability]`;
            if (a.removed) line += ` [saiu da biblioteca]`;
            return line;
          })
          .join("\n")
    );
  else lines.push(`  habilidades: nenhuma registrada`);
  if (full) {
    if (s.inventory.length) lines.push(`  inventário: ${s.inventory.map((i) => `${i.qty}x ${i.name}`).join(", ")}`);
    const p = c.persona;
    const cut = (t: string, n: number) => (t.length > n ? `${t.slice(0, n).trimEnd()}…` : t);
    const who = [p.role, p.age].filter(Boolean).join(", ");
    if (who) lines.push(`  ${cut(who, 140)}`);
    if (p.personality) lines.push(`  personalidade: ${p.personality}`);
    if (p.speech) lines.push(`  jeito de falar: ${cut(p.speech, 200)}`);
    if (p.relationships) lines.push(`  relações: ${cut(p.relationships, 240)}`);
    if (p.current) lines.push(`  situação atual (vale mais que o passado): ${p.current}`);
    if (p.backstory) lines.push(`  passado: ${c.kind === "npc" ? cut(p.backstory, 400) : p.backstory}`);
    if (p.goals) lines.push(`  objetivos: ${p.goals}`);
    if (p.secrets) lines.push(`  segredos (só você sabe): ${p.secrets}`);
  }
  return lines.join("\n");
}

// ---------- contexto do Narrador ----------

const cut = (t: string | undefined, n: number) => (!t ? "" : t.length > n ? `${t.slice(0, n).trimEnd()}…` : t);

/** NPC em cena, curto: quem é, o que quer e como fala (sem ficha nem número). */
function npcLine(c: Character): string {
  const p = c.persona;
  return [
    `- ${c.name}${p.role ? ` — ${cut(p.role, 80)}` : ""}`,
    p.personality && `  personalidade: ${cut(p.personality, 200)}`,
    p.speech && `  fala: ${cut(p.speech, 140)}`,
    (p.wants || p.goals) && `  quer: ${cut(p.wants || p.goals, 160)}`,
    p.agenda && `  agenda (o que faz por conta própria): ${cut(p.agenda, 160)}`,
    p.current && `  agora: ${cut(p.current, 200)}`,
    p.secrets && `  segredo (nunca diga): ${cut(p.secrets, 140)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Memória do turno: o SABE de cada NPC em cena e o que só o jogador sabe. */
export type TurnMemory = { sabe: Map<string, Known[]>; onlyPlayer: Known[] };

/** Bloco SABE de um NPC (contexto do Narrador e agente NPC). */
export function sabeBlock(known: Known[], indent = "  "): string {
  return known.length
    ? `${indent}SABE (só isto; o resto ele não sabe):\n${known.map((k) => `${indent}  ${knownLine(k)}`).join("\n")}`
    : `${indent}SABE: nada da história até agora; só o que vê nesta cena.`;
}

/**
 * Falas de NPC na narração (linhas **Nome:** "fala"), pelo nome registrado; quem não está registrado fica de fora
 * (não tem SABE para comparar).
 */
export function npcSpeeches(prose: string, npcs: string[], location?: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of prose.matchAll(/^\s*\*\*([^*\n]{1,80}?)(?::\*\*|\*\*\s*:)\s*(.*)$/gm)) {
    const name = resolveName(npcs, m[1].trim(), location);
    if (name) out.set(name, [...(out.get(name) ?? []), m[2].trim()]);
  }
  return out;
}

/** O que o validador do bloco precisa saber da campanha. */
export function effectsCtx(campaign: Campaign, chars: Character[], activeBeat: string | null = null, location = ""): EffectsCtx {
  const player = chars.find((c) => c.kind === "player");
  return {
    player: player?.name ?? "",
    abilities: player?.sheet.abilities.flatMap((a) => [a.name, ...(a.translation ? [a.translation] : [])]) ?? [],
    items: player?.sheet.inventory.map((i) => i.name) ?? [],
    npcs: chars.filter((c) => c.kind === "npc").map((c) => c.name),
    missions: getObjectives(campaign.state)
      .filter((o) => o.status === "aberto" || o.status === "oferecida")
      .map((o) => ({ id: o.id, title: o.title, status: o.status })),
    money: campaign.ruleset.currency ? (player?.sheet.money ?? 0) : null,
    resourceWords: campaign.ruleset.resources.flatMap((r) => [r.key, r.label]),
    activeBeat,
    location,
  };
}

/** System do Narrador (o que não muda na campanha: ponto de cache) e o contexto do turno. */
async function narratorContext(
  campaign: Campaign,
  scene: Scene,
  chars: Character[],
  basePrompt: string,
  results: string,
  books: string,
  storyBlock: string,
  memory: TurnMemory
): Promise<[fixed: string, turn: string]> {
  const rs = campaign.ruleset;
  const player = chars.find((c) => c.kind === "player");
  const here = chars.filter((c) => c.kind === "npc" && c.active);
  const away = chars.filter((c) => c.kind === "npc" && !c.active).map((c) => c.name);
  const clock = getClock(campaign.state);
  const directives = await activeDirectives(campaign.id);
  const objectives = getObjectives(campaign.state);
  const live = objectives.filter((o) => o.status === "aberto" || o.status === "oferecida");
  const done = objectives.filter((o) => o.status === "concluido").slice(-6);
  const money = (n: number) => (rs.currency ? formatMoney(n, rs.currency) : String(n));

  const fixed = [
    basePrompt,
    `\n====== CAMPANHA: ${campaign.name} ======`,
    `CENÁRIO: ${rs.name}. ${cut(rs.loreNotes, 2500)}`,
    rs.currency ? currencyPromptLine(rs.currency).replace(/ O saldo fica na ficha.*?pagar\./, " Ninguém compra o que não pode pagar.") : "",
  ];
  const cargo = player ? rs.ranks.find((r) => r.key === player.sheet.rank)?.label : undefined;
  const turn = [
    `--- CENA ---\nLocal: ${scene.location || "?"}${scene.title ? ` | ${scene.title}` : ""}\n${
      clock ? `Hora: ${formatClock(clock.minutes)} (${period(clock.minutes)})` : "Hora: ainda não definida (a história começa de manhã)"
    }`,
    player
      ? `\n--- PERSONAGEM DO JOGADOR ---\n${characterInWords(player, rs.resources)}${cargo ? `\nCargo: ${cargo}` : ""}${rs.currency ? `\nDinheiro: ${money(player.sheet.money ?? 0)}` : ""}`
      : "",
    `\n--- NPCs EM CENA ---\n${here.map((c) => `${npcLine(c)}\n${sabeBlock(memory.sabe.get(c.id) ?? [])}`).join("\n") || "(nenhum)"}`,
    memory.onlyPlayer.length
      ? `\n--- O QUE SÓ O JOGADOR SABE (continuidade para você; nenhum NPC em cena sabe disto: não falam nem insinuam) ---\n${memory.onlyPlayer.map(knownLine).join("\n")}`
      : "",
    away.length ? `NPCs conhecidos fora de cena: ${away.slice(0, 40).join(", ")}` : "",
    live.length || done.length
      ? `\n--- MISSÕES ---\n${live
          .map(
            (o) =>
              `[${o.id}] ${o.title} — ${o.status === "oferecida" ? "oferecida, ainda não aceita" : "aceita"}${o.giver ? `, de ${o.giver}` : ""}${
                o.deadlineMinutes !== undefined ? `, prazo ${formatClock(o.deadlineMinutes)}` : ""
              }${o.pay ? `, paga ${money(o.pay)}` : ""}`
          )
          .join("\n")}${done.length ? `\nJá cumpridas (não ofereça de novo como inéditas): ${done.map((o) => o.title).join("; ")}` : ""}`
      : "",
    storyBlock,
    books ? `\n--- TRECHOS DOS LIVROS DE REFERÊNCIA ---\n${books}` : "",
    playerFixesLine(campaign.state),
    directives.length
      ? `\n--- DIRETRIZES DO JOGADOR (fora do jogo) — siga ---\n${directives
          .map((d) => `- ${d.content}${d.subject === "proxima_cena" ? " (vale nesta cena e na próxima)" : ""}`)
          .join("\n")}`
      : "",
    results,
    "\n(Narre o que está acima sem números de mecânica e termine com o bloco ```efeitos.)",
  ];
  return [fixed.filter(Boolean).join("\n"), turn.filter(Boolean).join("\n")];
}

/**
 * Conversa particular encerrada (linha 'talk' que lib/npc grava ao fechar), como o Narrador a vê no histórico: fica no
 * lugar dela entre os turnos, com o começo e o fim da conversa e a fala de encerramento do NPC. A conversa inteira
 * está no search_history.
 */
function talkNote(m: { speaker: string | null; meta: { tail?: string; notes?: string[]; farewell?: string } | null }): string {
  const { tail, notes, farewell } = m.meta ?? {};
  return [
    `(Nota do sistema: o jogador conversou em particular com ${m.speaker}, fora da sua narração. Continue a cena de onde a conversa parou, sem repetir as falas; ela inteira está no search_history.)`,
    tail || "",
    farewell ? `${m.speaker}, ao encerrar: ${farewell}` : "",
    notes?.length ? `Ficou registrado:\n${notes.map((n) => `- ${n}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Fontes da busca web (annotations) em texto, para não perdê-las nas rodadas sem :online. */
function webSources(raw: unknown): string {
  const anns =
    (raw as { choices?: { message?: { annotations?: { url_citation?: { title?: string; url?: string; content?: string } }[] } }[] })
      ?.choices?.[0]?.message?.annotations || [];
  return anns
    .map((a) => a.url_citation)
    .filter((c) => c?.url)
    .map((c) => `- ${c!.title || c!.url} (${c!.url})${c!.content ? `: ${c!.content.slice(0, 500)}` : ""}`)
    .join("\n");
}

/** As `n` últimas trocas (do jogador ao que veio depois), começando numa fala do jogador. */
async function recentExchanges(campaignId: string, n = 6): Promise<ChatMessage[]> {
  const rows = (
    await q<{ role: string; speaker: string | null; content: string; meta: Parameters<typeof talkNote>[0]["meta"] }>(
      `SELECT role, speaker, content, meta FROM messages WHERE campaign_id = $1 AND role IN ('player','gm','system','talk')
       ORDER BY id DESC LIMIT $2`,
      [campaignId, n * 4]
    )
  )
    .reverse()
    .map((m) => (m.role === "talk" ? { ...m, content: talkNote(m) } : m));
  let i = rows.length;
  for (let seen = 0; i > 0 && seen < n; ) if (rows[--i].role === "player") seen++;
  while (i < rows.length && rows[i].role !== "player") i++; // a API da Anthropic quer o 1º turno do usuário
  // conversa particular entra como nota do lado do jogador (falas seguidas do mesmo lado se juntam na API)
  return rows.slice(i).map((m) => ({ role: m.role === "player" || m.role === "talk" ? "user" : "assistant", content: m.content }));
}

// ---------- persistência de mensagens ----------

export async function saveMessage(
  campaignId: string,
  sceneId: string | null,
  role: string,
  content: string,
  meta: Record<string, unknown> = {},
  speaker: string | null = null
): Promise<number> {
  const rows = await q<{ id: number }>(
    `INSERT INTO messages (campaign_id, scene_id, role, speaker, content, meta, tokens)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [campaignId, sceneId, role, speaker, content, JSON.stringify(meta), estimateTokens(content)]
  );
  return rows[0].id;
}

// ---------- turno do jogador ----------

const FENCES = ["```efeitos", "```json", "```choices", "```effects"];

/**
 * Parte da narração que já pode ir ao jogador durante o streaming: corta no bloco de efeitos e segura um começo de
 * cerca no fim ("`", "``", "```efe"...) até saber se é o bloco.
 */
export function visibleNarration(text: string): string {
  const at = FENCES.map((f) => text.indexOf(f)).filter((i) => i >= 0);
  if (at.length) return text.slice(0, Math.min(...at));
  for (let k = Math.min(Math.max(...FENCES.map((f) => f.length)) - 1, text.length); k > 0; k--)
    if (FENCES.some((f) => f.startsWith(text.slice(-k)))) return text.slice(0, -k);
  return text;
}

function toolSummary(name: string, args: Record<string, unknown>): string {
  if (name === "search_history") return `🔍 buscando no histórico: "${args.query}"`;
  if (name === "search_lore") return `📖 consultando livros e biblioteca: "${args.query}"`;
  if (name === "get_character") return `📋 lendo ficha de ${args.name}`;
  return `⚙️ ${name}`;
}

/**
 * NPCs registrados que falaram na narração e, pelo Jev, citaram algo fora do SABE deles. NPC que não estava em cena no
 * começo do turno (chegou agora) tem o SABE lido aqui. Falha = nenhum.
 */
async function checkLeaks(
  campaignId: string,
  prose: string,
  chars: Character[],
  location: string,
  memory: TurnMemory,
  query: string,
  recent: string
): Promise<string[]> {
  const npcs = chars.filter((c) => c.kind === "npc");
  const said = npcSpeeches(prose, npcs.map((c) => c.name), location);
  if (!said.size) return [];
  const speakers = npcs.filter((c) => said.has(c.name));
  const missing = speakers.filter((c) => !memory.sabe.has(c.id)).map((c) => c.id);
  const extra = missing.length ? (await sceneKnowledge(campaignId, query, missing, null).catch(() => null))?.sabe : undefined;
  const input: LeakInput[] = speakers.map((c) => ({
    name: c.name,
    knows: (memory.sabe.get(c.id) ?? extra?.get(c.id) ?? []).map(knownLine),
    lines: said.get(c.name)!,
  }));
  const { flagged, p } = await decideLeaks({ recent: recent.slice(-2000), narration: prose.slice(-3000) }, input, campaignId);
  if (flagged.length) console.warn("[falas fora do SABE]", p);
  return flagged;
}

/**
 * Um turno: Jev (fora do jogo, conversa particular, web, livro, modelo) → Intérprete (texto livre) ou a opção tipada →
 * Resolvedor (código) → Narrador (prosa + bloco de efeitos, até 2 rodadas de leitura) → validador de prosa (1 nova
 * tentativa) → bloco validado (ausente: Anotador) → narração salva com as opções tipadas → efeitos aplicados por código.
 */
export async function runTurn(
  campaignId: string,
  playerInput: string,
  emit: (e: TurnEvent) => void,
  // "gerar novamente": o estado já foi restaurado; feedback = motivo opcional do jogador
  regen?: { feedback: string },
  // "parar" do jogador: vale só até a narração ser salva. Abortado, lança signal.reason (sempre depois da foto e da
  // ação salvas: quem chama volta a foto); depois da narração é ignorado e os efeitos seguem
  signal?: AbortSignal,
  // pergunta ao Jev se a ação é fala fora do jogo sobre o registro (não no gerar novamente nem ao editar a ação)
  askMeta = !regen,
  // pergunta se a fala é só com um NPC (vai ao chat dele); false = o jogador já disse que era da cena
  askTalk = askMeta,
  // opção escolhida (índice nas opções da última narração): passos já tipados, sem Intérprete
  optionIndex?: number
): Promise<void> {
  emit({ type: "status", text: "Lendo a cena..." });
  const acting = !!playerInput && playerInput !== CONTINUE_INPUT;
  const booksP = acting ? listBooks(campaignId).catch(() => []) : Promise.resolve([]);
  const bookHitsP = booksP.then((b) => (b.length ? searchBookChunks(campaignId, playerInput, 2) : [])).catch((): ChunkHit[] => []);
  // gerar novamente uma opção escolhida: a foto guarda o índice (a narração com as opções continua salva)
  if (regen && optionIndex === undefined) optionIndex = await snapshotOption(campaignId);
  const [campaign, scene, chars, gm, history, books, [lastGm], story] = await Promise.all([
    getCampaign(campaignId),
    getCurrentScene(campaignId),
    getCharacters(campaignId),
    getAgent("gm"),
    recentExchanges(campaignId),
    booksP,
    q<{ content: string; meta: { options?: EffectOption[] } | null }>(
      `SELECT content, meta FROM messages WHERE campaign_id = $1 AND role = 'gm' ORDER BY id DESC LIMIT 1`,
      [campaignId]
    ),
    loadStory(campaignId),
  ]);
  const params = gm.params as { complexModel?: string; reasoning?: unknown };
  const complexModel = params.complexModel?.trim();
  const lastGmText = lastGm?.content ?? "";
  const option = optionIndex !== undefined ? lastGm?.meta?.options?.[optionIndex] : undefined;
  const player = chars.find((c) => c.kind === "player");
  const arc = activeArc(story);
  const now = getClock(campaign.state)?.minutes;
  // gatilhos narrativos de beat vão na mesma chamada do Jev (sobre a última narração)
  const beatTriggers = Object.fromEntries(narrativeCandidates(story, now === undefined ? 1 : clockParts(now).day).map((b) => [b.id, b.trigger.narrative!]));
  const npcsHere = chars.filter((c) => c.kind === "npc" && c.active);

  // Jev, numa chamada só: modelo do turno, busca web, livros, fora do jogo e conversa particular
  const decision = await decideTurn(
    {
      setting: { name: campaign.ruleset.name, canonBased: !!campaign.ruleset.canonBased },
      scene: { mode: scene.mode, location: scene.location, title: scene.title, summary: scene.summary },
      activeArc: arc ? `${arc.title}: ${arc.stakes}` : null,
      npcsInScene: Object.fromEntries(npcsHere.map((c) => [c.name, [c.persona.personality, c.sheet.abilities.map((a) => a.name).join(", ")].filter(Boolean).join(" | ")])),
      lastGmNarration: lastGmText,
      playerAction: playerInput,
      askComplexity: !!complexModel && complexModel !== gm.model,
      askWeb: gm.web_search,
      askMeta: askMeta && acting && !option,
      // batalha e treino: a fala com o NPC faz parte da atividade da cena
      askTalk: askTalk && acting && !option && scene.mode !== "battle" && scene.mode !== "training",
      books: books.map((b) => b.title),
      beatTriggers: lastGmText ? beatTriggers : {},
    },
    campaignId
  );
  // pergunta ou reclamação sobre o registro: vai à conversa fora do jogo, sem turno. Falhou = turno normal.
  // import dinâmico: ooc.ts importa este arquivo
  if (decision.meta) {
    emit({ type: "status", text: "Fora do jogo: o Mestre está respondendo..." });
    const answered = await (await import("./ooc")).oocTalk(campaignId, playerInput).catch((e) => console.warn("[fora do jogo]", e));
    if (answered) {
      emit({ type: "ooc" });
      emit({ type: "done" });
      return;
    }
  }
  // fala só com um NPC em cena: vai ao chat dele; o registro e o relógio ficam para quando a conversa fechar
  const talkNpc = decision.talk ? npcsHere.find((c) => c.name === decision.talk) : undefined;
  if (talkNpc) {
    emit({ type: "status", text: `Conversa particular: ${talkNpc.name} está respondendo...` });
    const r = await (await import("./npc")).npcTalk(campaignId, talkNpc.id, null, playerInput, true).catch((e) => console.warn("[conversa com NPC]", e));
    if (r && !r.refused) {
      emit({ type: "npc_talk", npcId: talkNpc.id, sessionId: r.sessionId, messages: [{ role: "player", content: playerInput }, { role: "npc", content: r.reply }] });
      emit({ type: "done" });
      return;
    }
  }
  // foto do estado antes do turno (depois do Jev: a fala fora do jogo não apaga a foto do turno anterior)
  // gerar novamente: os motivos anteriores desta mesma ação continuam valendo
  const reasons = regen ? [...(await regenNotes(campaignId)), regen.feedback.trim()].filter(Boolean) : [];
  await takeSnapshot(campaignId, playerInput, reasons, option ? optionIndex : undefined);
  await saveMessage(campaignId, scene.id, "player", playerInput, option ? { option: optionIndex } : {});
  const turnModel = complexModel && decision.complex ? complexModel : gm.model;
  const useWeb = gm.web_search && decision.web !== false;
  const bookText = decision.book
    ? (await bookHitsP).map((h) => `[${h.title} | pág. ${h.page}]\n${excerpt(h.content, playerInput, 700)}`).join("\n---\n")
    : "";

  // ação → passos tipados → Resolvedor (código). Opção escolhida: sem Intérprete
  const toolCtx: ToolContext = { campaign, scene, emit };
  let it: Interpretation | undefined;
  let steps: InterpStep[] = [];
  if (option) steps = optionSteps(option);
  else if (acting && player) {
    emit({ type: "status", text: "Lendo a sua ação..." });
    it = await interpret(campaignId, playerInput, player, campaign.ruleset.attributes, npcsHere.map((c) => c.name), lastGmText);
    steps = it.steps;
  }
  const results: StepResult[] = player && steps.length ? await resolveSteps(toolCtx, player, steps) : [];
  const oracleLine = it?.question ? askOracle(it.question) : undefined;

  // história por código + cartão do Diretor (síncrono, antes do Narrador); falhou = turno sem cartão
  const scenePlan = await prepareScene(toolCtx, chars, decision.beats, (text) => emit({ type: "status", text })).catch((e) => {
    console.warn("[história]", e);
    return { block: "", beat: null, card: null };
  });
  // memória por testemunha: o SABE de cada NPC em cena, pela ação (ou pelo fim da narração anterior) e pela recência
  const memQuery = acting ? playerInput : lastGmText.slice(-400);
  const memory: TurnMemory = await sceneKnowledge(campaignId, memQuery, npcsHere.map((c) => c.id), player?.id ?? null, (await getAdvanced()).memory.knowsTopK).catch(
    (e) => (console.warn("[memória]", e), { sabe: new Map(), onlyPlayer: [] })
  );
  const [fixed, turn] = await narratorContext(campaign, toolCtx.scene, chars, gm.system_prompt, resultsBlock(results, steps.length, it, oracleLine), bookText, scenePlan.block, memory);
  if (history.length) history[history.length - 1] = { ...history[history.length - 1], cache: true };
  const messages: ChatMessage[] = [
    { role: "system", content: fixed },
    ...history,
    { role: "user", content: `(Contexto do turno, montado pelo sistema; não é fala do jogador)\n${turn}` },
    { role: "user", content: playerInput },
  ];
  if (playerInput === CONTINUE_INPUT)
    messages[messages.length - 1].content =
      "(Nota do sistema, fora do jogo: o jogador não age neste turno e pediu para você continuar a cena. " +
      "Siga a cena adiante: o que os NPCs fazem, o que acontece, o tempo que passa, até um ponto em que o personagem tenha algo a fazer. " +
      "Não decida nada pelo personagem do jogador.)";
  if (regen) {
    // nota fora do jogo só no prompt; a mensagem salva continua sendo a ação original
    const last = messages[messages.length - 1];
    last.content = `${last.content}\n\n(Nota do jogador ao Mestre, fora do jogo: ele pediu para você escrever de novo a resposta a esta ação. ${
      reasons.length > 1
        ? `Ele já pediu mais de uma vez, e TODOS os pedidos valem juntos (o último só manda onde contradiz um anterior): ${reasons.map((r, i) => `${i + 1}) ${r}`).join(" ")}`
        : reasons.length
          ? `Motivo, que tem prioridade: ${reasons[0]}`
          : "Sem motivo específico: escreva uma versão diferente, com outro rumo ou outra abordagem."
    })`;
  }

  // Narrador: até 2 rodadas com as ferramentas de leitura; a seguinte só em texto
  const toolRounds = 2;
  let text = "";
  let kept = ""; // prosa de rodadas que também chamaram ferramentas: o jogador já leu, fica
  for (let round = 0; round <= toolRounds; round++) {
    let roundText = "";
    let streamed = 0;
    signal?.throwIfAborted();
    emit({ type: "status", text: "O Mestre está pensando..." });
    const result = await chat({
      model: turnModel,
      messages,
      temperature: gm.temperature,
      max_tokens: gm.max_tokens,
      reasoning: params.reasoning as Record<string, unknown> | undefined,
      tools: NARRATOR_TOOLS,
      noTools: round === toolRounds,
      webSearch: useWeb && round === 0, // :online só na 1ª rodada (o plugin cobra por requisição)
      agentId: "gm",
      campaignId,
      purpose: round === 0 ? "turno do jogador" : `turno (round ${round + 1})`,
      onDelta: (t) => {
        const visible = visibleNarration((roundText += t));
        if (visible.length <= streamed) return;
        if (!streamed) emit({ type: "status", text: "Escrevendo..." });
        emit({ type: "narration_delta", text: (!streamed && kept ? "\n\n" : "") + visible.slice(streamed) });
        streamed = visible.length;
      },
      signal,
    }).catch((e) => {
      signal?.throwIfAborted();
      throw e;
    });
    if (!result.toolCalls.length || round === toolRounds) {
      text = [kept, result.content].filter(Boolean).join("\n\n");
      break;
    }
    const said = splitNarration(result.content || "").prose;
    if (said) kept = [kept, said].filter(Boolean).join("\n\n");
    const sources = useWeb && round === 0 ? webSources(result.raw) : "";
    messages.push({
      role: "assistant",
      content: [result.content, sources && `[Fontes da busca web]\n${sources}`].filter(Boolean).join("\n\n") || null,
      tool_calls: result.toolCalls,
    });
    for (const call of result.toolCalls) {
      let output: string;
      try {
        const args = JSON.parse(call.function.arguments || "{}");
        if (!NARRATOR_TOOLS.some((t) => t.function.name === call.function.name)) throw new Error(`${call.function.name} não é ferramenta do Narrador`);
        emit({ type: "status", text: "Consultando memórias e livros..." });
        emit({ type: "tool", name: call.function.name, summary: toolSummary(call.function.name, args) });
        output = await executeGmTool(call.function.name, args, toolCtx);
      } catch (e) {
        output = `Erro: ${e instanceof Error ? e.message : String(e)}`;
      }
      messages.push({ role: "tool", content: output, tool_call_id: call.id, name: call.function.name });
    }
    if (said)
      messages[messages.length - 1].content +=
        "\n\n(Sistema, fora do jogo: o jogador já está lendo o texto que você escreveu junto destas ferramentas. Continue dele sem repetir nada e termine com o bloco efeitos.)";
    if (round + 1 === toolRounds)
      messages[messages.length - 1].content += "\n\n(Sistema, fora do jogo: acabaram as ferramentas deste turno. Narre agora e termine com o bloco efeitos.)";
  }

  // prosa com número de mecânica: uma nova tentativa com a crítica; fica a que tiver menos problemas
  const resourceWords = campaign.ruleset.resources.flatMap((r) => [r.key, r.label]);
  let { prose, block } = splitNarration(text);
  const issues = prose ? proseIssues(prose, resourceWords) : [];
  if (issues.length) {
    signal?.throwIfAborted();
    emit({ type: "status", text: "Revisando a narração..." });
    const retry = await chat({
      model: turnModel,
      messages: [
        ...messages,
        { role: "assistant", content: text },
        {
          role: "user",
          content: `(Sistema, fora do jogo: a narração trouxe números ou termos de regra que o mundo não tem: ${issues.map((i) => `"${i}"`).join(", ")}. Reescreva a resposta inteira sem eles (cansaço, fôlego, peso no corpo no lugar de números), com a mesma história, e termine com o bloco efeitos.)`,
        },
      ],
      temperature: gm.temperature,
      max_tokens: gm.max_tokens,
      reasoning: params.reasoning as Record<string, unknown> | undefined,
      tools: NARRATOR_TOOLS,
      noTools: true,
      agentId: "gm",
      campaignId,
      purpose: "turno (narração sem números)",
      signal,
    }).catch((e) => {
      signal?.throwIfAborted();
      console.warn("[narrador: nova tentativa]", e);
      return null;
    });
    const again = retry ? splitNarration(retry.content) : null;
    if (again?.prose && proseIssues(again.prose, resourceWords).length < issues.length) {
      prose = again.prose;
      block = again.block ?? block;
    }
  }

  // pós-checagem: NPC que falou de algo fora do SABE dele (Jev, uma pergunta por NPC) → refaz a narração 1 vez
  const leaks = prose ? await checkLeaks(campaignId, prose, chars, toolCtx.scene.location, memory, memQuery, `${lastGmText.slice(-1200)}\n\nJogador: ${playerInput}`) : [];
  if (leaks.length) {
    signal?.throwIfAborted();
    emit({ type: "status", text: "Revisando as falas..." });
    const retry = await chat({
      model: turnModel,
      messages: [
        ...messages,
        { role: "assistant", content: [prose, block && `\`\`\`efeitos\n${block}\n\`\`\``].filter(Boolean).join("\n") },
        {
          role: "user",
          content: `(Sistema, fora do jogo: na narração, ${leaks.join(" e ")} fala de algo que não está no SABE dele: não viu, não ouviu e ninguém contou. Reescreva a resposta inteira com a mesma história: cada NPC só fala do que está no SABE dele e do que acontece na cena; o que não sabe, ele pergunta ou não comenta. Termine com o bloco efeitos.)`,
        },
      ],
      temperature: gm.temperature,
      max_tokens: gm.max_tokens,
      reasoning: params.reasoning as Record<string, unknown> | undefined,
      tools: NARRATOR_TOOLS,
      noTools: true,
      agentId: "gm",
      campaignId,
      purpose: "turno (falas fora do SABE)",
      signal,
    }).catch((e) => {
      signal?.throwIfAborted();
      console.warn("[narrador: falas]", e);
      return null;
    });
    const again = retry ? splitNarration(retry.content) : null;
    if (again?.prose && proseIssues(again.prose, resourceWords).length <= proseIssues(prose, resourceWords).length) {
      prose = again.prose;
      block = again.block ?? block;
    }
  }

  // bloco de efeitos: validado campo a campo; ausente ou ilegível = Anotador; falhou = vazio
  const fxCtx = effectsCtx(campaign, chars, scenePlan.beat?.id ?? null, toolCtx.scene.location);
  const raw = block ? parseLooseJson(block) : null;
  let fx: Effects;
  let dropped: string[] = [];
  if (raw) ({ effects: fx, dropped } = validateEffects(raw, fxCtx));
  else {
    emit({ type: "status", text: "Anotando a cena..." });
    fx = await annotate(campaignId, prose, fxCtx);
  }
  if (dropped.length) console.warn("[efeitos descartados]", dropped);
  // sem opções no bloco: as saídas do cartão
  if (!fx.options.length && scenePlan.card) fx.options = scenePlan.card.exits.map((label) => ({ label, approach: "move" as const, steps: [] }));

  const narration = prose || "*(O Mestre ficou em silêncio — tente novamente.)*";
  const choices = fx.options.map((o) => o.label);
  const msgId = await saveMessage(campaignId, toolCtx.scene.id, "gm", narration, {
    choices,
    options: fx.options,
    resolved: results,
    effects: { ...fx, options: undefined },
    ...(dropped.length && { dropped }),
    ...(leaks.length && { leaks }),
  });
  emit({ type: "narration", content: narration, messageId: msgId });
  if (choices.length) {
    emit({ type: "choices", choices });
    emit({ type: "options", options: fx.options });
  }

  // depois da narração (o jogador já está lendo), antes do done: o "gerar novamente" não cruza com a gravação
  if (player) {
    const entries = await applyEffects(toolCtx, fx, { player, messageId: msgId }).catch((e) => (console.warn("[efeitos]", e), []));
    if (entries.length)
      await q(`UPDATE messages SET meta = meta || jsonb_build_object('notes', $1::jsonb, 'scribe', $2::jsonb) WHERE id = $3`, [
        JSON.stringify(entries.map((e) => e.note)),
        JSON.stringify(entries),
        msgId,
      ]);
    // marco do Resolvedor (domínio que subiu de faixa): quem está na cena viu
    for (const r of results.filter((x) => x.fact))
      await recordFact(campaignId, r.fact!, { sceneId: toolCtx.scene.id, messageId: msgId, minute: getClock(toolCtx.campaign.state)?.minutes ?? null }).catch((e) => console.warn("[fatos]", e));
    // beats, relógios, missão do beat e agenda (falhou = a história fica como estava; o turno vale)
    await afterTurn(toolCtx, fx.beat).catch((e) => console.warn("[história]", e));
  }
  indexHistory(campaignId).catch((e) => console.warn("[histórico]", e));
  emit({ type: "done" });
}

/**
 * Conversa particular encerrada (lib/npc): o Anotador lê as falas no lugar da narração e os efeitos (tempo, itens,
 * compra, missão, fatos com testemunhas = jogador + NPC) entram como no turno. Devolve as linhas do que ficou registrado.
 */
export async function conversationEffects(campaignId: string, npc: { id: string; name: string }, transcript: string): Promise<string[]> {
  const [campaign, scene, chars] = await Promise.all([getCampaign(campaignId), getCurrentScene(campaignId), getCharacters(campaignId)]);
  const player = chars.find((c) => c.kind === "player");
  if (!player) return [];
  const fx = await annotate(campaignId, transcript, effectsCtx(campaign, chars, null, scene.location), `conversa particular com ${npc.name}`);
  fx.options = [];
  fx.beat = null;
  fx.scene = { newScene: false, location: "", present: null }; // conversa não muda de lugar nem elenco
  // ponytail: sem desfazer pela etiqueta (messageId 0); o desfazer vale só para a última narração do Mestre
  // fatos da conversa: só o jogador e o NPC ficam sabendo
  const entries = await applyEffects({ campaign, scene, emit: () => {} }, fx, { player, messageId: 0, audience: [player.id, npc.id] });
  return entries.map((e) => e.summary);
}
