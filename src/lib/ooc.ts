import { q } from "./db";
import { getAgent } from "./agents";
import { chat, ChatMessage, ToolDef } from "./openrouter";
import { formatClock, getClock, period } from "./clock";
import { getObjectives, objectivesPromptBlock } from "./objectives";
import { activeDirectives, addMemory } from "./retrieval";
import { getCampaign, getCharacters, getCurrentScene, sheetSummary } from "./engine";
import { executeGmTool, GM_TOOLS, saveTable } from "./tools";
import { generateLibrary, importSheetAbilities } from "./library";
import { MAP_TOOLS } from "./map";
import { LOCAL_MAP_TOOLS } from "./cartographer";
import { DIFFICULTIES, getTable, mergeCategories, MODE_HINTS, modeHint, normalizeTable, tablePromptBlock, tableSummary } from "./table";
import type { SceneMode } from "./types";

// as ferramentas do turno, menos as que leem o roteiro e os segredos dos NPCs (spoiler) e a mensagem de NPC
// (é jogada, não conversa fora do jogo), mais remover habilidade. Mapa: as ferramentas diretas no lugar do
// map_brief, porque aqui o pedido é uma correção exata ("tira X do mapa", "junta esses dois") e é raro
const HIDDEN = ["get_script", "update_script", "get_character", "npc_message", "map_brief"];
export const OOC_GAME_TOOLS: ToolDef[] = [
  ...GM_TOOLS.filter((t) => !HIDDEN.includes(t.function.name)),
  ...MAP_TOOLS,
  ...LOCAL_MAP_TOOLS,
  {
    type: "function",
    function: {
      name: "remove_ability",
      description: "Remove da ficha de um personagem uma habilidade registrada por engano.",
      parameters: {
        type: "object",
        properties: { character: { type: "string" }, name: { type: "string", description: "nome exato da habilidade" } },
        required: ["character", "name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_library",
      description:
        "A pedido do jogador, põe o Criador de habilidades ou o de itens para criar em segundo plano N entradas da biblioteca do mundo com um foco (ex.: técnicas canônicas de um lugar ou período). Não espera terminar; o resultado aparece na aba Biblioteca.",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["ability", "item"] },
          count: { type: "number", description: "quantas (1 a 60)" },
          focus: { type: "string", description: "o foco do pedido, nas palavras do jogador" },
          canon: { type: "boolean", description: "só o que existe na obra (padrão: o da campanha)" },
        },
        required: ["kind", "count"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "import_sheet_abilities",
      description:
        "A pedido do jogador, copia para a biblioteca as habilidades que já estão nas fichas (dele e dos NPCs), com quem usa cada uma, sem criar nada novo. As que já estão na biblioteca ficam como estão.",
      parameters: { type: "object", properties: {} },
    },
  },
];
const isRead = (name: string) => /^(search_|read_|get_|list_)/.test(name);

/**
 * Conversa fora do jogo com o Mestre (gm_notes): o jogador fala como ele mesmo, não como o
 * personagem. Não entra em messages, no histórico do turno nem no snapshot. Sem roteiro e sem
 * segredos de NPC no contexto (não há o que vazar). save_directive guarda orientações como memória
 * 'directive' (subject = escopo); as ferramentas do turno atendem pedidos explícitos do jogador.
 */
const OOC_PROMPT = `Você é o Mestre desta mesa de RPG, conversando FORA DO JOGO com o jogador: a pessoa real, não o personagem. Isto não é um turno e não entra na história.

- Responda curto (1 a 4 frases), em português, como uma pessoa conversando com o jogador sobre a mesa. Não narre, não interprete NPCs, não avance a história nem diga o que vai acontecer.
- Sem spoilers: não revele o roteiro, o que vem pela frente, segredos de NPCs nem nada que o personagem não saiba. Se ele perguntar, diga com simpatia que não vai contar e que ele descobre jogando.
- Dúvidas de regra e do estado do personagem você responde pelo contexto abaixo.
- Você tem as mesmas ferramentas do turno. Use-as SÓ quando o jogador pedir algo explícito: registrar uma missão ou um lembrete com prazo (add_objective), corrigir ficha (dele ou de NPC: habilidades, domínio, atributos, recursos, itens, XP), ajustar o relógio, registrar um NPC, guardar uma memória. Não narre, não role dados por conta própria e não avance a história daqui. Só diga que mudou algo que você mudou de fato com uma ferramenta.
- Se a fala trouxer uma orientação de como conduzir a mesa daqui para a frente (o que ele quer que aconteça, como o personagem dele deve ser retratado, ritmo, tom, estilo, algo que você deve parar de fazer ou corrigir), chame save_directive uma vez por orientação (uma para o momento atual e outra geral são duas), reescrevendo cada pedido como instrução curta e autossuficiente para você mesmo ler no turno, e confirme na resposta. Pergunta, dúvida, elogio ou comentário não viram diretriz. Não salve de novo o que já está em DIRETRIZES ATIVAS.
- Se a orientação contrariar a coerência do mundo ou as regras, salve o que der e explique o limite.
- Habilidade que falta, sobra ou com domínio errado: add_ability (acrescenta ou redefine pelo nome), remove_ability ou update_ability_progress. Se a correção contrariar o momento do cânone, avise em uma frase, mas aplique se ele confirmar ou insistir.
- Dificuldade e dados são REGRAS DA MESA, não diretriz: "deixa os combates mais difíceis", "quero modo história", "sem críticos", "furtividade mais fácil" vão por set_table_rules: pedido sobre um tipo de ação (combate, furtividade, social...) vai em setCategories, sobre o jogo todo em difficulty/dcOffset; críticos em crits; ritmo de XP ("quero subir de nível mais rápido") em xp; jeito de conduzir um tipo de cena ("diálogos mais descritivos", "batalhas mais cruas") em modes, com o texto inteiro da instrução nova do modo. Orientação de dificuldade que não cabe em número ("inimigos mais espertos", "pode matar meu personagem") vai em notes. Diga em números o que mudou.`;

const TABLE_TOOL: ToolDef = {
  type: "function",
  function: {
    name: "set_table_rules",
    description: "Muda as REGRAS DA MESA a pedido do jogador. Mande só o que muda; o resto fica como está em REGRAS DA MESA.",
    parameters: {
      type: "object",
      properties: {
        difficulty: {
          type: "string",
          enum: DIFFICULTIES.map((d) => d.key),
          description: `preset geral (${DIFFICULTIES.map((d) => `${d.key} = ${d.label}, CD ${d.dcOffset >= 0 ? "+" : ""}${d.dcOffset}`).join("; ")}); traz o ajuste de CD dele`,
        },
        dcOffset: { type: "number", description: "ajuste geral da CD, -10 a 10 (troca o do preset)" },
        xp: {
          type: "object",
          description: "ritmo de XP por feito, em % do que falta para o próximo nível (mande só o que muda): min e max num feito comum, great num feito grande; inteiros 0-100, min ≤ max ≤ great",
          properties: { min: { type: "number" }, max: { type: "number" }, great: { type: "number" } },
        },
        modes: {
          type: "object",
          description: "como o Mestre conduz cada modo de cena (o texto inteiro da instrução; mande só os modos que mudam; texto vazio volta ao padrão)",
          properties: { exploration: { type: "string" }, dialogue: { type: "string" }, battle: { type: "string" }, training: { type: "string" }, downtime: { type: "string" } },
        },
        setCategories: {
          type: "array",
          description: "cria ou muda o ajuste de CD de um tipo de ação (ex: Combate +2, Furtividade -1)",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "nome do tipo de ação" },
              key: { type: "string", description: "opcional; sem ela, vem do label" },
              offset: { type: "number", description: "-10 a 10 somado à CD desse tipo" },
            },
            required: ["label", "offset"],
          },
        },
        removeCategories: { type: "array", items: { type: "string" }, description: "keys ou nomes de tipos de ação para tirar" },
        crits: { type: "boolean", description: "20 natural passa e 1 natural falha" },
        notes: { type: "string", description: "orientação livre de dificuldade; substitui a anterior (inclua o que manter; \"\" apaga)" },
      },
      required: [],
    },
  },
};

