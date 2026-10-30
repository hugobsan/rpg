import { q } from "./db";
import { getAgent } from "./agents";
import { chat, ChatMessage, ToolDef } from "./openrouter";
import { formatClock, getClock, period } from "./clock";
import { getObjectives, objectivesPromptBlock } from "./objectives";
import { activeDirectives, addMemory } from "./retrieval";
import { getCampaign, getCharacters, getCurrentScene, sheetSummary } from "./engine";
import { executeGmTool, GM_TOOLS } from "./tools";

// correção de registro de NPC (jutsus e domínio); a ficha do jogador só muda jogando
const NPC_FIX_TOOLS = [
  ...GM_TOOLS.filter((t) => ["add_ability", "update_ability_progress"].includes(t.function.name)),
  {
    type: "function" as const,
    function: {
      name: "remove_ability",
      description: "Remove da ficha de um NPC uma habilidade registrada por engano.",
      parameters: {
        type: "object",
        properties: { character: { type: "string" }, name: { type: "string", description: "nome exato da habilidade" } },
        required: ["character", "name"],
      },
    },
  },
];

/**
 * Conversa fora do jogo com o Mestre (gm_notes): o jogador fala como ele mesmo, não como o
 * personagem. Não entra em messages, no histórico do turno nem no snapshot. Sem roteiro e sem
 * segredos de NPC no contexto (não há o que vazar) e sem ferramentas de jogo: a única é
 * save_directive, que guarda a orientação como memória 'directive' (subject = escopo).
 */
const OOC_PROMPT = `Você é o Mestre desta mesa de RPG, conversando FORA DO JOGO com o jogador: a pessoa real, não o personagem. Isto não é um turno e não entra na história.

- Responda curto (1 a 4 frases), em português, como uma pessoa conversando com o jogador sobre a mesa. Não narre, não interprete NPCs, não avance a história nem diga o que vai acontecer.
- Sem spoilers: não revele o roteiro, o que vem pela frente, segredos de NPCs nem nada que o personagem não saiba. Se ele perguntar, diga com simpatia que não vai contar e que ele descobre jogando.
- Daqui você não muda o jogo: ficha, relógio, cena e itens só mudam jogando (pontos livres, na aba Ficha). Dúvidas de regra e do estado do personagem você responde pelo contexto abaixo.
- Se a fala trouxer uma orientação de como conduzir a mesa daqui para a frente (o que ele quer que aconteça, como o personagem dele deve ser retratado, ritmo, tom, estilo, algo que você deve parar de fazer ou corrigir), chame save_directive uma vez por orientação (uma para o momento atual e outra geral são duas), reescrevendo cada pedido como instrução curta e autossuficiente para você mesmo ler no turno, e confirme na resposta. Pergunta, dúvida, elogio ou comentário não viram diretriz. Não salve de novo o que já está em DIRETRIZES ATIVAS.
- Se a orientação contrariar a coerência do mundo ou as regras, salve o que der e explique o limite.
- Se o jogador apontar um erro na ficha de um NPC (jutsu que falta, que sobra ou com domínio errado), CORRIJA a ficha com add_ability (acrescenta ou redefine pelo nome), remove_ability ou update_ability_progress. Só diga que mudou algo que você mudou de fato com uma ferramenta. Se a correção contrariar o momento do cânone, avise em uma frase, mas aplique se ele confirmar ou insistir. A ficha do personagem do jogador você não muda daqui.`;

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

async function fixNpc(
  name: string,
  rawArgs: string,
  campaign: Awaited<ReturnType<typeof getCampaign>>,
  scene: Awaited<ReturnType<typeof getCurrentScene>>,
  chars: Awaited<ReturnType<typeof getCharacters>>
): Promise<string> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(rawArgs || "{}");
  } catch {
    return "Erro: argumentos inválidos.";
  }
  const target = chars.find((c) => c.name.toLowerCase() === String(args.character || "").toLowerCase());
  if (!target) return `Erro: personagem "${args.character}" não existe.`;
  if (target.kind !== "npc") return "Erro: daqui só dá para corrigir ficha de NPC; a do jogador muda jogando.";
  try {
    if (name === "remove_ability") {
      const before = target.sheet.abilities.length;
      target.sheet.abilities = target.sheet.abilities.filter((a) => a.name.toLowerCase() !== String(args.name || "").toLowerCase());
      if (target.sheet.abilities.length === before) return `Erro: ${target.name} não tem "${args.name}".`;
      await q(`UPDATE characters SET sheet = $1, updated_at = now() WHERE id = $2`, [JSON.stringify(target.sheet), target.id]);
      return `✓ Ficha de ${target.name}: removida a habilidade ${args.name}.`;
    }
    const out = await executeGmTool(name, args, { campaign, scene, emit: () => {} });
    return `✓ Ficha de ${target.name} corrigida: ${out}`;
  } catch (e) {
    return `Erro: ${e instanceof Error ? e.message : String(e)}`;
  }
}

const KIND_LABEL: Record<string, string> = { diretriz: "Diretriz", preferencia: "Preferência", correcao: "Correção" };

export async function oocTalk(campaignId: string, text: string): Promise<{ reply: string; directives: string[] }> {
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
  const fixes: string[] = []; // correções de ficha de NPC feitas de verdade
  // 2ª rodada só quando o modelo chamou a ferramenta sem escrever a resposta
  for (let round = 0; round < 2; round++) {
    const r = await chat({
      model: gm.model,
      messages,
      temperature: 0.5,
      max_tokens: gm.max_tokens, // modelos com raciocínio gastam tokens antes da resposta curta
      tools: [SAVE_DIRECTIVE, ...NPC_FIX_TOOLS],
      agentId: "gm",
      campaignId,
      purpose: "conversa fora do jogo",
    });
    const split = splitPseudoCalls(r.content);
    reply = split.clean;
    const results: ChatMessage[] = [];
    // chamada escrita como texto, sem a chamada de verdade: salva pelo texto
    const calls = r.toolCalls.length
      ? r.toolCalls
      : split.pseudo.map((p, i) => ({ id: `pseudo-${i}`, type: "function" as const, function: { name: "save_directive", arguments: JSON.stringify(p) } }));
    for (const call of calls) {
      let out = "Ignorado: limite de 3 diretrizes por fala.";
      if (call.function.name !== "save_directive") {
        out = await fixNpc(call.function.name, call.function.arguments, campaign, scene, chars);
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
    if (reply || !r.toolCalls.length) break; // pseudo-chamadas já foram salvas; não há 2ª rodada para elas
    messages.push({ role: "assistant", content: null, tool_calls: r.toolCalls }, ...results);
  }

  const content = [
    reply || (saved.length || fixes.length ? "Anotado." : "(O Mestre não respondeu — tente de novo.)"),
    ...saved.map((d) => `📌 Guardei: ${d}`),
    ...fixes.map((f) => `✏️ ${f}`),
  ].join("\n\n");
  await q(`INSERT INTO gm_notes (campaign_id, role, content) VALUES ($1, 'gm', $2)`, [campaignId, content]);
  return { reply: content, directives: saved };
}
