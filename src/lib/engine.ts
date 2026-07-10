import { q } from "./db";
import { getAgent } from "./agents";
import { chat, ChatMessage, estimateTokens } from "./openrouter";
import { currentMilestone, nextMilestone, rulesetPromptSummary } from "./ruleset";
import { addMemory, recentMemories, searchMemories } from "./retrieval";
import { executeGmTool, GM_TOOLS, ToolContext } from "./tools";
import {
  Campaign,
  CampaignScript,
  Character,
  GameMessage,
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

function sheetSummary(c: Character, full: boolean): string {
  const s = c.sheet;
  const res = Object.entries(s.resources)
    .map(([k, v]) => `${k} ${v.current}/${v.max}`)
    .join(", ");
  const attrs = Object.entries(s.attributes)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  const lines = [
    `${c.name} (${c.kind}${c.canon ? ", canônico" : ""}${c.active ? "" : ", FORA DE CENA"}) — rank: ${s.rank || "-"}, xp: ${s.xp}`,
    `  recursos: ${res} | atributos: ${attrs}`,
  ];
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
            if (a.progress === undefined) return `    - ${a.name}${a.rank ? ` (${a.rank})` : ""}`;
            const cur = currentMilestone(a);
            const next = nextMilestone(a);
            let line = `    - ${a.name}: ${a.progress}% de domínio`;
            if (cur) line += ` — atual: ${cur.description}`;
            if (next) line += ` | próximo marco aos ${next.threshold}%: ${next.description}`;
            return line;
          })
          .join("\n")
    );
  if (full) {
    if (s.inventory.length)
      lines.push(`  inventário: ${s.inventory.map((i) => `${i.qty}x ${i.name}`).join(", ")}`);
    const p = c.persona;
    if (p.personality) lines.push(`  personalidade: ${p.personality}`);
    if (p.backstory) lines.push(`  passado: ${p.backstory}`);
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
  battle: "Cena de BATALHA: turno a turno, tático e tenso. Descreva posições e aberturas, peça a ação do jogador, resolva com rolagens e atualize recursos. Inimigos agem com inteligência coerente.",
  training: "Cena de TREINAMENTO: progresso incremental com testes; falhas ensinam. Recompense marcos reais com habilidades/XP.",
  downtime: "Cena de DESCANSO: leve e breve; avance o tempo com resumos e cenas curtas de personagem.",
};

async function buildGmSystem(
  campaign: Campaign,
  scene: Scene,
  chars: Character[],
  playerInput: string,
  basePrompt: string
): Promise<string> {
  const player = chars.find((c) => c.kind === "player");
  const activeNpcs = chars.filter((c) => c.kind === "npc" && c.active);
  const inactiveNames = chars
    .filter((c) => c.kind === "npc" && !c.active)
    .map((c) => c.name);

  const [relevant, recent] = await Promise.all([
    playerInput ? searchMemories(campaign.id, playerInput, { limit: 6 }) : Promise.resolve([]),
    recentMemories(campaign.id, 8),
  ]);
  const seen = new Set<number>();
  const memories = [...relevant, ...recent].filter((m) =>
    seen.has(m.id) ? false : (seen.add(m.id), true)
  );

  const activeArc = campaign.script?.arcs.find((a) => a.status === "active");

  const parts = [
    basePrompt,
    `\n====== CAMPANHA: ${campaign.name} ======`,
    STYLE_INSTRUCTIONS[campaign.style] || STYLE_INSTRUCTIONS.hybrid,
    `\n--- MECÂNICA ---\n${rulesetPromptSummary(campaign.ruleset)}`,
    `\n--- CENA ATUAL (nº ${scene.seq}) ---\nModo: ${scene.mode} | Local: ${scene.location || "?"} | Título: ${scene.title || "-"}\n${MODE_HINTS[scene.mode] || ""}${scene.summary ? `\nResumo do que já aconteceu nesta cena (compactado): ${scene.summary}` : ""}`,
    player
      ? `\n--- PERSONAGEM DO JOGADOR ---\n${sheetSummary(player, true)}`
      : "",
    activeNpcs.length
      ? `\n--- NPCs EM CENA ---\n${activeNpcs.map((n) => sheetSummary(n, true)).join("\n")}`
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
  ];
  return parts.filter(Boolean).join("\n");
}

