import { randomUUID } from "node:crypto";
import { q } from "./db";
import { getAgent } from "./agents";
import { chat, ChatMessage } from "./openrouter";
import { addMemory, searchMemories } from "./retrieval";
import { getCampaign, getCurrentScene } from "./engine";
import { Character } from "./types";

async function getNpc(campaignId: string, npcId: string): Promise<Character> {
  const rows = await q<Character>(
    `SELECT * FROM characters WHERE campaign_id = $1 AND id = $2 AND kind = 'npc'`,
    [campaignId, npcId]
  );
  if (!rows.length) throw new Error("NPC não encontrado");
  return rows[0];
}

function npcContext(npc: Character): string {
  const s = npc.sheet;
  const p = npc.persona;
  return [
    `PERSONAGEM QUE VOCÊ INTERPRETA: ${npc.name}${npc.canon ? " (personagem canônico da obra)" : ""}`,
    `Rank: ${s.rank || "-"}`,
    p.appearance ? `Aparência: ${p.appearance}` : "",
    p.personality ? `Personalidade: ${p.personality}` : "",
    p.backstory ? `Passado: ${p.backstory}` : "",
    p.goals ? `Objetivos: ${p.goals}` : "",
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
 * O NPC recebe persona + memórias de relação + contexto da cena, e pode
 * recusar a conversa (prefixo [RECUSA]) se implausível no momento.
 */
export async function npcTalk(
  campaignId: string,
  npcId: string,
  sessionId: string | null,
  playerText: string
): Promise<{ sessionId: string; reply: string; refused: boolean }> {
  const npc = await getNpc(campaignId, npcId);
  const campaign = await getCampaign(campaignId);
  const scene = await getCurrentScene(campaignId);
  const agent = await getAgent("npc");
  const sid = sessionId || randomUUID();

  const [relationMemories, playerRows] = await Promise.all([
    searchMemories(campaignId, `${npc.name} ${playerText}`, {
      subject: npc.name,
      limit: 8,
    }),
    q<Character>(
      `SELECT * FROM characters WHERE campaign_id = $1 AND kind = 'player' LIMIT 1`,
      [campaignId]
    ),
  ]);
  const player = playerRows[0];

  const history = await q<{ role: string; content: string }>(
    `SELECT role, content FROM npc_chats
     WHERE npc_id = $1 AND session_id = $2 ORDER BY id DESC LIMIT 30`,
    [npcId, sid]
  );
  history.reverse();

  const system = [
    agent.system_prompt,
    `\n--- CENÁRIO ---\n${campaign.ruleset.name}. ${campaign.ruleset.loreNotes.slice(0, 1200)}`,
    `\n--- ${npcContext(npc)}`,
    `\n--- CENA ATUAL (para julgar se a conversa é plausível agora) ---\nModo: ${scene.mode} | Local: ${scene.location || "?"}\n${scene.summary ? `Contexto: ${scene.summary.slice(-800)}` : ""}${npc.active ? "" : "\nATENÇÃO: você NÃO está presente na cena atual — a conversa só é plausível se houver como o jogador te alcançar."}`,
    player ? `\n--- QUEM FALA COM VOCÊ ---\n${player.name}` : "",
    relationMemories.length
      ? `\n--- O QUE VOCÊ LEMBRA SOBRE ESSA RELAÇÃO ---\n${relationMemories.map((m) => `- ${m.content}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const messages: ChatMessage[] = [
    { role: "system", content: system },
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
    purpose: `conversa com ${npc.name}`,
  });

  const refused = result.content.trimStart().startsWith("[RECUSA]");
  const reply = result.content.replace(/^\s*\[RECUSA\]\s*/, "").trim();

  await q(
    `INSERT INTO npc_chats (campaign_id, npc_id, session_id, role, content)
     VALUES ($1,$2,$3,'player',$4), ($1,$2,$3,'npc',$5)`,
    [campaignId, npcId, sid, playerText, reply]
  );

  return { sessionId: sid, reply, refused };
}

/**
 * Encerra a conversa: o Cronista extrai só os pontos importantes e grava como
 * memórias da campanha (o Mestre passa a "saber" o essencial; o NPC guarda tudo).
 */
export async function endNpcChat(
  campaignId: string,
  npcId: string,
  sessionId: string
): Promise<{ saved: number }> {
  const npc = await getNpc(campaignId, npcId);
  const rows = await q<{ role: string; content: string }>(
    `SELECT role, content FROM npc_chats
     WHERE npc_id = $1 AND session_id = $2 ORDER BY id`,
    [npcId, sessionId]
  );
  if (rows.length < 2) return { saved: 0 };

  const chronicler = await getAgent("chronicler");
  const transcript = rows
    .map((r) => `${r.role === "player" ? "JOGADOR" : npc.name}: ${r.content}`)
    .join("\n");
  const result = await chat({
    model: chronicler.model,
    messages: [
      { role: "system", content: chronicler.system_prompt },
      {
        role: "user",
        content: `Conversa particular entre o jogador e o NPC ${npc.name}. Extraia APENAS os pontos que o Mestre da campanha precisa saber (revelações, acordos, mudanças de relação, informações novas). Use kind "npc" ou "relationship" e subject "${npc.name}".\n\n${transcript}`,
      },
    ],
    temperature: chronicler.temperature,
    max_tokens: chronicler.max_tokens,
    agentId: "chronicler",
    campaignId,
    purpose: `resumo de conversa com ${npc.name}`,
  });

  let saved = 0;
  try {
    const parsed = JSON.parse(result.content.replace(/```json|```/g, "").trim()) as {
      memories?: { kind: string; subject?: string; content: string; importance?: number }[];
    };
    for (const m of parsed.memories || []) {
      if (m?.content) {
        await addMemory(
          campaignId,
          m.kind || "npc",
          m.content,
          m.subject || npc.name,
          m.importance ?? 3
        );
        saved++;
      }
    }
  } catch {
    /* sem memórias extraíveis */
  }
  return { saved };
}
