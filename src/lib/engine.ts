import { q } from "./db";
import { type Advanced, getAdvanced } from "./advanced";
import { getAgent } from "./agents";
import { chat, ChatMessage, CHARS_PER_TOKEN, estimateTokens, ToolCall } from "./openrouter";
import { abilityPromptLine, currentMilestone, nextMilestone, rulesetPromptSummary } from "./ruleset";
import {
  activeDirectives,
  addMemory,
  formatHistory,
  HistoryHit,
  historyLine,
  indexHistory,
  MemoryHit,
  recentMemories,
  searchHistory,
  searchMemories,
} from "./retrieval";
import { decideCast, decideElapsed, decideMoved, decideTurn, scoreImportance } from "./decisions";
import { attributeCap, attributePoints, powerLevel } from "./progression";
import { formatClock, getClock, period } from "./clock";
import { getObjectives, objectivesPromptBlock } from "./objectives";
import { getStage, loadMap, mapPromptBlock, normName } from "./map";
import { getTable, tablePromptBlock, xpRuleText } from "./table";
import { takeSnapshot } from "./turnSnapshot";
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
  GameMessage,
  Ruleset,
  Scene,
  TurnEvent,
} from "./types";

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

export async function getCharacters(campaignId: string): Promise<Character[]> {
  return q<Character>(
    `SELECT * FROM characters WHERE campaign_id = $1 ORDER BY kind DESC, name`,
    [campaignId]
  );
}

// ---------- montagem de contexto do Mestre ----------

/**
 * Ficha em texto. compact (contexto do turno do Mestre, que vai a cada chamada): efeito e requisito de cada técnica
 * e o passado do jogador encurtados; ficam marco atual e próximo (guiam a cena ao roteiro). O completo sai no get_character.
 */