const SAVE_DIRECTIVE: ToolDef = {
  type: "function",
  function: {
    name: "save_directive",
    description: "Guarda uma orientação do jogador para valer nos próximos turnos. Só para orientações, nunca para perguntas.",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "Instrução curta e autossuficiente para o Mestre, em português." },
        kind: {
          type: "string",
          enum: ["diretriz", "preferencia", "correcao"],
          description: "diretriz: algo a conduzir ou fazer acontecer; preferencia: gosto de estilo, ritmo ou tom; correcao: algo que o Mestre errou ou deve parar de fazer.",
        },
        scope: {
          type: "string",
          enum: ["permanente", "proxima_cena"],
          description: "proxima_cena: pedido para o momento atual ou a próxima cena; permanente: vale a campanha toda.",
        },
      },
      required: ["content", "kind", "scope"],
    },
  },
};

/**
 * Modelos fracos às vezes escrevem a chamada como texto ("(save_directive: ...)") e imitam o "📌 Guardei"
 * do histórico sem salvar nada. Tira as duas coisas do texto e devolve as pseudo-chamadas para o código salvar.
 */
export function splitPseudoCalls(text: string): { clean: string; pseudo: { content: string; kind?: string; scope?: string }[] } {
  const pseudo: { content: string; kind?: string; scope?: string }[] = [];
  const clean = text
    .replace(/^.*(📌\s*Guardei|✏️\s*Ficha de).*$/gm, "")
    .replace(/\(?\s*save_directive\s*[:(]\s*(.+?)\)?\s*$/gm, (_, arg: string) => {
      const raw = arg.trim().replace(/\)+$/, "");
      try {
        const j = JSON.parse(raw);
        if (j && typeof j.content === "string") pseudo.push(j);
      } catch {
        if (raw) pseudo.push({ content: raw });
      }
      return "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { clean, pseudo };
}

/** Roda uma ferramenta do turno a pedido do jogador. "✓ ..." = mudou o jogo (vira ✏️ na resposta). */
async function runTool(
  name: string,
  rawArgs: string,
  ctx: { campaign: Awaited<ReturnType<typeof getCampaign>>; scene: Awaited<ReturnType<typeof getCurrentScene>>; emit: () => void },
  chars: Awaited<ReturnType<typeof getCharacters>>
): Promise<string> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(rawArgs || "{}");
  } catch {
    return "Erro: argumentos inválidos.";
  }
  if (HIDDEN.includes(name)) return "Erro: indisponível fora do jogo.";
  try {
    if (name === "set_table_rules") {
      const current = getTable(ctx.campaign.state);
      const patch: Record<string, unknown> = { ...args };
      if (args.setCategories || args.removeCategories)
        patch.categories = mergeCategories(
          current.categories,
          Array.isArray(args.setCategories) ? args.setCategories : [],
          Array.isArray(args.removeCategories) ? args.removeCategories.map(String) : []
        );
      const table = normalizeTable(patch, current);
      if (typeof table === "string") return `Erro: ${table}. Nada mudou.`;
      await saveTable(ctx.campaign.id, table);
      ctx.campaign.state = { ...ctx.campaign.state, table };
      return `✓ Regras da mesa: ${tableSummary(table)}`;
    }
    if (name === "generate_library") {
      const canon = typeof args.canon === "boolean" ? args.canon : ctx.campaign.ruleset.canonBased;
      const job = await generateLibrary(ctx.campaign, args.kind === "item" ? "item" : "ability", Number(args.count) || 10, String(args.focus || ""), canon);
      return job.started ? `✓ ${job.label}: começou em segundo plano; o resultado aparece na aba Biblioteca.` : `Já está rodando: ${job.label}.`;
    }
    if (name === "import_sheet_abilities") {
      const r = await importSheetAbilities(ctx.campaign);
      return `✓ Biblioteca: ${r.added.length} de ${r.total} habilidades das fichas entraram${r.added.length ? ` (${r.added.join(", ")})` : " (as outras já estavam lá)"}.`;
    }
    if (name === "remove_ability") {
      const target = chars.find((c) => c.name.toLowerCase() === String(args.character || "").toLowerCase());
      if (!target) return `Erro: personagem "${args.character}" não existe.`;
      const before = target.sheet.abilities.length;
      target.sheet.abilities = target.sheet.abilities.filter((a) => a.name.toLowerCase() !== String(args.name || "").toLowerCase());
      if (target.sheet.abilities.length === before) return `Erro: ${target.name} não tem "${args.name}".`;
      await q(`UPDATE characters SET sheet = $1, updated_at = now() WHERE id = $2`, [JSON.stringify(target.sheet), target.id]);
      return `✓ Ficha de ${target.name}: removida a habilidade ${args.name}.`;
    }
    const out = await executeGmTool(name, args, ctx);
    return isRead(name) || out.startsWith("Erro") ? out : `✓ ${out}`;
  } catch (e) {
    return `Erro: ${e instanceof Error ? e.message : String(e)}`;
  }
}

