import { randomUUID } from "node:crypto";
import { q } from "./db";
import { getAdvanced } from "./advanced";
import { getAgent } from "./agents";
import { chat, ChatMessage } from "./openrouter";
import { addMemory, indexHistory, searchMemories } from "./retrieval";
import { getCampaign, getCurrentScene, saveMessage, scribeConversation } from "./engine";
import { Character, InboxItem } from "./types";
import { decideNpcWilling, scoreImportance } from "./decisions";
import { startJob } from "./jobs";
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
    p.backstory ? `Passado: ${p.backstory}` : "",
    p.goals ? `Objetivos: ${p.goals}` : "",
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
 * O NPC recebe persona + memórias de relação + contexto da cena. No início da
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

  const [relationMemories, playerRows, [lastGm]] = await Promise.all([
    searchMemories(campaignId, `${npc.name} ${playerText}`, {
      subject: npc.name,
      limit: (await getAdvanced()).memory.npcTopK,
    }),
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
    `\n--- CENÁRIO ---\n${campaign.ruleset.name}. ${campaign.ruleset.loreNotes.slice(0, 1200)}`,
    `\n--- ${npcContext(npc)}`,
    `\n--- CENA ATUAL (para julgar se a conversa é plausível agora) ---\nModo: ${scene.mode} | Local: ${scene.location || "?"}\n${scene.summary ? `Contexto: ${scene.summary.slice(-800)}` : ""}${npc.active || initiated ? "" : "\nATENÇÃO: você NÃO está presente na cena atual — a conversa só é plausível se houver como o jogador te alcançar."}`,
    // em cena, ele viu o que acabou de acontecer (a conversa costuma retomar a última fala dele na narração)
    npc.active && lastGm ? `\n--- O QUE ACABOU DE ACONTECER NA CENA (última narração do Mestre) ---\n${lastGm.content.slice(-1500)}` : "",
    initiated
      ? `\n--- POR QUE VOCÊ PROCUROU O JOGADOR (só você sabe; não recite, conduza a conversa para isso) ---\n${first.intent || "(motivo não registrado: siga pela sua mensagem)"}\nFoi você quem chamou o jogador; se foi à distância (recado, mensageiro...), a conversa segue por esse meio.`
      : "",
    player ? `\n--- QUEM FALA COM VOCÊ ---\n${player.name}` : "",
    relationMemories.length
      ? `\n--- O QUE VOCÊ LEMBRA SOBRE ESSA RELAÇÃO ---\n${relationMemories.map((m) => `- ${m.content}`).join("\n")}`
      : "",
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
        relation: relationMemories.map((m) => m.content),
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
 * Encerra a conversa. Antes de responder: o relógio anda pelo tempo dela e o Escrivão registra o que ela estabeleceu
 * (missão oferecida ou aceita, item comprado ou recebido...), uma chamada com a conversa inteira no lugar da narração;
 * depois uma linha 'talk' entra no chat da campanha com o fim da conversa, que vai uma vez ao próximo turno do Mestre.
 * Ao fechar e não a cada fala: uma chamada só, que vê a conversa inteira (oferecida e aceita viram um registro), e o
 * modal aberto segura o próximo turno até tudo estar gravado. Em segundo plano, o Cronista extrai só os pontos
 * importantes e grava como memórias da campanha (o Mestre passa a "saber" o essencial; o NPC guarda tudo).
 */
export async function endNpcChat(
  campaignId: string,
  npcId: string,
  sessionId: string
): Promise<{ id: number; started: boolean } | { saved: 0 }> {
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
  const notes = await scribeConversation(
    campaignId,
    `(Conversa particular de ${you} com ${npc.name}: as falas abaixo fazem as vezes da narração)`,
    transcript
  ).catch((e): string[] => (console.warn("[escrivão da conversa]", e), []));
  await saveMessage(campaignId, scene.id, "talk", `Conversa particular com ${npc.name}`, { npcId, sessionId, tail: transcript.slice(-1500), notes }, npc.name);

  // em segundo plano: o modal não espera as memórias, e o cabeçalho mostra a tarefa até elas entrarem
  return startJob(campaignId, "npc-memory", sessionId, `Memórias da conversa: ${npc.name}`, async () => {
    const chronicler = await getAgent("chronicler");
    const result = await chat({
      model: chronicler.model,
      messages: [
        { role: "system", content: chronicler.system_prompt },
        {
          role: "user",
          content: `Conversa particular entre o jogador (${you}) e o NPC ${npc.name}. Extraia APENAS os pontos que o Mestre da campanha precisa saber (revelações, acordos, mudanças de relação, informações novas). Use kind "npc" ou "relationship" e subject "${npc.name}".\n\n${transcript}`,
        },
      ],
      temperature: chronicler.temperature,
      max_tokens: chronicler.max_tokens,
      agentId: "chronicler",
      campaignId,
      purpose: `resumo de conversa com ${npc.name}`,
    });

    try {
      const parsed = JSON.parse(result.content.replace(/```json|```/g, "").trim()) as {
        memories?: { kind: string; subject?: string; content: string; importance?: number }[];
      };
      const mems = (parsed.memories || []).filter((m) => m?.content);
      // importância pelo Jev; se ele falhar, fica a do Cronista
      const importance = await scoreImportance(
        (await getCampaign(campaignId)).ruleset.name,
        mems.map((m) => ({ ...m, subject: m.subject || npc.name })),
        campaignId
      );
      for (const [i, m] of mems.entries()) {
        await addMemory(campaignId, m.kind || "npc", m.content, m.subject || npc.name, importance[i]);
      }
    } catch {
      /* sem memórias extraíveis */
    }
  });
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
