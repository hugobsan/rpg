import { q } from "./db";
import { type Advanced, getAdvanced } from "./advanced";
import { getAgent } from "./agents";
import { chat, ChatMessage, CHARS_PER_TOKEN, estimateTokens, ToolCall } from "./openrouter";
import { abilityPromptLine, currentMilestone, nextMilestone, rulesetPromptSummary } from "./ruleset";
import {
  activeDirectives,
  addMemory,
  ChunkHit,
  excerpt,
  formatHistory,
  HistoryHit,
  historyLine,
  indexHistory,
  MemoryHit,
  recentMemories,
  searchBookChunks,
  searchHistory,
  searchMemories,
  sceneNpcMemories,
} from "./retrieval";
import { listBooks } from "./books";
import { decideCast, decideElapsed, decideMoved, decideTurn, scoreImportance } from "./decisions";
import { attributeCap, attributePoints, controlLabel, costMultOf, powerLevel, progressionPromptLines } from "./progression";
import { formatClock, getClock, period } from "./clock";
import { hydrateSheets } from "./library";
import { getObjectives, objectivesPromptBlock, objectiveXp } from "./objectives";
import { getTable, modeHint, restRuleText, tablePromptBlock, xpRuleText } from "./table";
import { regenNotes, takeSnapshot } from "./turnSnapshot";
import { formatMoney } from "./money";
import { playerFixesLine, scribeState, scribeUndo, type ScribeEntry } from "./corrections";
import { CONTINUE_INPUT } from "./continueScene";
import {
  DEFERRED_TOOLS,
  executeGmTool,
  findNamed,
  GM_TOOLS,
  GM_TURN_TOOLS,
  saveClock,
  SCRIBE_TOOLS,
  setNpcsActive,
  ToolContext,
} from "./tools";
import {
  Campaign,
  CampaignScript,
  Character,
  Ruleset,
  Scene,
  TurnEvent,
} from "./types";

// sem acento, minúsculas, só letras e números separados por espaço: compara nomes ditos na ação e na narração
const normName = (s: string) =>
  s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

// ---------- carregamento de estado ----------