const KIND_LABEL: Record<string, string> = { diretriz: "Diretriz", preferencia: "Preferência", correcao: "Correção" };

export async function oocTalk(campaignId: string, text: string): Promise<{ reply: string; directives: string[]; changed: boolean }> {
  const [campaign, scene, chars, gm, directives, notes, story] = await Promise.all([
    getCampaign(campaignId),
    getCurrentScene(campaignId),
    getCharacters(campaignId),
    getAgent("gm"),
    activeDirectives(campaignId),
    q<{ role: string; content: string }>(
      `SELECT role, content FROM (SELECT id, role, content FROM gm_notes WHERE campaign_id = $1 ORDER BY id DESC LIMIT 12) t ORDER BY id`,
      [campaignId]
    ),
    q<{ role: string; content: string }>(
      `SELECT role, content FROM (SELECT id, role, content FROM messages
         WHERE campaign_id = $1 AND role IN ('player','gm') ORDER BY id DESC LIMIT 4) t ORDER BY id`,
      [campaignId]
    ),
  ]);
  const player = chars.find((c) => c.kind === "player");
  const clock = getClock(campaign.state);
  const npcs = chars.filter((c) => c.kind === "npc" && c.active).map((c) => c.name);

  const system = [
    OOC_PROMPT,
    `\n====== CAMPANHA: ${campaign.name} (estilo ${campaign.style}) ======`,
    `--- CENA ATUAL ---\nModo: ${scene.mode} | Local: ${scene.location || "?"} | Título: ${scene.title || "-"}\nHora na história: ${
      clock ? `${formatClock(clock.minutes)} (${period(clock.minutes)})` : "ainda não definida"
    }\nNPCs em cena: ${npcs.join(", ") || "nenhum"}${scene.summary ? `\nResumo da cena: ${scene.summary}` : ""}`,
    objectivesPromptBlock(getObjectives(campaign.state), clock?.minutes ?? null),
    tablePromptBlock(getTable(campaign.state)),
    // o texto atual de cada modo, para reescrever a pedido (set_table_rules modes)
    `\n--- MODOS DE CENA (como o Mestre conduz cada um; ajustáveis em modes) ---\n${(Object.keys(MODE_HINTS) as SceneMode[]).map((k) => `${k}: ${modeHint(getTable(campaign.state), k)}`).join("\n")}`,
    player ? `\n--- PERSONAGEM DO JOGADOR ---\n${sheetSummary(player, true, campaign.ruleset)}` : "",
    story.length
      ? `\n--- ÚLTIMOS TRECHOS DA HISTÓRIA ---\n${story
          .map((m) => `${m.role === "player" ? "JOGADOR" : "MESTRE"}: ${m.content.slice(0, 800)}`)
          .join("\n\n")}`
      : "",
    `\n--- DIRETRIZES ATIVAS ---\n${directives.map((d) => `- ${d.content}`).join("\n") || "(nenhuma)"}`,
  ]
    .filter(Boolean)
    .join("\n");

  await q(`INSERT INTO gm_notes (campaign_id, role, content) VALUES ($1, 'player', $2)`, [campaignId, text]);
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    // sem os "📌 Guardei" no histórico: o modelo imita a linha em vez de chamar a ferramenta
    ...notes.map((n): ChatMessage => ({ role: n.role === "player" ? "user" : "assistant", content: splitPseudoCalls(n.content).clean })),
    { role: "user", content: text },
  ];

  let reply = "";
  const saved: string[] = [];
  const fixes: string[] = []; // mudanças no jogo feitas de verdade pelas ferramentas
  const ctx = { campaign, scene, emit: () => {} };
  // nova rodada só para ler resultado de busca ou quando faltou a resposta (sem repetir ações)
  for (let round = 0; round < 4; round++) {
    const r = await chat({
      model: gm.model,
      messages,
      temperature: 0.5,
      max_tokens: gm.max_tokens, // modelos com raciocínio gastam tokens antes da resposta curta
      tools: [SAVE_DIRECTIVE, TABLE_TOOL, ...OOC_GAME_TOOLS],
      agentId: "gm",
      campaignId,
      purpose: "conversa fora do jogo",
    });
    const split = splitPseudoCalls(r.content);
    reply = split.clean || reply;
    const results: ChatMessage[] = [];
    // chamada escrita como texto, sem a chamada de verdade: salva pelo texto
    const calls = r.toolCalls.length
      ? r.toolCalls
      : split.pseudo.map((p, i) => ({ id: `pseudo-${i}`, type: "function" as const, function: { name: "save_directive", arguments: JSON.stringify(p) } }));
    for (const call of calls) {
      let out = "Ignorado: limite de 3 diretrizes por fala.";
      if (call.function.name !== "save_directive") {
        out = await runTool(call.function.name, call.function.arguments, ctx, chars);
        if (out.startsWith("✓")) fixes.push(out.slice(2));
      } else if (saved.length < 3) {
        let a: { content?: string; kind?: string; scope?: string } = {};
        try {
          a = JSON.parse(call.function.arguments || "{}");
        } catch {
          /* argumentos malformados: content vazio */
        }
        const content = String(a.content || "").trim().slice(0, 500);
        if (content) {
          const scope = a.scope === "proxima_cena" ? "proxima_cena" : "permanente";
          const line = `${KIND_LABEL[a.kind || ""] || "Diretriz"}: ${content}`;
          await addMemory(campaignId, "directive", line, scope, 5);
          saved.push(line);
          out = "Salvo.";
        } else out = "Erro: content vazio.";
      }
      results.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: out });
    }
    // pseudo-chamadas já foram salvas; ações não se repetem: só volta para ler buscas ou escrever a resposta
    if (!r.toolCalls.length || (split.clean && !r.toolCalls.some((c) => isRead(c.function.name)))) break;
    messages.push({ role: "assistant", content: null, tool_calls: r.toolCalls }, ...results);
  }

  const content = [
    reply || (saved.length || fixes.length ? "Anotado." : "(O Mestre não respondeu — tente de novo.)"),
    ...saved.map((d) => `📌 Guardei: ${d}`),
    ...fixes.map((f) => `✏️ ${f}`),
  ].join("\n\n");
  await q(`INSERT INTO gm_notes (campaign_id, role, content) VALUES ($1, 'gm', $2)`, [campaignId, content]);
  return { reply: content, directives: saved, changed: fixes.length > 0 };
}