export function sheetSummary(c: Character, full: boolean, rs: Ruleset, compact = false): string {
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
  if (s.abilities.length)
    lines.push(
      `  habilidades:\n` +
        s.abilities
          .map((a) => {
            let line = `    - ${abilityPromptLine(rs, a, compact ? 160 : Infinity)}`;
            const cur = currentMilestone(a);
            const next = nextMilestone(a);
            if (cur) line += ` — atual: ${cur.description}`;
            if (next) line += ` | próximo marco aos ${next.threshold}%: ${next.description}`;
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

const MODE_HINTS: Record<string, string> = {
  exploration: "Cena de EXPLORAÇÃO: descrições sensoriais ricas, ritmo médio, semeie ganchos.",
  dialogue: "Cena de DIÁLOGO: respostas curtas, foco nas falas e linguagem corporal dos NPCs. Não resuma conversas — interprete-as.",
  battle: "Cena de BATALHA: turno a turno, tático e tenso. Descreva posições e aberturas, peça a ação do jogador, resolva com rolagens e narre dano e gasto com números claros. Inimigos agem com inteligência coerente.",
  training: "Cena de TREINAMENTO: resolva com train informando horas realistas (ele avança o relógio e aplica o ganho de domínio ou atributo); respeite a recusa por exaustão. Deixe claros na narração os marcos reais (o Escrivão dá a XP).",
  downtime: "Cena de DESCANSO: leve e breve; avance o tempo com resumos e cenas curtas de personagem.",
};

async function buildGmSystem(
  campaign: Campaign,
  scene: Scene,
  chars: Character[],
  memories: MemoryHit[],
  past: string, // trechos antigos do chat aprovados pelo Jev (formatHistory)
  basePrompt: string
): Promise<[fixed: string, turn: string]> {
  const player = chars.find((c) => c.kind === "player");
  const activeNpcs = chars.filter((c) => c.kind === "npc" && c.active);
  const inactiveNames = chars
    .filter((c) => c.kind === "npc" && !c.active)
    .map((c) => c.name);

  const activeArc = campaign.script?.arcs.find((a) => a.status === "active");
  const clock = getClock(campaign.state);
  const directives = await activeDirectives(campaign.id);
  // o que o Escrivão gravou depois da narração anterior (meta.notes da última mensagem do Mestre)
  const [last] = await q<{ notes: string[] | null }>(
    `SELECT meta->'notes' AS notes FROM messages WHERE campaign_id = $1 AND role = 'gm' ORDER BY id DESC LIMIT 1`,
    [campaign.id]
  );
  const lastNotes = Array.isArray(last?.notes) ? last.notes : [];

  // o que não muda de um turno para outro na campanha: com o cache ligado no Mestre, é o ponto de cache entre turnos
  const fixed = [
    basePrompt,
    `\n====== CAMPANHA: ${campaign.name} ======`,
    STYLE_INSTRUCTIONS[campaign.style] || STYLE_INSTRUCTIONS.hybrid,
    `\n--- MECÂNICA ---\n${rulesetPromptSummary(campaign.ruleset)}`,
    "Biblioteca do mundo: técnicas e itens já criados (search_library). add_ability só precisa de personagem, nome e brief: a técnica vem da biblioteca ou o Criador de habilidades a cria completa (tipo, rank, custo, efeito, dano, marcos); não invente esses números.",
    "Ao abrir cena nova ou mudar de local (set_scene), informe present com todos os NPCs que estão lá: quem ficar de fora sai de cena.",
    "search_history busca no chat inteiro da campanha (turnos e conversas com NPCs, com dia, hora e local): use para lembrar exatamente o que alguém disse ou fez, ou detalhes antigos que não viraram memória.",
    "O estado do turno (cena, hora, personagens, memórias) chega numa mensagem de contexto logo antes da ação do jogador.",
    // cada ferramenta chamada antes do texto custa outra rodada com o prompt inteiro
    `Anotações (${[...DEFERRED_TOOLS].join(", ")}) só valem depois da narração: chame-as junto da narração, no fim da resposta, nunca antes dela. Dano, cura e gasto de recurso, itens ganhos ou perdidos, XP, domínio por evento, memórias e missões o Escrivão registra sozinho depois, pelo que a narração mostra: narre com números claros (quem perdeu quanto, o que pegou ou entregou). O relógio também anda sozinho pelo tempo que a narração mostra; set_time só em saltos explícitos.`,
  ];
  const parts = [
    tablePromptBlock(getTable(campaign.state)),
    `\n--- CENA ATUAL (nº ${scene.seq}) ---\nModo: ${scene.mode} | Local: ${scene.location || "?"} | Título: ${scene.title || "-"}\n${
      clock
        ? `Hora na história: ${formatClock(clock.minutes)} (${period(clock.minutes)})`
        : "Hora na história: AINDA NÃO DEFINIDA. Chame set_time neste turno com uma hora coerente com a história até aqui."
    }\n${MODE_HINTS[scene.mode] || ""}${scene.summary ? `\nResumo do que já aconteceu nesta cena (compactado): ${scene.summary}` : ""}`,
    objectivesPromptBlock(getObjectives(campaign.state), clock?.minutes ?? null),
    // só local, rotas e palco: o resto do mapa (mapas 3D, locais distantes, regras) vai ao Topógrafo pelo map_brief
    mapPromptBlock(await loadMap(campaign.id, campaign.state), getStage(scene.state), scene.mode),
    player
      ? `\n--- PERSONAGEM DO JOGADOR ---\n${sheetSummary(player, true, campaign.ruleset, true)}`
      : "",
    activeNpcs.length
      ? `\n--- NPCs EM CENA ---\n${activeNpcs.map((n) => sheetSummary(n, true, campaign.ruleset, true)).join("\n")}`
      : "\n--- NPCs EM CENA ---\n(nenhum)",
    inactiveNames.length
      ? `NPCs conhecidos fora de cena (não interagem; reative com set_npc_active): ${inactiveNames.join(", ")}`
      : "",
    activeArc
      ? `\n--- ROTEIRO: ARCO ATIVO ---\n${activeArc.title}: ${activeArc.summary}\nEventos canônicos deste arco: ${activeArc.canonEvents.join(" | ") || "-"}\nGanchos: ${activeArc.hooks.join(" | ") || "-"}\nNotas: ${activeArc.notes.slice(-5).join(" | ") || "-"}\n(roteiro completo via get_script)`
      : "",
    memories.length
      ? `\n--- MEMÓRIAS RELEVANTES ---\n${memories
          .map((m) => `[${m.kind}${m.subject ? `/${m.subject}` : ""}] ${m.content}`)
          .join("\n")}`
      : "",
    past ? `\n--- TRECHOS ANTIGOS DO CHAT (lembrados para esta ação) ---\n${past}` : "",
    lastNotes.length
      ? `\n--- O ESCRIVÃO REGISTROU DEPOIS DA SUA ÚLTIMA NARRAÇÃO (já está nas fichas; reconheça na história se for marcante, como um marco de domínio ou nível novo) ---\n${lastNotes.map((n) => `- ${n}`).join("\n")}`
      : "",
    directives.length
      ? `\n--- DIRETRIZES DO JOGADOR (fora do jogo) — siga ---\n${directives
          .map((d) => `- ${d.content}${d.subject === "proxima_cena" ? " (vale nesta cena e na próxima)" : ""}`)
          .join("\n")}`
      : "",
  ];
  return [fixed.filter(Boolean).join("\n"), parts.filter(Boolean).join("\n")];
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
 * saltos de meio orçamento, contados desde a 1ª mensagem: fica igual por vários turnos, e o cache do histórico vale
 * de um turno para o outro (uma janela que perde a mais antiga a cada turno muda o começo e regrava tudo).
 * O que sobra fica entre metade do orçamento (menos uma mensagem) e o orçamento inteiro.
 */
export function windowStart(lengths: number[], budget: number): number {
  const total = lengths.reduce((a, n) => a + n, 0);
  const step = Math.max(Math.round(budget / 2), 1);
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
  const rows = await q<Pick<GameMessage, "role" | "content">>(
    `SELECT role, content FROM messages
     WHERE campaign_id = $1 AND role IN ('player','gm','system') AND NOT compacted
     ORDER BY id`,
    [campaignId]
  );
  let i = windowStart(rows.map((m) => m.content.length), budgetTokens * CHARS_PER_TOKEN);
  while (i < rows.length && rows[i].role !== "player") i++; // a API da Anthropic quer o 1º turno do usuário
  return rows.slice(i).map((m) => ({ role: m.role === "player" ? "user" : "assistant", content: m.content }));
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
  regen?: { feedback: string }
): Promise<void> {
  // status por fase: a tela acende "consultando", "dados" e "escrevendo" por estas palavras
  emit({ type: "status", text: "Lendo a cena..." });
  // a busca de memórias (embedding da ação, ida à rede) corre junto da foto e das leituras do banco
  const adv = await getAdvanced(); // cache no processo
  const candidatesP = candidateMemories(campaignId, playerInput, adv);
  candidatesP.catch(() => {}); // o erro sobe no await abaixo, sem virar rejeição solta antes dele
  // até autoTopK (2) trechos antigos do chat muito parecidos com a ação: só entram se o Jev aprovar com folga
  const pastP = playerInput && adv.history.autoTopK
    ? searchHistory(campaignId, playerInput, { limit: adv.history.autoTopK, auto: true }).catch((): HistoryHit[] => [])
    : Promise.resolve([]);
  // foto do estado antes do turno, para poder gerar a resposta de novo depois
  await takeSnapshot(campaignId, playerInput);
  const [campaign, firstScene, chars, gm] = await Promise.all([
    getCampaign(campaignId),
    getCurrentScene(campaignId),
    getCharacters(campaignId),
    getAgent("gm"),
  ]);
  let scene = firstScene;
  const params = gm.params as { historyBudgetTokens?: number; maxToolRounds?: number; complexModel?: string };
  const complexModel = params.complexModel?.trim();

  await saveMessage(campaignId, scene.id, "player", playerInput);

  const [history, candidates, pastHits] = await Promise.all([
    historyWindow(campaignId, params.historyBudgetTokens ?? 9000),
    candidatesP,
    pastP,
  ]);

  // Jev, numa chamada só: modelo do turno (1), busca web (2) e filtro de memórias (4)
  const activeArc = campaign.script?.arcs.find((a) => a.status === "active");
  const lastGm = [...history].reverse().find((m) => m.role === "assistant");
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
      lastGmNarration: typeof lastGm?.content === "string" ? lastGm.content : "",
      playerAction: playerInput,
      memories: candidates,
      history: pastHits.map((h) => ({ id: h.id, text: historyLine(h, playerInput, adv.history.excerptChars) })),
      askComplexity: !!complexModel,
      askWeb: gm.web_search,
    },
    campaignId
  );
  // modelo decidido uma vez e mantido em todas as rodadas; falha do Jev = modelo principal
  const turnModel = complexModel && decision.complex ? complexModel : gm.model;
  // falha do Jev = web conforme o agente
  const useWeb = gm.web_search && decision.web !== false;
  const memories = candidates.filter((m) => decision.keepMemory(m.id, m.importance));
  const past = pastHits.filter((h) => decision.keepHistory(h.id));

  const [fixed, turn] = await buildGmSystem(
    campaign,
    scene,
    chars,
    memories,
    past.length ? formatHistory(past, playerInput, adv.history.excerptChars) : "",
    gm.system_prompt
  );
  // a janela foi lida depois de salvar a ação: ela sai do fim e volta depois do contexto do turno
  const tail = history[history.length - 1];
  if (tail?.role === "user" && tail.content === playerInput) history.pop();
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
  if (regen) {
    // nota fora do jogo só no prompt; a mensagem salva continua sendo a ação original
    const last = messages[messages.length - 1];
    last.content = `${last.content}\n\n(Nota do jogador ao Mestre, fora do jogo: ele pediu para você escrever de novo a resposta a esta ação. ${
      regen.feedback.trim()
        ? `Motivo, que tem prioridade: ${regen.feedback.trim()}`
        : "Sem motivo específico: escreva uma versão diferente, com outro rumo ou outra abordagem."
    })`;
  }

  const toolCtx: ToolContext = { campaign, scene, emit };
  const maxRounds = params.maxToolRounds ?? 8;
  let finalText = "";
  // narração de rodadas que também chamaram ferramentas (ex.: narra e chama advance_time no fim):
  // vale como parte da resposta; a rodada seguinte continua dela
  let kept = "";
  let keptChoices: string[] = [];
  let finalChoices: string[] = [];
  let timeMoved = false; // o Mestre chamou advance_time/set_time/train neste turno
  let npcGate = false; // a narração já voltou uma vez por NPC sem registro
  const deferred: ToolCall[] = []; // anotações do Mestre (DEFERRED_TOOLS), aplicadas depois da narração
  const done: string[] = []; // o que as ferramentas do Mestre já fizeram, para o Escrivão não repetir

  for (let round = 0; round <= maxRounds; round++) {
    // narração em streaming: o texto da rodada vai ao jogador enquanto chega, depois do que já ficou;
    // só o portão de NPC descarta tudo (narration_reset) e pede a narração inteira de novo
    let roundText = "";
    let streamed = 0;
    const discardDraft = () => {
      if (streamed || kept) emit({ type: "narration_reset" });
      kept = "";
      keptChoices = [];
    };
    emit({ type: "status", text: "O Mestre está pensando..." });
    // :online só na 1ª rodada: o plugin cobra por requisição e repetiria a mesma busca a cada rodada
    const result = await chat({
      model: turnModel,
      messages,
      temperature: gm.temperature,
      max_tokens: gm.max_tokens,
      tools: GM_TURN_TOOLS,
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
    });

    const told = parseChoices(result.content || "");
    // narração com só anotações junto: elas ficam para depois e o turno acaba aqui, sem outra chamada ao modelo
    const notesOnly = result.toolCalls.length > 0 && !!told.clean && result.toolCalls.every((c) => DEFERRED_TOOLS.has(c.function.name));
    if (!result.toolCalls.length || notesOnly || round === maxRounds) {
      deferred.push(...result.toolCalls.filter((c) => DEFERRED_TOOLS.has(c.function.name)));
      finalText = [kept, told.clean].filter(Boolean).join("\n\n");
      finalChoices = told.choices.length ? told.choices : keptChoices;
      // NPC com nome falando sem estar registrado: devolve uma vez para o Mestre registrar e reescrever
      const missing = !npcGate && round < maxRounds ? unregisteredSpeakers(finalText, await getCharacters(campaignId)) : [];
      if (!missing.length) break;
      npcGate = true;
      discardDraft();
      const gate = `(Sistema, fora do jogo: ${missing.join(", ")} fala${missing.length > 1 ? "m" : ""} na narração mas não está${missing.length > 1 ? "ão" : ""} registrado${missing.length > 1 ? "s" : ""}. Chame create_npc agora para cada um (canon=true se for da obra; se já existir com outro nome, use set_npc_active nesse nome) e então escreva de novo a narração inteira deste turno, completa (inclusive o que escreveu antes das ferramentas). Se for figurante sem nome, só repita a narração inteira.)`;
      if (notesOnly) {
        // as anotações já estão na fila: a resposta delas leva o aviso (a API quer o resultado de cada ferramenta)
        messages.push({ role: "assistant", content: result.content || null, tool_calls: result.toolCalls });
        for (const call of result.toolCalls) messages.push({ role: "tool", content: NOTED, tool_call_id: call.id, name: call.function.name });
        messages[messages.length - 1].content += `\n\n${gate}`;
      } else {
        messages.push({ role: "assistant", content: result.content || "" });
        messages.push({ role: "user", content: gate });
      }
      continue;
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
        if (/^((advance|set)_time|train)$/.test(call.function.name)) timeMoved = true;
        output = await executeGmTool(call.function.name, args, toolCtx);
        scene = toolCtx.scene; // set_scene pode ter trocado a cena
      } catch (e) {
        output = `Erro: ${e instanceof Error ? e.message : String(e)}`;
      }
      if (!/^(search_|read_|get_|list_)/.test(call.function.name)) done.push(`${call.function.name} ${call.function.arguments} → ${output.slice(0, 300)}`);
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
  }

  const choices = finalChoices;
  const narration = finalText || "*(O Mestre ficou em silêncio — tente novamente.)*";
  const msgId = await saveMessage(campaignId, scene.id, "gm", narration, { choices });
  emit({ type: "narration", content: narration, messageId: msgId });
  if (choices.length) emit({ type: "choices", choices });

  // depois da narração (o jogador já está lendo); antes do done, para o "gerar novamente" não cruzar com a gravação.
  // Anotações primeiro: só SQL, e o local e o elenco abaixo leem o que set_scene marcou (sceneChanged, castSet)
  const applyNote = (call: ToolCall) =>
    executeGmTool(call.function.name, argsOf(call), toolCtx).catch((e) => console.warn(`[anotação] ${call.function.name}:`, e));
  for (const call of deferred) {
    if (call.function.name === "note_objective" || call.function.name === "map_brief") continue; // Escrivão / em paralelo abaixo
    await applyNote(call);
  }
  scene = toolCtx.scene;
  const briefs = deferred.filter((c) => c.function.name === "note_objective").map((c) => String(argsOf(c).brief || "")).filter(Boolean);
  await Promise.all([
    maybeCompact(campaignId, scene).catch(() => {}),
    // briefs de mapa chamam o Topógrafo (um modelo): correm junto, já no local que o set_scene marcou
    ...deferred.filter((c) => c.function.name === "map_brief").map(applyNote),
    // Escrivão depois do relógio: prazo relativo de missão conta da hora nova e as gravações de objetivos não se cruzam
    (timeMoved ? Promise.resolve() : fallbackClock(campaignId, campaign, scene, playerInput, narration, emit).catch(() => {}))
      .then(() => runScribe(campaignId, toolCtx, playerInput, narration, done, briefs))
      // junto da narração: o próximo turno mostra ao Mestre; o "gerar novamente" apaga com a mensagem
      .then(async (notes) => {
        if (notes.length) await q(`UPDATE messages SET meta = meta || jsonb_build_object('notes', $1::jsonb) WHERE id = $2`, [JSON.stringify(notes), msgId]);
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
 * O Mestre não trocou o local no turno e a narração levou o jogador a outro lugar: o Jev julga se ele
 * mudou, o Cronista dá o nome e o set_scene aplica (o mapa registra pelo mesmo gancho). Falhou = nada muda.
 */
export async function fallbackPlace(campaignId: string, ctx: ToolContext, playerInput: string, narration: string): Promise<void> {
  if (ctx.sceneChanged) return;
  const moved = await decideMoved(
    { scene: { mode: ctx.scene.mode, location: ctx.scene.location }, playerAction: playerInput, gmNarration: narration },
    campaignId
  );
  if (!moved) return;
  const [chronicler, map, [player]] = await Promise.all([
    getAgent("chronicler"),
    loadMap(campaignId, ctx.campaign.state),
    q<{ name: string }>(`SELECT name FROM characters WHERE campaign_id = $1 AND kind = 'player' LIMIT 1`, [campaignId]),
  ]);
  const known = map.places.map((p) => p.name).slice(-40);
  const r = await chat({
    model: chronicler.model,
    messages: [
      {
        role: "system",
        content: `Você dá nome ao lugar onde o personagem do jogador está no FIM da narração de RPG, para o mapa da campanha. Responda só o nome, do mais específico ao mais geral separado por vírgula (ex.: "Casa do Ren, Vila do Norte" ou "Loja de armas, Rua principal, Porto Velho"), sem aspas nem ponto final. Se for um lugar já conhecido, use o nome dele exatamente. Se a narração não disser onde ele está, responda só: ?`,
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
  const location = placeName(r.content, ctx.scene.location);
  if (location) await executeGmTool("set_scene", { location }, ctx);
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

const SCRIBE_TOOL_DEFS = GM_TOOLS.filter((t) => SCRIBE_TOOLS.has(t.function.name));

/**
 * Escrivão: depois da narração, registra nas fichas o que a ação e a narração estabeleceram (recursos, itens, XP,
 * domínio por evento, memórias e missões, inclusive as anotações note_objective do Mestre). Essas ferramentas saíram
 * do Mestre: cada uma custava outra rodada com o prompt inteiro dele. Uma chamada com as ferramentas em paralelo e,
 * só se alguma deu erro, uma segunda para corrigir. Falhou = nada muda.
 */
async function runScribe(
  campaignId: string,
  ctx: ToolContext,
  playerInput: string,
  narration: string,
  done: string[],
  briefs: string[]
): Promise<string[]> {
  const applied: string[] = []; // o que gravou, para o Mestre saber no próximo turno
  const [agent, campaign, chars] = await Promise.all([getAgent("scribe"), getCampaign(campaignId), getCharacters(campaignId)]);
  const clock = getClock(campaign.state);
  const sheet = (c: Character) =>
    sheetSummary(c, false, campaign.ruleset) +
    (c.sheet.inventory.length ? `\n  inventário: ${c.sheet.inventory.map((i) => `${i.qty}x ${i.name}`).join(", ")}` : "");
  const npcs = chars.filter((c) => c.kind === "npc" && c.active);
  const player = chars.find((c) => c.kind === "player");
  const state = [
    `Hora na história: ${clock ? `${formatClock(clock.minutes)} (${period(clock.minutes)})` : "não definida (missão só sem prazo)"}`,
    objectivesPromptBlock(getObjectives(campaign.state), clock?.minutes ?? null),
    `REGRA DE XP DA MESA: ${xpRuleText(getTable(campaign.state))}.`,
    player ? `\n--- JOGADOR ---\n${sheet(player)}` : "",
    npcs.length ? `\n--- NPCs EM CENA ---\n${npcs.map(sheet).join("\n")}` : "",
  ];
  const messages: ChatMessage[] = [
    { role: "system", content: agent.system_prompt },
    {
      role: "user",
      content: `--- ESTADO ---\n${state.filter(Boolean).join("\n")}\n\n--- AÇÃO DO JOGADOR ---\n${playerInput}\n\n--- NARRAÇÃO DO MESTRE ---\n${narration}\n\n--- JÁ FEITO PELO MESTRE NESTE TURNO (não repita) ---\n${
        done.join("\n") || "(nada)"
      }${briefs.length ? `\n\n--- ANOTAÇÕES DE MISSÃO DO MESTRE ---\n${briefs.map((b) => `- ${b}`).join("\n")}` : ""}`,
    },
  ];
  const tctx: ToolContext = { ...ctx, campaign }; // estado novo: relógio já andado e fichas depois das ferramentas do Mestre
  for (let round = 0; round < 2; round++) {
    const r = await chat({
      model: agent.model,
      messages,
      temperature: agent.temperature,
      max_tokens: agent.max_tokens,
      reasoning: agent.params.reasoning as Record<string, unknown> | undefined,
      tools: SCRIBE_TOOL_DEFS,
      agentId: "scribe",
      campaignId,
      purpose: round ? "anotações do turno (correção)" : "anotações do turno",
    });
    if (!r.toolCalls.length) return applied;
    messages.push({ role: "assistant", content: r.content || null, tool_calls: r.toolCalls });
    let failed = false;
    for (const call of r.toolCalls) {
      const out = SCRIBE_TOOLS.has(call.function.name)
        ? await executeGmTool(call.function.name, argsOf(call), tctx).catch((e) => `Erro: ${e instanceof Error ? e.message : String(e)}`)
        : `Erro: ${call.function.name} não é ferramenta do Escrivão.`;
      if (/^Erro|não existe|precisa/.test(out)) failed = true;
      else applied.push(`${call.function.name} ${call.function.arguments} → ${out}`.slice(0, 240));
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

export async function maybeCompact(campaignId: string, scene: Scene): Promise<void> {
  const chronicler = await getAgent("chronicler");
  const params = chronicler.params as {
    compactThresholdTokens?: number;
    keepRecentMessages?: number;
  };
  const threshold = params.compactThresholdTokens ?? 11000;
  const keep = params.keepRecentMessages ?? 12;

  const rows = await q<{ id: number; role: string; content: string; tokens: number }>(
    `SELECT id, role, content, COALESCE(tokens, 0) AS tokens FROM messages
     WHERE campaign_id = $1 AND role IN ('player','gm') AND NOT compacted
     ORDER BY id`,
    [campaignId]
  );
  const total = rows.reduce((a, r) => a + r.tokens, 0);
  if (total < threshold || rows.length <= keep) return;

  const toCompact = rows.slice(0, rows.length - keep);
  const transcript = toCompact
    .map((r) => `${r.role === "player" ? "JOGADOR" : "MESTRE"}: ${r.content}`)
    .join("\n\n");

  const result = await chat({
    model: chronicler.model,
    messages: [
      { role: "system", content: chronicler.system_prompt },
      {
        role: "user",
        content: `Resumo anterior acumulado (contexto, não repita):\n${scene.summary || "(vazio)"}\n\nTrecho da sessão a compactar:\n${transcript}`,
      },
    ],
    temperature: chronicler.temperature,
    max_tokens: chronicler.max_tokens,
    agentId: "chronicler",
    campaignId,
    purpose: "compactação de histórico",
  });

  let parsed: {
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
  const importance = await scoreImportance(
    (await getCampaign(campaignId)).ruleset.name,
    mems,
    campaignId
  );
  for (const [i, m] of mems.entries())
    await addMemory(campaignId, m.kind || "event", m.content, m.subject || null, importance[i]);
}

// ---------- roteirista ----------

export async function generateScript(campaign: Campaign): Promise<CampaignScript | null> {
  const writer = await getAgent("scriptwriter");
  const chars = await getCharacters(campaign.id);
  const player = chars.find((c) => c.kind === "player");
  const result = await chat({
    model: writer.model,
    messages: [
      { role: "system", content: writer.system_prompt },
      {
        role: "user",
        content: `MECÂNICA/CENÁRIO:\n${rulesetPromptSummary(campaign.ruleset)}\n\nPERSONAGEM DO JOGADOR:\n${
          player ? sheetSummary(player, true, campaign.ruleset) : "(não criado)"
        }\n\nMonte o roteiro da campanha "${campaign.name}".${
          campaign.ruleset.canonBased
            ? " O cenário é baseado em obra: ancore os arcos na linha do tempo canônica a partir do ponto de inserção do personagem."
            : ""
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
    script.arcs = script.arcs.map((a) => ({
      title: a.title || "Arco",
      summary: a.summary || "",
      canonEvents: a.canonEvents || [],
      hooks: a.hooks || [],
      status: a.status || "pending",
      notes: a.notes || [],
    }));
    if (!script.arcs.some((a) => a.status === "active") && script.arcs[0])
      script.arcs[0].status = "active";
    await q(`UPDATE campaigns SET script = $1, updated_at = now() WHERE id = $2`, [
      JSON.stringify(script),
      campaign.id,
    ]);
    return script;
  } catch {
    return null;
  }
}