export async function getCampaign(id: string): Promise<Campaign> {
  const rows = await q<Campaign>(`SELECT * FROM campaigns WHERE id = $1`, [id]);
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

// ---------- montagem de contexto do Mestre ----------

/**
 * Ficha em texto. compact (contexto do turno do Mestre, que vai a cada chamada): efeito e requisito de cada técnica
 * e o passado do jogador encurtados; ficam marco atual e próximo (guiam a cena ao roteiro). O completo sai no get_character.
 * focus (texto da ação, da última narração e o que o Árbitro resolveu): só as técnicas citadas nele (nome inteiro ou a
 * parte depois de ":", sem acento nem caixa) vão completas; as outras numa linha com nome, rank, domínio e custo.
 */
export function sheetSummary(c: Character, full: boolean, rs: Ruleset, compact = false, focus?: string): string {
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
  const said = focus === undefined ? null : ` ${normName(focus)} `;
  const related = (name: string) => !said || [name, name.split(":").pop()!].some((n) => normName(n) && said.includes(` ${normName(n)} `));
  if (s.abilities.length)
    lines.push(
      `  habilidades${said ? " (completas as citadas na ação, na última narração ou resolvidas neste turno; as outras resumidas, inteiras no get_character)" : ""}:\n` +
        s.abilities
          .map((a) => {
            const brief = !related(a.name);
            let line = `    - ${abilityPromptLine(rs, a, compact ? 160 : Infinity, s, brief)}`;
            const cur = brief ? null : currentMilestone(a);
            const next = brief ? null : nextMilestone(a);
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
    if (s.inventory.length)
      lines.push(`  inventário: ${s.inventory.map((i) => `${i.qty}x ${i.name}`).join(", ")}`);
    const p = c.persona;
    // perfil rico do Criador, enxuto (vai a cada rodada; o completo sai no get_character)
    const cut = (t: string, n: number) => (t.length > n ? `${t.slice(0, n).trimEnd()}…` : t);
    const who = [p.role, p.age].filter(Boolean).join(", ");
    if (who) lines.push(`  ${cut(who, 140)}`);
    if (p.personality) lines.push(`  personalidade: ${p.personality}`);
    if (p.speech) lines.push(`  jeito de falar: ${cut(p.speech, 200)}`);
    if (p.relationships) lines.push(`  relações: ${cut(p.relationships, 240)}`);
    if (p.current) lines.push(`  situação atual (vale mais que o passado): ${p.current}`);
    if (p.backstory) lines.push(`  passado: ${c.kind === "npc" || compact ? cut(p.backstory, compact ? 300 : 400) : p.backstory}`);
    if (p.goals) lines.push(`  objetivos: ${p.goals}`);
    if (p.secrets) lines.push(`  segredos (só você sabe): ${p.secrets}`);
  }
  return lines.join("\n");
}

const STYLE_INSTRUCTIONS: Record<string, string> = {
  open: `ESTILO DA CAMPANHA: ABERTO. O jogador descreve livremente o que faz. NÃO ofereça bloco de opções, exceto em raras decisões binárias dramáticas.`,
  hybrid: `ESTILO DA CAMPANHA: HÍBRIDO. Em cenas normais, termine com um bloco de 3-4 opções de ação plausíveis (o jogador também pode digitar livremente). Em diálogos com NPCs, não ofereça opções — deixe o jogador falar com as próprias palavras.`,
  guided: `ESTILO DA CAMPANHA: GUIADO. A história é controlada e verossímil: SEMPRE termine com um bloco de 2-4 opções concretas e coerentes com as capacidades do personagem. O jogador escolhe entre elas; só cenários realmente interativos (diálogos) dispensam opções.`,
};


async function buildGmSystem(
  campaign: Campaign,
  scene: Scene,
  chars: Character[],
  memories: MemoryHit[],
  past: string, // trechos antigos do chat aprovados pelo Jev (formatHistory)
  basePrompt: string,
  resolved: string[] = [], // o que o Árbitro resolveu antes do Mestre (ferramenta args → resultado)
  books = "", // trechos dos livros de referência aprovados pelo Jev
  focus?: string // ação, última narração e técnicas resolvidas: escolhe as técnicas do jogador que vão completas
): Promise<[fixed: string, turn: string]> {
  const player = chars.find((c) => c.kind === "player");
  const activeNpcs = chars.filter((c) => c.kind === "npc" && c.active);
  const inactiveNames = chars
    .filter((c) => c.kind === "npc" && !c.active)
    .map((c) => c.name);

  // roteiro: arco ativo, ponto atual (última nota), próximos eventos e o arco seguinte, para não gastar uma rodada no get_script
  const arcs = campaign.script?.arcs ?? [];
  const arcIdx = arcs.findIndex((a) => a.status === "active");
  const activeArc = arcs[arcIdx];
  const ahead = arcs.slice(arcIdx + 1).filter((a) => a.status !== "done");
  const nextEvents = ahead.flatMap((a) => a.canonEvents).slice(0, 2);
  const clock = getClock(campaign.state);
  const directives = await activeDirectives(campaign.id);
  // o que o Escrivão gravou depois da narração anterior (meta.notes da última mensagem do Mestre)
  const [last] = await q<{ notes: string[] | null }>(
    `SELECT meta->'notes' AS notes FROM messages WHERE campaign_id = $1 AND role = 'gm' ORDER BY id DESC LIMIT 1`,
    [campaign.id]
  );
  const lastNotes = Array.isArray(last?.notes) ? last.notes : [];
  // cena nova ainda sem resumo: o fim do último resumo de cena, para o Mestre não perder o fio
  const [before] = scene.summary
    ? []
    : await q<{ summary: string }>(
        `SELECT summary FROM scenes WHERE campaign_id = $1 AND seq < $2 AND summary <> '' ORDER BY seq DESC LIMIT 1`,
        [campaign.id, scene.seq]
      );

  // o que não muda de um turno para outro na campanha: com o cache ligado no Mestre, é o ponto de cache entre turnos
  const fixed = [
    basePrompt,
    `\n====== CAMPANHA: ${campaign.name} ======`,
    STYLE_INSTRUCTIONS[campaign.style] || STYLE_INSTRUCTIONS.hybrid,
    `\n--- MECÂNICA ---\n${rulesetPromptSummary(campaign.ruleset)}`,
    "Biblioteca do mundo: técnicas e itens já criados (search_library). add_ability só precisa de personagem, nome e brief: a técnica vem da biblioteca ou o Criador de habilidades a cria completa (tipo, rank, efeito, dano, marcos; o custo vem do rank); não invente esses números.",
    "Ao abrir cena nova ou mudar de local (set_scene), informe present com todos os NPCs que estão lá: quem ficar de fora sai de cena.",
    "search_history busca no chat inteiro da campanha (turnos e conversas com NPCs, com dia, hora e local): use para lembrar exatamente o que alguém disse ou fez, ou detalhes antigos que não viraram memória.",
    "O estado do turno (cena, hora, personagens, memórias) chega numa mensagem de contexto logo antes da ação do jogador.",
    // cada ferramenta chamada antes do texto custa outra rodada com o prompt inteiro
    `Anotações (${[...DEFERRED_TOOLS].join(", ")}) só valem depois da narração: chame-as junto da narração, no fim da resposta, nunca antes dela. Dano, cura e gasto de recurso, itens ganhos ou perdidos, XP, domínio por evento, memórias e missões o Escrivão registra sozinho depois, pelo que a narração mostra: narre com números claros (quem perdeu quanto, o que pegou ou entregou). advance_time também é anotação e é opcional: depois da narração o sistema anda o relógio pelo tempo que ela mostra, então diga no texto quanto passou; use advance_time só para fixar a duração exata.`,
  ];
  const parts = [
    tablePromptBlock(getTable(campaign.state)),
    `\n--- CENA ATUAL (nº ${scene.seq}) ---\nModo: ${scene.mode} | Local: ${scene.location || "?"} | Título: ${scene.title || "-"}\n${
      clock
        ? `Hora na história: ${formatClock(clock.minutes)} (${period(clock.minutes)})`
        : "Hora na história: AINDA NÃO DEFINIDA. Chame set_time neste turno com uma hora coerente com a história até aqui."
    }\nMODO DA CENA (${scene.mode}): ${modeHint(getTable(campaign.state), scene.mode)}${
      scene.summary
        ? `\nResumo do que já aconteceu nesta cena (compactado): ${scene.summary}`
        : before
          ? `\nAntes desta cena (fim do resumo da anterior): ${before.summary.slice(-1200)}`
          : ""
    }`,
    objectivesPromptBlock(
      getObjectives(campaign.state),
      clock?.minutes ?? null,
      (o) => objectiveXp(o, campaign.ruleset, getTable(campaign.state), player?.sheet.xp ?? 0),
      campaign.ruleset.currency && ((n) => formatMoney(n, campaign.ruleset.currency!))
    ),
    player
      ? `\n--- PERSONAGEM DO JOGADOR ---\n${sheetSummary(player, true, campaign.ruleset, true, focus)}`
      : "",
    activeNpcs.length
      ? `\n--- NPCs EM CENA ---\n${activeNpcs.map((n) => sheetSummary(n, true, campaign.ruleset, true)).join("\n")}`
      : "\n--- NPCs EM CENA ---\n(nenhum)",
    inactiveNames.length
      ? `NPCs conhecidos fora de cena (não interagem; reative com set_npc_active, e antes de trazer um deles de volta consulte search_memories com subject = o nome dele: o que ele já viveu com o jogador): ${inactiveNames.join(", ")}`
      : "",
    activeArc
      ? [
          `\n--- ROTEIRO: ARCO ATIVO (${arcIdx + 1}º de ${arcs.length}) ---\n${activeArc.title}: ${activeArc.summary}`,
          `Eventos canônicos deste arco: ${activeArc.canonEvents.join(" | ") || "-"}`,
          `Ganchos: ${activeArc.hooks.join(" | ") || "-"}`,
          `Ponto atual: ${activeArc.notes.at(-1) ?? "começo do arco (nenhuma nota de progresso ainda)"}`,
          activeArc.notes.length > 1 ? `Notas anteriores: ${activeArc.notes.slice(-5, -1).join(" | ")}` : "",
          nextEvents.length ? `Próximos eventos canônicos (depois deste arco): ${nextEvents.join(" | ")}` : "",
          ahead[0] ? `Arco seguinte: ${ahead[0].title}: ${ahead[0].summary.length > 220 ? `${ahead[0].summary.slice(0, 220).trimEnd()}…` : ahead[0].summary}` : "Arco seguinte: nenhum (é o último)",
          "(premissa e ganchos do arco seguinte: get_script; roteiro inteiro: get_script com full=true)",
        ]
          .filter(Boolean)
          .join("\n")
      : "",
    memories.length
      ? `\n--- MEMÓRIAS RELEVANTES ---\n${memories
          .map((m) => `[${m.kind}${m.subject ? `/${m.subject}` : ""}] ${m.content}`)
          .join("\n")}`
      : "",
    past ? `\n--- TRECHOS ANTIGOS DO CHAT (lembrados para esta ação) ---\n${past}` : "",
    books ? `\n--- TRECHOS DOS LIVROS DE REFERÊNCIA (buscados para esta ação; a página inteira com read_pages) ---\n${books}` : "",
    lastNotes.length
      ? `\n--- O ESCRIVÃO REGISTROU DEPOIS DA SUA ÚLTIMA NARRAÇÃO (já está nas fichas; reconheça na história se for marcante, como um marco de domínio ou nível novo) ---\n${lastNotes.map((n) => `- ${n}`).join("\n")}`
      : "",
    playerFixesLine(campaign.state),
    directives.length
      ? `\n--- DIRETRIZES DO JOGADOR (fora do jogo) — siga ---\n${directives
          .map((d) => `- ${d.content}${d.subject === "proxima_cena" ? " (vale nesta cena e na próxima)" : ""}`)
          .join("\n")}`
      : "",
    resolved.length
      ? `\n--- JÁ RESOLVIDO NESTE TURNO (resultado final: narre a partir dele e não chame essas ferramentas de novo) ---\n${resolved.map((r) => `- ${r}`).join("\n")}`
      : "",
    // por último, colado na ação: o estado acima é mecânico e puxava a narração para o tom de relatório
    "\n(Narração: calibre pelo momento, como em NARRAÇÃO. Cheia, de 4 a 7 parágrafos, em chegada, descoberta, viagem, entrega e resultado de missão e começo ou fim de um trecho do dia, com os NPCs da cena agindo e falando; curta e interativa, de 1 a 3 parágrafos, em troca de falas e batalha.)",
  ];
  return [fixed.filter(Boolean).join("\n"), parts.filter(Boolean).join("\n")];
}

/**
 * Conversa particular encerrada (linha 'talk' que lib/npc grava ao fechar), como o Mestre a vê no histórico e na
 * compactação: fica no lugar dela entre os turnos, com o começo e o fim da conversa, a fala de encerramento do NPC e o
 * que o Escrivão registrou. A conversa inteira está no search_history.
 */
function talkNote(m: { speaker: string | null; meta: { tail?: string; notes?: string[]; farewell?: string } | null }): string {
  const { tail, notes, farewell } = m.meta ?? {};
  return [
    `(Nota do sistema: o jogador conversou em particular com ${m.speaker}, fora da sua narração. Continue a cena de onde a conversa parou, sem repetir as falas; ela inteira está no search_history.)`,
    tail || "",
    farewell ? `${m.speaker}, ao encerrar: ${farewell}` : "",
    notes?.length ? `O Escrivão já registrou:\n${notes.map((n) => `- ${n}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Candidatas a memória do turno: top-k por similaridade + as mais importantes/recentes (Configurações avançadas). */
async function candidateMemories(campaignId: string, playerInput: string, adv: Advanced): Promise<MemoryHit[]> {
  const [relevant, recent] = await Promise.all([
    playerInput ? searchMemories(campaignId, playerInput, { limit: adv.memory.topK, maxDistance: adv.memory.maxDistance }) : Promise.resolve([]),
    recentMemories(campaignId, adv.memory.recentK),
  ]);
  const seen = new Set<number>();
  return [...relevant, ...recent].filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
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

/**
 * Onde começa a janela de histórico (tamanhos em caracteres, do mais antigo ao mais novo). O começo só anda em
 * saltos de 1/4 do orçamento, contados desde a 1ª mensagem: fica igual por vários turnos, e o cache do histórico vale
 * de um turno para o outro (uma janela que perde a mais antiga a cada turno muda o começo e regrava tudo).
 * O que sobra fica entre 3/4 do orçamento (menos uma mensagem) e o orçamento inteiro.
 */
export function windowStart(lengths: number[], budget: number): number {
  const total = lengths.reduce((a, n) => a + n, 0);
  const step = Math.max(Math.round(budget / 4), 1); // saltos de 1/4: a janela nunca cai abaixo de 3/4 do orçamento
  const cut = Math.ceil(Math.max(total - budget, 0) / step) * step;
  let before = 0;
  for (let i = 0; i < lengths.length; i++) {
    if (before >= cut) return i;
    before += lengths[i];
  }
  return lengths.length;
}

/** Histórico recente não compactado dentro do orçamento de tokens, começando numa fala do jogador. */
async function historyWindow(campaignId: string, budgetTokens: number): Promise<ChatMessage[]> {
  // a compactação do Cronista mantém poucas mensagens não compactadas; elas vêm todas para o começo ser estável
  const rows = (
    await q<{ role: string; speaker: string | null; content: string; meta: Parameters<typeof talkNote>[0]["meta"] }>(
      `SELECT role, speaker, content, meta FROM messages
       WHERE campaign_id = $1 AND role IN ('player','gm','system','talk') AND NOT compacted
       ORDER BY id`,
      [campaignId]
    )
  ).map((m) => (m.role === "talk" ? { ...m, content: talkNote(m) } : m));
  let i = windowStart(rows.map((m) => m.content.length), budgetTokens * CHARS_PER_TOKEN);
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

/** Resposta imediata de uma anotação (DEFERRED_TOOLS): ela roda depois da narração. */
const NOTED = "Anotado: será aplicado depois da narração.";

const argsOf = (c: ToolCall): Record<string, unknown> => {
  try {
    return JSON.parse(c.function.arguments || "{}");
  } catch {
    return {};
  }
};

function parseChoices(text: string): { clean: string; choices: string[] } {
  const m = text.match(/```choices\s*([\s\S]*?)```/);
  if (!m) return { clean: text.trim(), choices: [] };
  let choices: string[] = [];
  try {
    const parsed = JSON.parse(m[1].trim());
    if (Array.isArray(parsed)) choices = parsed.map(String).slice(0, 6);
  } catch {
    /* bloco malformado: ignora */
  }
  return { clean: text.replace(m[0], "").trim(), choices };
}

/**
 * Parte da narração que já pode ir ao jogador durante o streaming: corta no bloco ```choices e
 * segura um começo de cerca no fim ("`", "``", "```cho"...) até saber se é o bloco de opções.
 */
export function visibleNarration(text: string): string {
  const fence = "```choices";
  const i = text.indexOf(fence);
  if (i >= 0) return text.slice(0, i);
  for (let k = Math.min(fence.length - 1, text.length); k > 0; k--)
    if (fence.startsWith(text.slice(-k))) return text.slice(0, -k);
  return text;
}

export async function runTurn(
  campaignId: string,
  playerInput: string,
  emit: (e: TurnEvent) => void,
  // "gerar novamente": o estado já foi restaurado; feedback = motivo opcional do jogador
  regen?: { feedback: string },
  // "parar" do jogador: vale só até a narração ser salva. Abortado, lança signal.reason (sempre depois da foto e da
  // ação salvas: quem chama volta a foto); depois da narração é ignorado e o pós-narração (Escrivão etc.) segue
  signal?: AbortSignal,
  // pergunta ao Jev se a ação é fala fora do jogo sobre o registro (não no gerar novamente nem ao editar a ação)
  askMeta = !regen,
  // pergunta se a fala é só com um NPC (vai ao chat dele); false = o jogador já disse que era da cena
  askTalk = askMeta
): Promise<void> {
  // status por fase: a tela acende "consultando", "dados" e "escrevendo" por estas palavras
  emit({ type: "status", text: "Lendo a cena..." });
  // a busca de memórias (embedding da ação, ida à rede) corre junto da foto e das leituras do banco
  const adv = await getAdvanced(); // cache no processo
  const candidatesP = candidateMemories(campaignId, playerInput, adv);
  // o que os NPCs em cena já viveram (com o jogador): não depende das palavras da ação, então não passa pelo filtro do Jev
  const npcMemP = sceneNpcMemories(campaignId).catch((): MemoryHit[] => []);
  candidatesP.catch(() => {}); // o erro sobe no await abaixo, sem virar rejeição solta antes dele
  // até autoTopK (2) trechos antigos do chat muito parecidos com a ação: só entram se o Jev aprovar com folga
  const pastP = playerInput && adv.history.autoTopK
    ? searchHistory(campaignId, playerInput, { limit: adv.history.autoTopK, auto: true }).catch((): HistoryHit[] => [])
    : Promise.resolve([]);
  // com livros indexados, os 2 trechos mais próximos da ação já vêm buscados; só entram se o Jev disser que a ação precisa
  const acting = !!playerInput && playerInput !== CONTINUE_INPUT;
  const booksP = acting ? listBooks(campaignId).catch(() => []) : Promise.resolve([]);
  const bookHitsP = booksP.then((b) => (b.length ? searchBookChunks(campaignId, playerInput, 2) : [])).catch((): ChunkHit[] => []);
  const [campaign, firstScene, chars, gm] = await Promise.all([
    getCampaign(campaignId),
    getCurrentScene(campaignId),
    getCharacters(campaignId),
    getAgent("gm"),
  ]);
  let scene = firstScene;
  const params = gm.params as { historyBudgetTokens?: number; maxToolRounds?: number; complexModel?: string; reasoning?: unknown };
  const complexModel = params.complexModel?.trim();

  const [history, candidates, pastHits, books] = await Promise.all([
    historyWindow(campaignId, params.historyBudgetTokens ?? 9000),
    candidatesP,
    pastP,
    booksP,
  ]);

  // Jev, numa chamada só: modelo do turno (1), busca web (2), filtro de memórias (4), Árbitro (6) e fora do jogo
  const activeArc = campaign.script?.arcs.find((a) => a.status === "active");
  const lastGm = [...history].reverse().find((m) => m.role === "assistant");
  const lastGmText = typeof lastGm?.content === "string" ? lastGm.content : "";
  const player = chars.find((c) => c.kind === "player");
  const decision = await decideTurn(
    {
      setting: { name: campaign.ruleset.name, canonBased: !!campaign.ruleset.canonBased },
      scene: { mode: scene.mode, location: scene.location, title: scene.title, summary: scene.summary },
      activeArc: activeArc
        ? `${activeArc.title}: ${activeArc.summary} Eventos canônicos: ${activeArc.canonEvents.join(" | ") || "-"}`
        : null,
      npcsInScene: Object.fromEntries(
        chars
          .filter((c) => c.kind === "npc" && c.active)
          .map((c) => [c.name, [c.persona.personality, c.sheet.abilities.map((a) => a.name).join(", ")].filter(Boolean).join(" | ")])
      ),
      lastGmNarration: lastGmText,
      playerAction: playerInput,
      // pergunta do Árbitro: a ação usa uma destas técnicas ou é treino?
      playerAbilities: player && playerInput !== CONTINUE_INPUT ? player.sheet.abilities.map((a) => a.name) : undefined,
      memories: candidates,
      history: pastHits.map((h) => ({ id: h.id, text: historyLine(h, playerInput, adv.history.excerptChars) })),
      askComplexity: !!complexModel && complexModel !== gm.model,
      askWeb: gm.web_search,
      askMeta: askMeta && playerInput !== CONTINUE_INPUT,
      // batalha e treino: a fala com o NPC faz parte da atividade que o Mestre conduz (dados, recursos, progresso)
      askTalk: askTalk && playerInput !== CONTINUE_INPUT && scene.mode !== "battle" && scene.mode !== "training",
      books: books.map((b) => b.title),
    },
    campaignId
  );
  // pergunta ou reclamação sobre o registro (ficha, missões, XP...): vai à conversa fora do jogo, que tem as ferramentas
  // de correção, sem turno do Mestre (~20 mil tokens) nem Escrivão; nada fica em messages nem na foto do turno anterior.
  // Fora do jogo falhou = turno normal. import dinâmico: ooc.ts importa este arquivo
  if (decision.meta) {
    emit({ type: "status", text: "Fora do jogo: o Mestre está respondendo..." });
    const answered = await (await import("./ooc")).oocTalk(campaignId, playerInput).catch((e) => console.warn("[fora do jogo]", e));
    if (answered) {
      emit({ type: "ooc" });
      emit({ type: "done" });
      return;
    }
  }
  // fala só com um NPC em cena: vai ao chat dele (agente NPC, ~3 mil tokens, com o perfil inteiro) em vez do turno do
  // Mestre (~20 mil); a fala é a 1ª mensagem e a tela abre a conversa. Como no meta, nada em messages nem na foto.
  // O registro (Escrivão) e o relógio ficam para quando a conversa fechar (lib/npc endNpcChat). Recusa ou falha = turno normal
  const talkNpc = decision.talk ? chars.find((c) => c.kind === "npc" && c.active && c.name === decision.talk) : undefined;
  if (talkNpc) {
    emit({ type: "status", text: `Conversa particular: ${talkNpc.name} está respondendo...` });
    const r = await (await import("./npc")).npcTalk(campaignId, talkNpc.id, null, playerInput, true).catch((e) => console.warn("[conversa com NPC]", e));
    if (r && !r.refused) {
      emit({ type: "npc_talk", npcId: talkNpc.id, sessionId: r.sessionId, messages: [{ role: "player", content: playerInput }, { role: "npc", content: r.reply }] });
      emit({ type: "done" });
      return;
    }
  }
  // foto do estado antes do turno, para poder gerar a resposta de novo depois (depois do Jev: a fala fora do jogo
  // não apaga a foto do turno anterior); a ação entra no chat depois dela
  // gerar novamente: os motivos anteriores desta mesma ação continuam valendo (pedir uma coisa não desfaz a anterior)
  const reasons = regen ? [...(await regenNotes(campaignId)), regen.feedback.trim()].filter(Boolean) : [];
  await takeSnapshot(campaignId, playerInput, reasons);
  await saveMessage(campaignId, scene.id, "player", playerInput);
  // modelo decidido uma vez e mantido em todas as rodadas; falha do Jev = modelo principal
  const turnModel = complexModel && decision.complex ? complexModel : gm.model;
  // falha do Jev = web conforme o agente
  const useWeb = gm.web_search && decision.web !== false;
  const keptMem = candidates.filter((m) => decision.keepMemory(m.id, m.importance));
  const memories = [...keptMem, ...(await npcMemP).filter((m) => !keptMem.some((k) => k.id === m.id))];
  const past = pastHits.filter((h) => decision.keepHistory(h.id));
  // trechos curtos (~700 caracteres, a janela com mais termos da ação), com título e página para o read_pages
  const bookText = decision.book
    ? (await bookHitsP).map((h) => `[${h.title} | bookId=${h.book_id} | pág. ${h.page}]\n${excerpt(h.content, playerInput, 700)}`).join("\n---\n")
    : "";

  const toolCtx: ToolContext = { campaign, scene, emit };
  // Árbitro: técnica da ficha ou treino resolvidos antes do Mestre, que narra numa chamada só. Jev falhou = não roda
  const settled =
    decision.mechanic && player
      ? await runReferee(campaignId, toolCtx, player, chars, playerInput, lastGmText).catch((e): Settled[] => {
          console.warn("[árbitro]", e);
          return [];
        })
      : [];
  const settledLine = (r: Settled) => `${r.name} ${JSON.stringify(r.args)} → ${r.output}`;

  const [fixed, turn] = await buildGmSystem(
    campaign,
    scene,
    chars,
    memories,
    past.length ? formatHistory(past, playerInput, adv.history.excerptChars) : "",
    gm.system_prompt,
    settled.map(settledLine),
    bookText,
    [playerInput, lastGmText, ...settled.map((r) => String(r.args.ability ?? r.args.target ?? ""))].join("\n")
  );
  // a janela foi lida antes de salvar a ação: ela vem depois do contexto do turno
  if (history.length) history[history.length - 1] = { ...history[history.length - 1], cache: true };
  // ordem para o cache (Claude e OpenAI reaproveitam o começo igual ao da chamada anterior): o que não muda na
  // campanha, o histórico (só cresce no fim; o ponto de cache dele é lido no próximo turno) e, por último, o
  // contexto do turno, que muda a cada ação. Antes o contexto vinha antes do histórico e o regravava todo turno.
  const messages: ChatMessage[] = [
    { role: "system", content: fixed },
    ...history,
    { role: "user", content: `(Contexto do turno, montado pelo sistema; não é fala do jogador)\n${turn}` },
    { role: "user", content: playerInput },
  ];
  if (playerInput === CONTINUE_INPUT) {
    messages[messages.length - 1].content =
      "(Nota do sistema, fora do jogo: o jogador não age neste turno e pediu para você continuar a cena.\n" +
      "Se a sua narração anterior terminou esperando uma ação, fala ou decisão do personagem dele, não avance por ele: " +
      "responda só com uma linha curta mostrando que a cena segue aguardando, como \"Fulano ainda espera sua resposta.\" " +
      "ou \"Eles continuam ali, aguardando sua reação.\", sem novas opções além das que já estavam na mesa.\n" +
      "Se não, siga a cena adiante (o que os NPCs fazem, o que acontece, o tempo que passa) até um ponto em que o personagem tenha algo a fazer.)";
  }
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

  const maxRounds = params.maxToolRounds ?? 8;
  let finalText = "";
  // narração de rodadas que também chamaram ferramentas (ex.: narra e chama advance_time no fim):
  // vale como parte da resposta; a rodada seguinte continua dela
  let kept = "";
  let keptChoices: string[] = [];
  let finalChoices: string[] = [];
  let timeMoved = settled.some((r) => r.name === "train"); // o Mestre (ou o Árbitro) chamou advance_time/set_time/train neste turno
  const deferred: ToolCall[] = []; // anotações do Mestre (DEFERRED_TOOLS), aplicadas depois da narração
  // o que as ferramentas do Árbitro e do Mestre já fizeram, para o Escrivão não repetir
  const done: string[] = settled.map((r) => settledLine(r).slice(0, 300));
  // técnica e treino do jogador que o Árbitro resolveu: o Mestre não repete
  const already = new Map(settled.filter((r) => r.name !== "roll_dice").map((r) => [settleKey(r.name, r.args), r.output]));

  for (let round = 0; round <= maxRounds; round++) {
    // narração em streaming: o texto da rodada vai ao jogador enquanto chega, depois do que já ficou; nunca é descartado
    let roundText = "";
    let streamed = 0;
    signal?.throwIfAborted();
    emit({ type: "status", text: "O Mestre está pensando..." });
    // :online só na 1ª rodada: o plugin cobra por requisição e repetiria a mesma busca a cada rodada
    const result = await chat({
      model: turnModel,
      messages,
      temperature: gm.temperature,
      max_tokens: gm.max_tokens,
      // sem params.reasoning, o chat() põe esforço médio nos GPT (sem ele narravam sem raciocinar)
      reasoning: params.reasoning as Record<string, unknown> | undefined,
      tools: GM_TURN_TOOLS,
      // última rodada só em texto: uma chamada pedida aqui seria descartada e a narração pararia no meio
      noTools: round === maxRounds,
      webSearch: useWeb && round === 0,
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

    const told = parseChoices(result.content || "");
    // narração com só anotações junto: elas ficam para depois e o turno acaba aqui, sem outra chamada ao modelo
    const notesOnly = result.toolCalls.length > 0 && !!told.clean && result.toolCalls.every((c) => DEFERRED_TOOLS.has(c.function.name));
    if (!result.toolCalls.length || notesOnly || round === maxRounds) {
      deferred.push(...result.toolCalls.filter((c) => DEFERRED_TOOLS.has(c.function.name)));
      finalText = [kept, told.clean].filter(Boolean).join("\n\n");
      finalChoices = told.choices.length ? told.choices : keptChoices;
      break;
    }
    // texto junto das ferramentas: o jogador já leu, então fica (as opções valem se a próxima rodada não trouxer outras)
    if (told.clean) kept = [kept, told.clean].filter(Boolean).join("\n\n");
    if (told.choices.length) keptChoices = told.choices;
    const sources = useWeb && round === 0 ? webSources(result.raw) : "";
    messages.push({
      role: "assistant",
      content: [result.content, sources && `[Fontes da busca web]\n${sources}`].filter(Boolean).join("\n\n") || null,
      tool_calls: result.toolCalls,
    });
    for (const call of result.toolCalls) {
      if (DEFERRED_TOOLS.has(call.function.name)) {
        deferred.push(call);
        messages.push({ role: "tool", content: NOTED, tool_call_id: call.id, name: call.function.name });
        continue;
      }
      let output: string;
      try {
        const args = JSON.parse(call.function.arguments || "{}");
        // tools de leitura emitem aqui (intenção); escrita e dados emitem no executor (resultado)
        if (/^(search_|read_|get_|list_)/.test(call.function.name)) {
          if (/^(search_|read_|get_script)/.test(call.function.name))
            emit({ type: "status", text: "Consultando memórias e livros..." });
          emit({
            type: "tool",
            name: call.function.name,
            summary: toolSummary(call.function.name, args),
          });
        }
        // ponytail: um segundo uso legítimo da mesma técnica (ou treino do mesmo alvo) no mesmo turno também fica bloqueado
        const again = player && findNamed([player], String(args.character ?? "")).length ? already.get(settleKey(call.function.name, args)) : undefined;
        if (again) output = `Já resolvido neste turno: ${again}`;
        else {
          if (/^((advance|set)_time|train)$/.test(call.function.name)) timeMoved = true;
          output = await executeGmTool(call.function.name, args, toolCtx);
          scene = toolCtx.scene; // set_scene pode ter trocado a cena
        }
      } catch (e) {
        output = `Erro: ${e instanceof Error ? e.message : String(e)}`;
      }
      if (!/^(search_|read_|get_|list_)/.test(call.function.name) && !output.startsWith("Já resolvido neste turno")) done.push(`${call.function.name} ${call.function.arguments} → ${output.slice(0, 300)}`);
      messages.push({
        role: "tool",
        content: output,
        tool_call_id: call.id,
        name: call.function.name,
      });
    }
    if (told.clean)
      messages[messages.length - 1].content +=
        "\n\n(Sistema, fora do jogo: o jogador já está lendo o texto que você escreveu junto destas ferramentas. Continue dele sem repetir nada; se a narração já estiver completa, escreva só o que faltar, como o bloco de opções.)";
    if (round + 1 === maxRounds)
      messages[messages.length - 1].content +=
        "\n\n(Sistema, fora do jogo: acabaram as ferramentas deste turno. Narre agora o que já foi resolvido acima; o que ficou sem teste não aconteceu ainda e fica como opção para o próximo turno.)";
  }

  const choices = finalChoices;
  const narration = finalText || "*(O Mestre ficou em silêncio — tente novamente.)*";
  const msgId = await saveMessage(campaignId, scene.id, "gm", narration, { choices });
  emit({ type: "narration", content: narration, messageId: msgId });
  if (choices.length) emit({ type: "choices", choices });

  // depois da narração (o jogador já está lendo); antes do done, para o "gerar novamente" não cruzar com a gravação.
  // Anotações primeiro: só SQL, e o local e o elenco abaixo leem o que set_scene marcou (sceneChanged, castSet)
  if (deferred.some((c) => /^(advance|set)_time$/.test(c.function.name))) timeMoved = true; // o Mestre mexeu no relógio: sem o Jev
  const applyNote = (call: ToolCall) =>
    executeGmTool(call.function.name, argsOf(call), toolCtx).catch((e) => console.warn(`[anotação] ${call.function.name}:`, e));
  for (const call of deferred) {
    if (call.function.name === "note_objective") continue; // Escrivão, abaixo
    await applyNote(call);
  }
  scene = toolCtx.scene;
  const briefs = deferred.filter((c) => c.function.name === "note_objective").map((c) => String(argsOf(c).brief || "")).filter(Boolean);
  await Promise.all([
    maybeCompact(campaignId, scene, emit).catch(() => {}),
    // Escrivão depois do relógio: prazo relativo de missão conta da hora nova e as gravações de objetivos não se cruzam
    (timeMoved ? Promise.resolve() : fallbackClock(campaignId, campaign, scene, playerInput, narration, emit).catch(() => {}))
      .then(() => runScribe(campaignId, toolCtx, playerInput, narration, done, briefs, msgId))
      // junto da narração: o próximo turno mostra ao Mestre (notes) e a etiqueta desfaz (scribe); o "gerar novamente" apaga com a mensagem
      .then(async (entries) => {
        if (entries.length)
          await q(`UPDATE messages SET meta = meta || jsonb_build_object('notes', $1::jsonb, 'scribe', $2::jsonb) WHERE id = $3`, [
            JSON.stringify(entries.map((e) => e.note)),
            JSON.stringify(entries),
            msgId,
          ]);
      })
      .catch((e) => console.warn("[escrivão]", e)),
    // local antes do elenco: quem continua na cena é julgado já no lugar novo
    fallbackPlace(campaignId, toolCtx, playerInput, narration)
      .catch(() => {})
      .then(() => fallbackCast(campaignId, toolCtx, playerInput, narration, emit))
      .catch(() => {}),
  ]);
  // o turno entra no histórico vetorial sem segurar o done; um "gerar novamente" no meio não deixa sobra (FK com CASCADE)
  indexHistory(campaignId).catch((e) => console.warn("[histórico]", e));
  emit({ type: "done" });
}

/**
 * Quem fala no formato **Nome:** e não bate com nenhum personagem registrado.
 * Compara o 1º nome sem honoríficos ("Iruka-sensei" = "Iruka Umino"); "Hugo (como Daiki)" conta como Hugo.
 */
export function unregisteredSpeakers(text: string, chars: { name: string }[]): string[] {
  const out = new Set<string>();
  for (const name of speakers(text)) if (!findNamed(chars, name).length) out.add(name.replace(/\s*\(.*?\)/g, ""));
  return [...out];
}

/** Nomes que falam no formato **Nome:** no começo da linha. */
const speakers = (text: string) => [...text.matchAll(/^\s*\*\*([^*\n]{2,40}?):\*\*/gm)].map((m) => m[1].trim());

/**
 * Elenco depois da narração. NPC registrado fora de cena que fala volta (sem IA). Se o Mestre não
 * informou present, o Jev diz quem dos ativos calados ainda está ali; os outros saem. Jev falhou = ninguém sai.
 * Roda todo turno com NPC calado em cena, não só na troca de cena: custa ~US$0,00005, corre junto do
 * relógio depois da narração e pega o "fulano foi embora" que o Mestre esqueceu.
 */
export async function fallbackCast(
  campaignId: string,
  ctx: ToolContext,
  playerInput: string,
  narration: string,
  emit: (e: TurnEvent) => void
): Promise<void> {
  const npcs = (await getCharacters(campaignId)).filter((c) => c.kind === "npc");
  const talking = new Set(speakers(narration).flatMap((n) => findNamed(npcs, n).map((c) => c.id)));
  // quem fala está na cena, a menos que o jogador tenha mudado de lugar depois: aí o Jev julga quem falou também
  const ask = ctx.castSet ? [] : npcs.filter((c) => (c.active || talking.has(c.id)) && (ctx.sceneChanged || !talking.has(c.id)));
  const gone = ask.length
    ? await decideCast(
        {
          scene: { mode: ctx.scene.mode, location: ctx.scene.location, title: ctx.scene.title },
          sceneChanged: !!ctx.sceneChanged,
          playerAction: playerInput,
          gmNarration: narration,
          npcs: ask.map((c) => c.name),
        },
        campaignId
      )
    : [];
  const left = (c: { name: string }) => !!gone?.includes(c.name);
  await setNpcsActive(campaignId, npcs.filter((c) => !c.active && talking.has(c.id) && !left(c)), true, emit);
  await setNpcsActive(campaignId, npcs.filter((c) => c.active && left(c)), false, emit);
}

/**
 * O Mestre não abriu cena nem trocou o local no turno (quase nunca abre): o Jev julga, numa chamada, se a narração
 * levou o jogador a outro lugar e que modo ela mostra. Mudou de lugar: o Cronista dá o nome e o set_scene abre cena
 * nova ali, já no modo novo. Ficou: só o modo muda, se o Mestre não o trocou.
 * Falhou = nada muda.
 */
export async function fallbackPlace(campaignId: string, ctx: ToolContext, playerInput: string, narration: string): Promise<void> {
  if (ctx.sceneChanged) return;
  const place = await decideMoved(
    { scene: { mode: ctx.scene.mode, location: ctx.scene.location }, playerAction: playerInput, gmNarration: narration },
    campaignId
  );
  if (!place) return;
  const mode = !ctx.modeSet && place.mode && place.mode !== ctx.scene.mode ? place.mode : undefined;
  const location = place.moved ? await namePlace(campaignId, ctx, narration).catch(() => null) : null;
  // título vazio: o cabeçalho mostra o local, e um título velho não fica preso na cena nova
  if (location) await executeGmTool("set_scene", { newScene: true, location, ...(mode && { mode }) }, ctx);
  else if (mode) await executeGmTool("set_scene", { mode }, ctx);
}

/** Cronista: nome do lugar onde o jogador está no fim da narração (reaproveita os locais das cenas); null = não sabe. */
async function namePlace(campaignId: string, ctx: ToolContext, narration: string): Promise<string | null> {
  const [chronicler, places, [player]] = await Promise.all([
    getAgent("chronicler"),
    // os 40 locais de cena mais recentes, sem repetir; a cena de abertura nasce com o ponto de partida, que não é um lugar
    q<{ location: string }>(
      `SELECT location FROM scenes WHERE campaign_id = $1 AND location NOT IN ('', $2) GROUP BY location ORDER BY max(seq) DESC LIMIT 40`,
      [campaignId, String(ctx.campaign.state.startingPoint ?? "").slice(0, 120)]
    ),
    q<{ name: string }>(`SELECT name FROM characters WHERE campaign_id = $1 AND kind = 'player' LIMIT 1`, [campaignId]),
  ]);
  const known = places.map((p) => p.location).reverse();
  const r = await chat({
    model: chronicler.model,
    messages: [
      {
        role: "system",
        content: `Você dá nome ao lugar onde o personagem do jogador está no FIM da narração de RPG. Responda só o nome, do mais específico ao mais geral separado por vírgula (ex.: "Casa do Ren, Vila do Norte" ou "Loja de armas, Rua principal, Porto Velho"), sem aspas nem ponto final. Se for um lugar já conhecido, use o nome dele exatamente. Se a narração não disser onde ele está, responda só: ?`,
      },
      {
        role: "user",
        content: `Personagem do jogador: ${player?.name || "?"}\nLocal anterior: ${ctx.scene.location || "(nenhum)"}\nLugares conhecidos: ${known.join("; ") || "(nenhum)"}\n\nNarração:\n${narration.slice(-3000)}`,
      },
    ],
    temperature: 0,
    max_tokens: chronicler.max_tokens, // modelo que raciocina gasta tokens antes da resposta curta
    agentId: "chronicler",
    campaignId,
    purpose: "nome do local (Mestre não trocou)",
  });
  return placeName(r.content, ctx.scene.location);
}

/** Resposta do Cronista → nome do local; null se vazia, "?", longa demais ou igual ao local atual. */
export function placeName(raw: string, current: string): string | null {
  const name = raw.trim().split("\n")[0].replace(/^["'“”«*]+|["'“”»*.]+$/g, "").trim();
  if (!name || name.includes("?") || name.length > 80 || normName(name) === normName(current || "")) return null;
  return name;
}

/** O Mestre esqueceu de mexer no relógio: o Jev escolhe uma faixa de tempo e o código soma. Falhou = não anda. */
async function fallbackClock(
  campaignId: string,
  campaign: Campaign,
  scene: Scene,
  playerInput: string,
  narration: string,
  emit: (e: TurnEvent) => void
): Promise<void> {
  const clock = getClock(campaign.state);
  if (!clock) return; // sem relógio, o Mestre define com set_time no próximo turno
  const delta = await decideElapsed(
    {
      scene: { mode: scene.mode, location: scene.location },
      clock: `${formatClock(clock.minutes)} (${period(clock.minutes)})`,
      playerAction: playerInput,
      gmNarration: narration,
    },
    campaignId
  );
  if (!delta) return;
  emit({ type: "time", minutes: clock.minutes + delta });
  // prazo vencido aqui (depois da narração) aparece como PERDIDO no contexto do próximo turno
  await saveClock(campaignId, clock.minutes + delta, emit);
}

/** Conversa particular encerrada (lib/npc): relógio pelo tempo dela e o Escrivão com as falas no lugar da narração. */
export async function scribeConversation(campaignId: string, label: string, transcript: string): Promise<string[]> {
  const [campaign, scene] = await Promise.all([getCampaign(campaignId), getCurrentScene(campaignId)]);
  const emit = () => {};
  await fallbackClock(campaignId, campaign, scene, label, transcript, emit).catch(() => {});
  // ponytail: sem desfazer pela etiqueta (messageId 0); o desfazer vale só para a última narração do Mestre
  return (await runScribe(campaignId, { campaign, scene, emit }, label, transcript, [], [], 0)).map((e) => e.note);
}

type Settled = { name: string; args: Record<string, unknown>; output: string };
const REFEREE_TOOLS = new Set(["use_ability", "train", "roll_dice"]);
const REFEREE_TOOL_DEFS = GM_TOOLS.filter((t) => REFEREE_TOOLS.has(t.function.name));
/** Mesma técnica (use_ability) ou mesmo alvo de treino (train); "" para as outras ferramentas. */
const settleKey = (name: string, args: Record<string, unknown>) =>
  name === "use_ability" || name === "train" ? `${name}:${String((name === "train" ? args.target : args.ability) ?? "").trim().toLowerCase()}` : "";

/**
 * Árbitro: quando o Jev diz que a ação é usar uma técnica da ficha ou treinar, resolve antes do Mestre (use_ability,
 * train e o roll_dice do dano), sempre para o personagem do jogador e no mesmo ToolContext do turno: dados, chips e
 * domínio (masteryGained) saem iguais aos do Mestre. Antes, essas ferramentas forçavam outra rodada com o prompt
 * inteiro do Mestre em ~metade dos turnos. Uma chamada; devolve só o que resolveu (erro fica para o Mestre).
 */
async function runReferee(
  campaignId: string,
  ctx: ToolContext,
  player: Character,
  chars: Character[],
  playerInput: string,
  lastNarration: string
): Promise<Settled[]> {
  ctx.emit({ type: "status", text: "O Árbitro está resolvendo a ação..." });
  const agent = await getAgent("referee");
  const rs = ctx.campaign.ruleset;
  const clock = getClock(ctx.campaign.state);
  const npcs = chars.filter((c) => c.kind === "npc" && c.active).map((c) => c.name);
  const state = [
    `Hora na história: ${clock ? `${formatClock(clock.minutes)} (${period(clock.minutes)})` : "não definida (treino só depois do Mestre definir a hora)"}`,
    tablePromptBlock(getTable(ctx.campaign.state)),
    rs.diceNotes ? `Rolagens (MECÂNICA): ${rs.diceNotes}` : "",
    `\n--- REGRAS DE TREINO ---\n${progressionPromptLines(rs).filter((l) => l.startsWith("Treino")).join("\n")}`,
    `\n--- JOGADOR ---\n${sheetSummary(player, false, rs, true)}`,
    `NPCs em cena: ${npcs.join(", ") || "(nenhum)"}`,
  ];
  const r = await chat({
    model: agent.model,
    messages: [
      { role: "system", content: agent.system_prompt },
      {
        role: "user",
        content: `--- ESTADO ---\n${state.filter(Boolean).join("\n")}\n\n--- ÚLTIMA NARRAÇÃO DO MESTRE ---\n${lastNarration.slice(-1500) || "(nenhuma)"}\n\n--- AÇÃO DO JOGADOR ---\n${playerInput}`,
      },
    ],
    temperature: agent.temperature,
    max_tokens: agent.max_tokens,
    reasoning: agent.params.reasoning as Record<string, unknown> | undefined,
    tools: REFEREE_TOOL_DEFS,
    agentId: "referee",
    campaignId,
    purpose: "árbitro (antes do Mestre)",
  });
  const out: Settled[] = [];
  // dano por último e só se alguma técnica passou: numa chamada só, o Árbitro não vê o resultado do teste
  const calls = r.toolCalls
    .filter((c) => REFEREE_TOOLS.has(c.function.name))
    .sort((a, b) => Number(a.function.name === "roll_dice") - Number(b.function.name === "roll_dice"));
  for (const call of calls) {
    const name = call.function.name;
    const args = argsOf(call);
    if (name !== "roll_dice") args.character = player.name;
    else if (!out.some((s) => s.name === "use_ability" && !/: FALHA|FALHOU/.test(s.output))) continue;
    const output = await executeGmTool(name, args, ctx).catch((e) => `Erro: ${e instanceof Error ? e.message : String(e)}`);
    // técnica fora da ficha, treino recusado: fica para o Mestre resolver do jeito dele
    if (name === "train" ? /^Treino de/.test(output) : !/^Erro/.test(output)) out.push({ name, args, output });
  }
  return out;
}

const SCRIBE_TOOL_DEFS = GM_TOOLS.filter((t) => SCRIBE_TOOLS.has(t.function.name));
const CREATE_NPC_DEF = GM_TOOLS.find((t) => t.function.name === "create_npc")!;

/**
 * Escrivão: depois da narração, registra nas fichas o que a ação e a narração estabeleceram (recursos, itens, XP,
 * domínio por evento, memórias e missões, inclusive as anotações note_objective do Mestre). Essas ferramentas saíram
 * do Mestre: cada uma custava outra rodada com o prompt inteiro dele. Uma chamada com as ferramentas em paralelo e,
 * só se alguma deu erro, uma segunda para corrigir. Falhou = nada muda. Cada registro guarda o que mudou (corrections.ts)
 * e as etiquetas dele levam { messageId, index }: o jogador desfaz pelo chat.
 */
async function runScribe(
  campaignId: string,
  ctx: ToolContext,
  playerInput: string,
  narration: string,
  done: string[],
  briefs: string[],
  messageId: number
): Promise<ScribeEntry[]> {
  const applied: ScribeEntry[] = []; // o que gravou, para o Mestre saber no próximo turno e o jogador poder desfazer
  const [agent, campaign, chars, directives] = await Promise.all([
    getAgent("scribe"),
    getCampaign(campaignId),
    getCharacters(campaignId),
    activeDirectives(campaignId),
  ]);
  const clock = getClock(campaign.state);
  const sheet = (c: Character) =>
    sheetSummary(c, false, campaign.ruleset) +
    (c.sheet.inventory.length ? `\n  inventário: ${c.sheet.inventory.map((i) => `${i.qty}x ${i.name}`).join(", ")}` : "");
  const npcs = chars.filter((c) => c.kind === "npc" && c.active);
  const player = chars.find((c) => c.kind === "player");
  // quem fala no formato **Nome:** sem registro: o Escrivão julga se é personagem e registra (a narração não volta ao Mestre)
  const unregistered = unregisteredSpeakers(narration, chars);
  const rest = restRuleText(getTable(campaign.state));
  const state = [
    `Hora na história: ${clock ? `${formatClock(clock.minutes)} (${period(clock.minutes)})` : "não definida (missão só sem prazo)"}`,
    objectivesPromptBlock(
      getObjectives(campaign.state),
      clock?.minutes ?? null,
      (o) => objectiveXp(o, campaign.ruleset, getTable(campaign.state), player?.sheet.xp ?? 0),
      campaign.ruleset.currency && ((n) => formatMoney(n, campaign.ruleset.currency!))
    ),
    `REGRA DE XP DA MESA: ${xpRuleText(getTable(campaign.state))}.`,
    rest && `REGRA DE DESCANSO DA MESA: ${rest}.`,
    player ? `\n--- JOGADOR ---\n${sheet(player)}` : "",
    npcs.length ? `\n--- NPCs EM CENA ---\n${npcs.map(sheet).join("\n")}` : "",
  ];
  const messages: ChatMessage[] = [
    { role: "system", content: agent.system_prompt },
    {
      role: "user",
      content: `--- ESTADO ---\n${state.filter(Boolean).join("\n")}\n\n--- AÇÃO DO JOGADOR ---\n${playerInput}\n\n--- NARRAÇÃO DO MESTRE ---\n${narration}\n\n--- JÁ FEITO PELO MESTRE NESTE TURNO (não repita) ---\n${
        done.join("\n") || "(nada)"
      }${briefs.length ? `\n\n--- ANOTAÇÕES DE MISSÃO DO MESTRE ---\n${briefs.map((b) => `- ${b}`).join("\n")}` : ""}${
        unregistered.length
          ? `\n\n--- FALAM SEM REGISTRO ---\n${unregistered.join(", ")}\nPara cada personagem com nome aqui, chame create_npc (canon=true se for da obra; brief com quem é e o que a narração mostrou). Ignore o que não é personagem (título, cabeçalho como "Resultado do treino", cargo genérico como "Funcionária") e quem já está registrado com outro nome.`
          : ""
      }${
        // as de registro (recuperação de recursos, custos, itens) valem para ele; o prompt manda ignorar as de narração
        directives.length ? `\n\n--- DIRETRIZES DO JOGADOR ---\n${directives.map((d) => `- ${d.content}`).join("\n")}` : ""
      }`,
    },
  ];
  // estado novo: relógio já andado e fichas depois das ferramentas do Mestre; scribe: as ferramentas sabem quem chama
  const tctx: ToolContext = { ...ctx, campaign, scribe: { briefs: briefs.length } };
  for (let round = 0; round < 2; round++) {
    const r = await chat({
      model: agent.model,
      messages,
      temperature: agent.temperature,
      max_tokens: agent.max_tokens,
      reasoning: agent.params.reasoning as Record<string, unknown> | undefined,
      tools: unregistered.length ? [...SCRIBE_TOOL_DEFS, CREATE_NPC_DEF] : SCRIBE_TOOL_DEFS,
      agentId: "scribe",
      campaignId,
      purpose: round ? "anotações do turno (correção)" : "anotações do turno",
    });
    if (!r.toolCalls.length) return applied;
    messages.push({ role: "assistant", content: r.content || null, tool_calls: r.toolCalls });
    let failed = false;
    // grant_xp por último: a conclusão de missão com tamanho dá a XP e o grant_xp da mesma resposta vê isso (não dá em dobro)
    const outs = new Map<string, string>();
    for (const call of [...r.toolCalls].sort((a, b) => Number(a.function.name === "grant_xp") - Number(b.function.name === "grant_xp"))) {
      const name = call.function.name;
      if (!SCRIBE_TOOLS.has(name) && !(unregistered.length && name === "create_npc")) {
        outs.set(call.id, `Erro: ${name} não é ferramenta do Escrivão.`);
        continue;
      }
      // etiquetas seguram até saber se o registro tem o que desfazer
      const args = argsOf(call);
      const chips: Extract<TurnEvent, { type: "tool" }>[] = [];
      tctx.emit = (e) => (e.type === "tool" ? chips.push(e) : ctx.emit(e));
      const before = await scribeState(campaignId, args);
      const out = await executeGmTool(name, args, tctx).catch((e) => `Erro: ${e instanceof Error ? e.message : String(e)}`);
      outs.set(call.id, out);
      if (/^Erro|não existe|precisa/.test(out)) continue;
      const undo = await scribeUndo(campaignId, before, name, args).catch(() => undefined);
      if (undo && !chips.length) chips.push({ type: "tool", name, summary: name === "update_extra_field" ? `${args.character}: ${args.field} = ${args.value}` : name });
      const scribe = undo ? { messageId: Number(messageId), index: applied.length } : undefined; // id do pg vem em texto
      for (const chip of chips) ctx.emit({ ...chip, scribe });
      applied.push({
        tool: name,
        args,
        summary: chips.map((c) => c.summary).join(" · ") || name,
        note: `${name} ${call.function.arguments} → ${out}`.slice(0, 240),
        undo,
      });
    }
    tctx.emit = ctx.emit;
    for (const call of r.toolCalls) {
      const out = outs.get(call.id)!;
      if (/^Erro|não existe|precisa/.test(out)) failed = true;
      messages.push({ role: "tool", content: out, tool_call_id: call.id, name: call.function.name });
    }
    if (!failed) return applied;
  }
  return applied;
}

function toolSummary(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "roll_dice":
      return `🎲 rolando ${args.notation}${args.reason ? ` — ${args.reason}` : ""}`;
    case "search_memories":
      return `🔍 buscando memórias: "${args.query}"`;
    case "search_history":
      return `🔍 buscando no histórico: "${args.query}"`;
    case "search_book":
      return `📖 consultando livros: "${args.query}"`;
    case "read_pages":
      return `📖 lendo páginas do livro`;
    case "get_script":
      return `📜 consultando o roteiro`;
    case "get_character":
      return `📋 lendo ficha de ${args.name}`;
    default:
      return `⚙️ ${name}`;
  }
}

// ---------- compactação (Cronista) ----------

/** Revisão do Cronista na compactação: o estado do mundo que a história pode ter deixado para trás. */
type WorldUpdate = {
  npcs?: { name?: string; rank?: string; current?: string }[];
  arc?: { canonEvents?: unknown; note?: string; done?: boolean };
  directives?: { id?: number; why?: string }[];
};

/**
 * ESTADO DO MUNDO para o Cronista: os NPCs citados no trecho (cargo, situação atual, papel, começo do passado), o arco
 * ativo e as diretrizes do jogador. Sem isso, perfil, roteiro e diretrizes ficavam no ponto da obra em que nasceram
 * (o Naruto seguia "último ano da Academia" dias depois do teste dos guizos).
 */
async function worldBlock(campaign: Campaign, transcript: string) {
  const [chars, directives] = await Promise.all([getCharacters(campaign.id), activeDirectives(campaign.id)]);
  const low = transcript.toLowerCase();
  // pelo primeiro nome: "Naruto" no texto acha "Naruto Uzumaki"
  const npcs = chars.filter((c) => c.kind === "npc" && low.includes(c.name.split(/\s+/)[0].toLowerCase()));
  const arcs = campaign.script?.arcs ?? [];
  const i = arcs.findIndex((a) => a.status === "active");
  const arc = i >= 0 ? arcs[i] : undefined;
  const clock = getClock(campaign.state);
  const lines = [
    "ESTADO DO MUNDO (atualize o que este trecho mudou):",
    clock ? `Agora: ${formatClock(clock.minutes)}` : "",
    `CARGOS: ${campaign.ruleset.ranks.map((r) => r.key).join(", ")}`,
    npcs.length
      ? `NPCS:\n${npcs
          .map((c) => `- ${c.name} | cargo: ${c.sheet.rank || "-"} | situação atual: ${c.persona.current || "(nenhuma)"}${c.persona.role ? ` | papel: ${c.persona.role}` : ""}${c.persona.backstory ? ` | passado: ${c.persona.backstory.slice(0, 240)}` : ""}`)
          .join("\n")}`
      : "",
    arc
      ? `ARCO ATIVO: ${arc.title}: ${arc.summary.slice(0, 400)}\nEventos canônicos: ${arc.canonEvents.join(" | ") || "-"}${arc.notes.length ? `\nNotas: ${arc.notes.slice(-3).join(" | ")}` : ""}${arcs[i + 1] ? `\nPróximo arco: ${arcs[i + 1].title}` : ""}`
      : "",
    directives.length ? `DIRETRIZES DO JOGADOR:\n${directives.map((d) => `- id ${d.id}: ${d.content.slice(0, 300)}`).join("\n")}` : "",
  ];
  return { text: lines.filter(Boolean).join("\n"), npcs, arcIndex: i, directives };
}

/** Aplica a revisão: situação e cargo dos NPCs, eventos do arco (e fecha/abre arco), aviso de diretriz na conversa fora do jogo. */
async function applyWorld(campaign: Campaign, w: Awaited<ReturnType<typeof worldBlock>>, u: WorldUpdate, emit?: (e: TurnEvent) => void) {
  const chip = (summary: string) => emit?.({ type: "tool", name: "chronicler", summary });
  const ranks = new Set(campaign.ruleset.ranks.map((r) => r.key));
  for (const n of Array.isArray(u.npcs) ? u.npcs : []) {
    const c = w.npcs.find((x) => x.name.toLowerCase() === String(n?.name || "").trim().toLowerCase());
    if (!c) continue;
    const current = String(n.current || "").trim().slice(0, 500);
    const rank = n.rank && ranks.has(n.rank) && n.rank !== c.sheet.rank ? n.rank : null;
    if (!current && !rank) continue;
    await q(
      `UPDATE characters SET persona = CASE WHEN $2 = '' THEN persona ELSE persona || jsonb_build_object('current', $2::text) END,
         sheet = CASE WHEN $3::text IS NULL THEN sheet ELSE jsonb_set(sheet, '{rank}', to_jsonb($3::text)) END, updated_at = now()
       WHERE id = $1`,
      [c.id, current, rank]
    );
    chip(`📜 ${c.name}${rank ? ` → ${rank}` : ""}${current ? `: ${current.slice(0, 90)}` : ""}`);
  }
  const script = campaign.script;
  const arc = script && w.arcIndex >= 0 ? script.arcs[w.arcIndex] : undefined;
  if (script && arc && u.arc) {
    const events = Array.isArray(u.arc.canonEvents) ? u.arc.canonEvents.map(String).map((e) => e.trim()).filter(Boolean).slice(0, 8) : [];
    if (events.length) arc.canonEvents = events;
    if (u.arc.note?.trim()) arc.notes.push(u.arc.note.trim().slice(0, 300));
    const next = script.arcs[w.arcIndex + 1];
    if (u.arc.done === true) {
      arc.status = "done";
      if (next?.status === "pending") next.status = "active";
    }
    if (events.length || u.arc.note?.trim() || u.arc.done === true) {
      await q(`UPDATE campaigns SET script = $1, updated_at = now() WHERE id = $2`, [JSON.stringify(script), campaign.id]);
      chip(`📜 roteiro: ${arc.title}${arc.status === "done" ? ` concluído${next ? `, começa ${next.title}` : ""}` : " atualizado"}`);
    }
  }
  for (const d of Array.isArray(u.directives) ? u.directives : []) {
    const dir = w.directives.find((x) => Number(x.id) === Number(d?.id));
    if (!dir || !d.why?.trim()) continue;
    // só aponta: a diretriz é do jogador. Na conversa fora do jogo ele pede para atualizar ou desativar
    const quoted = `"${dir.content.slice(0, 300)}"`;
    // uma vez por diretriz: o jogador pode ter decidido manter, e cada compactação apontaria de novo
    const [added] = await q<{ id: number }>(
      `INSERT INTO gm_notes (campaign_id, role, content)
       SELECT $1, 'gm', $2 WHERE NOT EXISTS (SELECT 1 FROM gm_notes WHERE campaign_id = $1 AND role = 'gm' AND position($3 in content) > 0)
       RETURNING id`,
      [campaign.id, `O Cronista acha que esta diretriz não vale mais: ${quoted}. Motivo: ${d.why.trim().slice(0, 300)}. Se concordar, me peça aqui para atualizar ou desativar.`, quoted]
    );
    if (added) chip(`📜 diretriz desatualizada? veja em Falar com o Mestre`);
  }
}

export async function maybeCompact(campaignId: string, scene: Scene, emit?: (e: TurnEvent) => void): Promise<void> {
  const chronicler = await getAgent("chronicler");
  const params = chronicler.params as {
    compactThresholdTokens?: number;
    keepRecentMessages?: number;
  };
  const threshold = params.compactThresholdTokens ?? 11000;
  const keep = params.keepRecentMessages ?? 12;

  const rows = (
    await q<{ id: number; role: string; speaker: string | null; content: string; meta: Parameters<typeof talkNote>[0]["meta"] }>(
      `SELECT id, role, speaker, content, meta FROM messages
       WHERE campaign_id = $1 AND role IN ('player','gm','talk') AND NOT compacted
       ORDER BY id`,
      [campaignId]
    )
  ).map((m) => (m.role === "talk" ? { ...m, content: talkNote(m) } : m));
  const total = rows.reduce((a, r) => a + estimateTokens(r.content), 0); // pelo texto: tokens gravados podem ser de outra estimativa
  if (total < threshold || rows.length <= keep) return;

  const toCompact = rows.slice(0, rows.length - keep);
  const transcript = toCompact
    .map((r) => `${r.role === "player" ? "JOGADOR" : r.role === "talk" ? "CONVERSA PARTICULAR" : "MESTRE"}: ${r.content}`)
    .join("\n\n");

  const campaign = await getCampaign(campaignId);
  const world = await worldBlock(campaign, transcript);
  const result = await chat({
    model: chronicler.model,
    messages: [
      { role: "system", content: chronicler.system_prompt },
      {
        role: "user",
        content: `Resumo anterior acumulado (contexto, não repita):\n${scene.summary || "(vazio)"}\n\nTrecho da sessão a compactar:\n${transcript}\n\n${world.text}`,
      },
    ],
    temperature: chronicler.temperature,
    max_tokens: chronicler.max_tokens,
    agentId: "chronicler",
    campaignId,
    purpose: "compactação de histórico",
  });

  let parsed: WorldUpdate & {
    summary?: string;
    memories?: { kind: string; subject?: string | null; content: string; importance?: number }[];
  } = {};
  try {
    parsed = JSON.parse(result.content.replace(/```json|```/g, "").trim());
  } catch {
    parsed = { summary: result.content.slice(0, 1500) };
  }

  const newSummary = [scene.summary, parsed.summary].filter(Boolean).join("\n").slice(-6000);
  await q(`UPDATE scenes SET summary = $1 WHERE id = $2`, [newSummary, scene.id]);
  await q(`UPDATE messages SET compacted = TRUE WHERE id = ANY($1::bigint[])`, [
    toCompact.map((r) => r.id),
  ]);
  const mems = (parsed.memories || []).filter((m) => m?.content);
  // importância pelo Jev; se ele falhar, fica a do Cronista
  const importance = await scoreImportance(campaign.ruleset.name, mems, campaignId);
  for (const [i, m] of mems.entries())
    await addMemory(campaignId, m.kind || "event", m.content, m.subject || null, importance[i]);
  await applyWorld(campaign, world, parsed, emit).catch((e) => console.warn("[cronista: estado do mundo]", e));
}

// ---------- roteirista ----------

/**
 * O que já aconteceu, para o Roteirista replanejar a partir daqui: hora, resumos das cenas em ordem, marcos e memórias
 * importantes, situação dos NPCs, onde a história parou, diretrizes do jogador e o roteiro atual. Vazio = campanha
 * sem narração ainda (roteiro do zero). Sem isso, regenerar voltava a história ao ponto de inserção.
 */
async function storySoFar(campaign: Campaign, chars: Character[]): Promise<string> {
  const id = campaign.id;
  const [scenes, mems, [last], directives] = await Promise.all([
    q<{ seq: number; location: string | null; summary: string }>(
      `SELECT seq, location, summary FROM scenes WHERE campaign_id = $1 AND summary IS NOT NULL AND summary <> '' ORDER BY seq`,
      [id]
    ),
    q<{ content: string }>(
      `SELECT content FROM memories WHERE campaign_id = $1 AND kind <> 'directive' AND (kind = 'milestone' OR importance >= 4) ORDER BY id`,
      [id]
    ),
    q<{ content: string }>(`SELECT content FROM messages WHERE campaign_id = $1 AND role = 'gm' ORDER BY id DESC LIMIT 1`, [id]),
    activeDirectives(id),
  ]);
  if (!last) return "";
  const clock = getClock(campaign.state);
  // ponytail: corta pelo começo se passar de ~16 mil caracteres (campanhas muito longas); depois, resumo por arco
  const story = scenes.map((s) => `Cena ${s.seq}${s.location ? ` (${s.location})` : ""}: ${s.summary}`).join("\n").slice(-16000);
  const npcs = chars.filter((c) => c.kind === "npc" && (c.canon || c.persona.current));
  const arcs = (campaign.script?.arcs ?? []).map(
    (a) => `- ${a.title} [${a.status}]: ${a.summary.slice(0, 300)}${a.notes.length ? ` | notas: ${a.notes.slice(-3).join(" | ")}` : ""}`
  );
  return [
    "HISTÓRIA ATÉ AGORA (a campanha já está em andamento):",
    clock ? `Agora: ${formatClock(clock.minutes)}` : "",
    story ? `Resumo das cenas, em ordem:\n${story}` : "",
    mems.length ? `Marcos e fatos importantes, em ordem:\n${mems.map((m) => `- ${m.content.slice(0, 300)}`).join("\n")}` : "",
    npcs.length ? `NPCs:\n${npcs.map((c) => `- ${c.name} | cargo: ${c.sheet.rank || "-"}${c.persona.current ? ` | agora: ${c.persona.current}` : c.persona.role ? ` | ${c.persona.role}` : ""}`).join("\n")}` : "",
    `Onde a história parou (última narração):\n${last.content.slice(-1500)}`,
    directives.length ? `Diretrizes do jogador (siga):\n${directives.map((d) => `- ${d.content.slice(0, 300)}`).join("\n")}` : "",
    arcs.length ? `Roteiro atual:\n${arcs.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function generateScript(campaign: Campaign): Promise<CampaignScript | null> {
  const writer = await getAgent("scriptwriter");
  const chars = await getCharacters(campaign.id);
  const player = chars.find((c) => c.kind === "player");
  const story = await storySoFar(campaign, chars);
  const old = campaign.script;
  const done = story ? (old?.arcs ?? []).filter((a) => a.status === "done") : [];
  const result = await chat({
    model: writer.model,
    messages: [
      { role: "system", content: writer.system_prompt },
      {
        role: "user",
        content: `MECÂNICA/CENÁRIO:\n${rulesetPromptSummary(campaign.ruleset)}\n\nPERSONAGEM DO JOGADOR:\n${
          player ? sheetSummary(player, true, campaign.ruleset) : "(não criado)"
        }\n\n${
          story
            ? `${story}\n\nREPLANEJE o roteiro da campanha "${campaign.name}" a partir de onde a história parou: o que já aconteceu é fato e não se repete. ${
                done.length ? `Os arcos concluídos (${done.map((a) => a.title).join("; ")}) ficam como estão: não os devolva. ` : ""
              }O 1º arco que você devolver é o atual (status "active"), começando no ponto em que a história está, e os seguintes continuam dele.${
                campaign.ruleset.canonBased
                  ? " O cenário é baseado em obra: ancore os arcos na linha do tempo canônica a partir do ponto atual da história (eventos canônicos que já aconteceram não voltam)."
                  : ""
              }`
            : `Monte o roteiro da campanha "${campaign.name}".${
                campaign.ruleset.canonBased
                  ? " O cenário é baseado em obra: ancore os arcos na linha do tempo canônica a partir do ponto de inserção do personagem."
                  : ""
              }`
        }`,
      },
    ],
    temperature: writer.temperature,
    max_tokens: writer.max_tokens,
    webSearch: writer.web_search,
    agentId: "scriptwriter",
    campaignId: campaign.id,
    purpose: "geração de roteiro",
  });
  try {
    const jsonText = result.content.replace(/```json|```/g, "").trim();
    const script = JSON.parse(jsonText) as CampaignScript;
    if (!script.premise || !Array.isArray(script.arcs)) return null;
    const doneTitles = new Set(done.map((a) => a.title.toLowerCase()));
    script.arcs = script.arcs
      .filter((a) => !doneTitles.has(String(a.title || "").toLowerCase()))
      .map((a) => ({
        title: a.title || "Arco",
        summary: a.summary || "",
        canonEvents: a.canonEvents || [],
        hooks: a.hooks || [],
        status: a.status === "done" ? "pending" : a.status || "pending", // replanejado: concluído só o que já estava
        // mesmo arco replanejado: as notas do Mestre e do Cronista ficam
        notes: [...(old?.arcs.find((o) => o.title.toLowerCase() === String(a.title || "").toLowerCase())?.notes ?? []), ...(a.notes || [])],
      }));
    if (!script.arcs.some((a) => a.status === "active") && script.arcs[0])
      script.arcs[0].status = "active";
    script.arcs = [...done, ...script.arcs]; // os concluídos ficam na frente, como estavam
    await q(`UPDATE campaigns SET script = $1, updated_at = now() WHERE id = $2`, [
      JSON.stringify(script),
      campaign.id,
    ]);
    return script;
  } catch {
    return null;
  }
}