/** Janela de histórico recente dentro do orçamento de tokens. */
async function historyWindow(
  campaignId: string,
  sceneId: string,
  budgetTokens: number
): Promise<ChatMessage[]> {
  const rows = await q<GameMessage & { scene_id: string }>(
    `SELECT id, role, speaker, content, meta, created_at::text, scene_id
     FROM messages
     WHERE campaign_id = $1 AND role IN ('player','gm','system') AND NOT compacted
     ORDER BY id DESC LIMIT 60`,
    [campaignId]
  );
  const out: ChatMessage[] = [];
  let used = 0;
  for (const m of rows) {
    const t = estimateTokens(m.content);
    if (used + t > budgetTokens && out.length > 4) break;
    used += t;
    out.unshift(
      m.role === "player"
        ? { role: "user", content: m.content }
        : { role: "assistant", content: m.content }
    );
  }
  return out;
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

export async function runTurn(
  campaignId: string,
  playerInput: string,
  emit: (e: TurnEvent) => void
): Promise<void> {
  const campaign = await getCampaign(campaignId);
  let scene = await getCurrentScene(campaignId);
  const chars = await getCharacters(campaignId);
  const gm = await getAgent("gm");
  const params = gm.params as { historyBudgetTokens?: number; maxToolRounds?: number };

  await saveMessage(campaignId, scene.id, "player", playerInput);

  emit({ type: "status", text: "O Mestre está pensando..." });
  const system = await buildGmSystem(campaign, scene, chars, playerInput, gm.system_prompt);
  const history = await historyWindow(
    campaignId,
    scene.id,
    params.historyBudgetTokens ?? 9000
  );
  // a última mensagem do histórico já é o input do jogador recém-salvo? Não: janela foi lida após salvar.
  const messages: ChatMessage[] = [{ role: "system", content: system }, ...history];
  if (
    !history.length ||
    history[history.length - 1].role !== "user" ||
    history[history.length - 1].content !== playerInput
  )
    messages.push({ role: "user", content: playerInput });

  const toolCtx: ToolContext = { campaign, scene, emit };
  const maxRounds = params.maxToolRounds ?? 8;
  let finalText = "";

  for (let round = 0; round <= maxRounds; round++) {
    const result = await chat({
      model: gm.model,
      messages,
      temperature: gm.temperature,
      max_tokens: gm.max_tokens,
      tools: GM_TOOLS,
      webSearch: gm.web_search,
      agentId: "gm",
      campaignId,
      purpose: round === 0 ? "turno do jogador" : `turno (round ${round + 1})`,
    });

    if (!result.toolCalls.length || round === maxRounds) {
      finalText = result.content || finalText;
      break;
    }
    messages.push({
      role: "assistant",
      content: result.content || null,
      tool_calls: result.toolCalls,
    });
    for (const call of result.toolCalls) {
      let output: string;
      try {
        const args = JSON.parse(call.function.arguments || "{}");
        // tools de leitura emitem aqui (intenção); escrita e dados emitem no executor (resultado)
        if (/^(search_|read_|get_|list_)/.test(call.function.name)) {
          emit({
            type: "tool",
            name: call.function.name,
            summary: toolSummary(call.function.name, args),
          });
        }
        output = await executeGmTool(call.function.name, args, toolCtx);
        scene = toolCtx.scene; // set_scene pode ter trocado a cena
      } catch (e) {
        output = `Erro: ${e instanceof Error ? e.message : String(e)}`;
      }
      messages.push({
        role: "tool",
        content: output,
        tool_call_id: call.id,
        name: call.function.name,
      });
    }
  }

  const { clean, choices } = parseChoices(finalText);
  const narration = clean || "*(O Mestre ficou em silêncio — tente novamente.)*";
  const msgId = await saveMessage(campaignId, scene.id, "gm", narration, { choices });
  emit({ type: "narration", content: narration, messageId: msgId });
  if (choices.length) emit({ type: "choices", choices });

  await maybeCompact(campaignId, scene).catch(() => {});
  emit({ type: "done" });
}

function toolSummary(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "roll_dice":
      return `🎲 rolando ${args.notation}${args.reason ? ` — ${args.reason}` : ""}`;
    case "search_memories":
      return `🔍 buscando memórias: "${args.query}"`;
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
  for (const m of parsed.memories || []) {
    if (m?.content)
      await addMemory(campaignId, m.kind || "event", m.content, m.subject || null, m.importance ?? 3);
  }
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
          player ? sheetSummary(player, true) : "(não criado)"
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
