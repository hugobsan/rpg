import { randomUUID } from "node:crypto";
import { q } from "./db";
import { getAdvanced } from "./advanced";
import { knownLine, knowsOf } from "./knowledge";
import { getAgent } from "./agents";
import { chat, ChatMessage } from "./openrouter";
import { indexHistory } from "./retrieval";
import { conversationEffects, getCampaign, getCurrentScene, saveMessage } from "./engine";
import { Character, InboxItem } from "./types";
import { decideNpcWilling } from "./decisions";
import { hydrateSheets } from "./library";

async function getNpc(campaignId: string, npcId: string): Promise<Character> {
  const rows = await q<Character>(
    `SELECT * FROM characters WHERE campaign_id = $1 AND id = $2 AND kind = 'npc'`,
    [campaignId, npcId]
  );
  if (!rows.length) throw new Error("NPC não encontrado");
  return (await hydrateSheets(rows))[0];
}

function npcContext(npc: Character): string {
  const s = npc.sheet;
  const p = npc.persona;
  return [
    `PERSONAGEM QUE VOCÊ INTERPRETA: ${npc.name}${npc.canon ? " (personagem canônico da obra)" : ""}`,
    `Rank: ${s.rank || "-"}`,
    p.role ? `Papel: ${p.role}` : "",
    p.age ? `Idade: ${p.age}` : "",
    p.appearance ? `Aparência: ${p.appearance}` : "",
    p.personality ? `Personalidade: ${p.personality}` : "",
    p.speech ? `Jeito de falar (siga nas falas): ${p.speech}` : "",
    p.quirks ? `Manias e gestos: ${p.quirks}` : "",
    p.current ? `Situação atual (o que vale agora; o passado abaixo é a origem): ${p.current}` : "",
    p.backstory ? `Passado: ${p.backstory}` : "",
    p.goals ? `Objetivos: ${p.goals}` : "",
    p.wants ? `O que quer agora: ${p.wants}` : "",
    p.agenda ? `O que faz por conta própria: ${p.agenda}` : "",
    p.relationships ? `Relações: ${p.relationships}` : "",
    p.secrets ? `Segredos (não revele levianamente): ${p.secrets}` : "",
    s.abilities.length
      ? `Habilidades conhecidas: ${s.abilities.map((a) => `${a.name}${a.rank ? ` (${a.rank})` : ""}`).join(", ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Conversa particular com um NPC (fora da narração do Mestre).
 * O NPC recebe persona + o bloco SABE dele (lib/knowledge: só o que viu, ouviu ou é público) + lore + cena. No início da
 * sessão o Jev decide se ele topa conversar; na recusa o próprio NPC recusa em
 * personagem e a troca não é gravada (se o jogador insistir, decide de novo).
 * divert (a fala veio do chat da campanha, engine.runTurn): na recusa não há fala do NPC, e o turno do Mestre segue.
 */
export async function npcTalk(
  campaignId: string,
  npcId: string,
  sessionId: string | null,
  playerText: string,
  divert = false
): Promise<{ sessionId: string; reply: string; refused: boolean }> {
  const npc = await getNpc(campaignId, npcId);
  const campaign = await getCampaign(campaignId);
  const scene = await getCurrentScene(campaignId);
  const agent = await getAgent("npc");
  const sid = sessionId || randomUUID();

  const [known, playerRows, [lastGm]] = await Promise.all([
    knowsOf(campaignId, npc.id, playerText, (await getAdvanced()).memory.knowsTopK),
    q<Character>(
      `SELECT * FROM characters WHERE campaign_id = $1 AND kind = 'player' LIMIT 1`,
      [campaignId]
    ),
    q<{ content: string }>(`SELECT content FROM messages WHERE campaign_id = $1 AND role = 'gm' ORDER BY id DESC LIMIT 1`, [campaignId]),
  ]);
  const player = playerRows[0];

  const [history, [first]] = await Promise.all([
    q<{ role: string; content: string }>(
      `SELECT role, content FROM npc_chats
       WHERE npc_id = $1 AND session_id = $2 ORDER BY id DESC LIMIT 30`,
      [npcId, sid]
    ),
    q<{ role: string; intent: string | null }>(
      `SELECT role, intent FROM npc_chats WHERE npc_id = $1 AND session_id = $2 ORDER BY id LIMIT 1`,
      [npcId, sid]
    ),
  ]);
  history.reverse();
  // sessão aberta pelo NPC (npc_message): ele quer conversar e sabe por quê
  const initiated = first?.role === "npc";

  const system = [
    agent.system_prompt,
    `\n--- CENÁRIO (conhecimento geral do mundo, que você pode usar) ---\n${campaign.ruleset.name}. ${campaign.ruleset.loreNotes.slice(0, 2500)}`,
    `\n--- ${npcContext(npc)}`,
    `\n--- CENA ATUAL (para julgar se a conversa é plausível agora) ---\nModo: ${scene.mode} | Local: ${scene.location || "?"}\n${scene.summary ? `Contexto: ${scene.summary.slice(-800)}` : ""}${npc.active || initiated ? "" : "\nATENÇÃO: você NÃO está presente na cena atual — a conversa só é plausível se houver como o jogador te alcançar."}`,
    // em cena, ele viu o que acabou de acontecer (a conversa costuma retomar a última fala dele na narração)
    npc.active && lastGm ? `\n--- O QUE ACABOU DE ACONTECER NA CENA (última narração do Mestre) ---\n${lastGm.content.slice(-1500)}` : "",
    initiated
      ? `\n--- POR QUE VOCÊ PROCUROU O JOGADOR (só você sabe; não recite, conduza a conversa para isso) ---\n${first.intent || "(motivo não registrado: siga pela sua mensagem)"}\nFoi você quem chamou o jogador; se foi à distância (recado, mensageiro...), a conversa segue por esse meio.`
      : "",
    player ? `\n--- QUEM FALA COM VOCÊ ---\n${player.name}` : "",
    `\n--- O QUE VOCÊ SABE DA HISTÓRIA (só isto, do mais antigo ao mais recente; o resto você não sabe: pergunte ou diga que não sabe) ---\n${
      known.map(knownLine).join("\n") || "(nada até agora: só o que acontece nesta conversa)"
    }`,
  ]
    .filter(Boolean)
    .join("\n");

  // só no início da sessão (histórico vazio): no meio da conversa o NPC corta em personagem.
  // Sessão aberta pelo NPC já tem a mensagem dele, então não passa pela recusa
  const willing =
    history.length > 0 ||
    (await decideNpcWilling(
      {
        npc: {
          name: npc.name,
          canon: npc.canon,
          personality: npc.persona.personality,
          goals: npc.persona.goals,
          present: npc.active,
        },
        relation: known.map((k) => k.text),
        scene: { mode: scene.mode, location: scene.location, summary: scene.summary },
        playerName: player?.name || null,
        playerMessage: playerText,
      },
      campaignId
    ));

  if (!willing && divert) return { sessionId: sid, reply: "", refused: true };

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: willing
        ? system
        : `${system}\n\n--- INSTRUÇÃO PARA ESTA RESPOSTA ---\nVocê NÃO vai parar para conversar agora. Recuse em personagem, numa fala curta (uma ou duas frases), coerente com a cena e com a relação com o jogador.`,
    },
    ...history.map(
      (h): ChatMessage =>
        h.role === "player"
          ? { role: "user", content: h.content }
          : { role: "assistant", content: h.content }
    ),
    { role: "user", content: playerText },
  ];

  const result = await chat({
    model: agent.model,
    messages,
    temperature: agent.temperature,
    max_tokens: agent.max_tokens,
    agentId: "npc",
    campaignId,
    purpose: willing ? `conversa com ${npc.name}` : `recusa de ${npc.name}`,
  });

  // prompts antigos gravados no banco ainda podem prefixar [RECUSA]: limpa e respeita
  const legacyRefusal = /^\s*\[RECUSA\]/.test(result.content);
  const refused = !willing || legacyRefusal;
  const reply = result.content.replace(/^\s*\[RECUSA\]\s*/, "").trim();
  if (!willing) return { sessionId: sid, reply, refused };

  await q(
    `INSERT INTO npc_chats (campaign_id, npc_id, session_id, role, content)
     VALUES ($1,$2,$3,'player',$4), ($1,$2,$3,'npc',$5)`,
    [campaignId, npcId, sid, playerText, reply]
  );
  indexHistory(campaignId).catch((e) => console.warn("[histórico]", e)); // a troca entra no histórico vetorial
  // respondeu = leu (vale também se a UI abriu a sessão sem passar por openPending)
  if (initiated) await q(`UPDATE npc_chats SET unread = FALSE WHERE session_id = $1 AND unread`, [sid]);

  return { sessionId: sid, reply, refused };
}

/**
 * Descarta a conversa sem registrar: "não era uma conversa" (o Jev mandou ao chat do NPC uma fala que era da cena).
 * As falas saem do banco e o histórico vetorial delas vai junto (FK com CASCADE); o NPC não lembra dela.
 */
export async function discardNpcChat(campaignId: string, npcId: string, sessionId: string): Promise<void> {
  await q(`DELETE FROM npc_chats WHERE campaign_id = $1 AND npc_id = $2 AND session_id = $3`, [campaignId, npcId, sessionId]);
}

/**
 * Encerra a conversa. Antes de responder: o Anotador lê a conversa inteira no lugar da narração e os efeitos dela
 * entram como num turno (tempo, missão oferecida ou aceita, item comprado ou recebido, fatos e "contou", que só o
 * jogador e o NPC ficam sabendo: ele lembra na próxima conversa, os outros não); depois uma linha 'talk' entra no chat da campanha com o começo e o
 * fim da conversa, que fica no histórico do Narrador.
 * fromCampaign (a conversa nasceu de uma ação no chat da campanha): ao mesmo tempo, o NPC faz a fala de encerramento,
 * que aparece no chat depois da linha da conversa e mostra que houve uma troca ali.
 */
export async function endNpcChat(
  campaignId: string,
  npcId: string,
  sessionId: string,
  fromCampaign = false
): Promise<{ notes: string[]; farewell: string } | { saved: 0 }> {
  const npc = await getNpc(campaignId, npcId);
  const rows = await q<{ role: string; content: string }>(
    `SELECT role, content FROM npc_chats
     WHERE npc_id = $1 AND session_id = $2 ORDER BY id`,
    [npcId, sessionId]
  );
  if (rows.length < 2) return { saved: 0 };
  const [[player], scene] = await Promise.all([
    q<{ name: string }>(`SELECT name FROM characters WHERE campaign_id = $1 AND kind = 'player' LIMIT 1`, [campaignId]),
    getCurrentScene(campaignId),
  ]);
  const you = player?.name || "Jogador";
  const transcript = rows.map((r) => `${r.role === "player" ? you : npc.name}: ${r.content}`).join("\n");
  const [notes, farewell] = await Promise.all([
    conversationEffects(campaignId, npc, transcript).catch((e): string[] => (console.warn("[anotador da conversa]", e), [])),
    fromCampaign ? npcFarewell(campaignId, npc, rows).catch((e) => (console.warn("[despedida do NPC]", e), "")) : "",
  ]);
  // conversa longa: a 1ª fala (o que o jogador foi fazer) e o fim
  const tail = transcript.length > 1500 ? `${transcript.slice(0, 300)}\n[...]\n${transcript.slice(-1200)}` : transcript;
  await saveMessage(campaignId, scene.id, "talk", `Conversa particular com ${npc.name}`, { npcId, sessionId, tail, notes, farewell }, npc.name);
  return { notes, farewell };
}

/** Fala com que o NPC fecha a conversa, vista no chat da campanha (o jogador fechou o modal e volta à cena). */
async function npcFarewell(campaignId: string, npc: Character, rows: { role: string; content: string }[]): Promise<string> {
  const agent = await getAgent("npc");
  const result = await chat({
    model: agent.model,
    messages: [
      { role: "system", content: `${agent.system_prompt}\n\n--- ${npcContext(npc)}` },
      ...rows.map((h): ChatMessage => ({ role: h.role === "player" ? "user" : "assistant", content: h.content })),
      {
        role: "user",
        content:
          "(Nota do sistema, fora do jogo: o jogador encerrou a conversa e volta para a cena. Responda só com a sua última fala, " +
          "curta (uma ou duas frases, gesto opcional entre asteriscos), fechando a conversa do jeito que ela terminou: despedida, " +
          "recado final ou reação. Sem repetir o que já disse e sem narrar o que o jogador faz.)",
      },
    ],
    temperature: agent.temperature,
    max_tokens: agent.max_tokens,
    agentId: "npc",
    campaignId,
    purpose: `despedida de ${npc.name}`,
  });
  return result.content.replace(/^\s*\[RECUSA\]\s*/, "").trim();
}

/** Mensagens de NPC não lidas, uma linha por sessão (GET da campanha). */
export async function listInbox(campaignId: string): Promise<InboxItem[]> {
  return q<InboxItem>(
    `SELECT npc_id AS "npcId", session_id AS "sessionId", COUNT(*)::int AS unread,
            (array_agg(left(content, 140) ORDER BY id DESC))[1] AS preview, MAX(created_at)::text AS at
     FROM npc_chats WHERE campaign_id = $1 AND unread
     GROUP BY npc_id, session_id ORDER BY MAX(id) DESC`,
    [campaignId]
  );
}

/** Ao abrir o NPC: a sessão com mensagem dele não lida (para continuar nela), já marcada como lida. */
export async function openPending(
  campaignId: string,
  npcId: string
): Promise<{ sessionId: string | null; messages: { role: string; content: string; created_at: string }[] }> {
  const [row] = await q<{ session_id: string }>(
    `SELECT session_id FROM npc_chats WHERE campaign_id = $1 AND npc_id = $2 AND unread ORDER BY id DESC LIMIT 1`,
    [campaignId, npcId]
  );
  if (!row) return { sessionId: null, messages: [] };
  const [messages] = await Promise.all([
    q<{ role: string; content: string; created_at: string }>(
      `SELECT role, content, created_at::text FROM npc_chats WHERE npc_id = $1 AND session_id = $2 ORDER BY id`,
      [npcId, row.session_id]
    ),
    q(`UPDATE npc_chats SET unread = FALSE WHERE campaign_id = $1 AND npc_id = $2 AND unread`, [campaignId, npcId]),
  ]);
  return { sessionId: row.session_id, messages };
}
