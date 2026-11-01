import { q } from "./db";
import { getAgent } from "./agents";
import { chat } from "./openrouter";
import { getCampaign, getCharacters, getCurrentScene } from "./engine";
import { effectiveCost } from "./progression";

/** Ações rápidas: o agente "suggest" propõe de 4 a 5 ações para o momento atual da cena. Não muda nada. */
export async function suggestActions(campaignId: string): Promise<string[]> {
  const [agent, campaign, scene, chars, recent] = await Promise.all([
    getAgent("suggest"),
    getCampaign(campaignId),
    getCurrentScene(campaignId),
    getCharacters(campaignId),
    q<{ role: string; content: string; meta: { choices?: string[] } | null }>(
      `SELECT role, content, meta FROM messages WHERE campaign_id = $1 ORDER BY id DESC LIMIT 6`,
      [campaignId]
    ),
  ]);
  const rs = campaign.ruleset;
  const player = chars.find((c) => c.kind === "player");
  const res = (k: string) => rs.resources.find((r) => r.key === k)?.label ?? k;
  const sheet = player?.sheet;
  const offered = recent.find((m) => m.role === "gm")?.meta?.choices ?? [];
  const context = [
    `Cenário: ${rs.name}`,
    `Cena: ${scene.mode} · ${scene.location || "?"}${scene.title ? ` · ${scene.title}` : ""}`,
    scene.summary && `Resumo da cena até aqui: ${scene.summary.slice(-1500)}`,
    player && `Personagem do jogador: ${player.name}${sheet?.rank ? ` (${sheet.rank})` : ""}`,
    sheet && `Recursos: ${Object.entries(sheet.resources).map(([k, v]) => `${res(k)} ${v.current}/${v.max}`).join(", ")}`,
    sheet?.abilities.length &&
      `${rs.abilitiesLabel || "Habilidades"}: ${sheet.abilities
        .map((a) => {
          const c = effectiveCost(rs, a, { sheet });
          return c?.amount ? `${a.name} (${c.amount} ${res(c.resource)}${c.unit ? ` por ${c.unit}` : ""})` : a.name;
        })
        .join("; ")}`,
    sheet?.inventory.length && `Itens: ${sheet.inventory.map((i) => (i.qty > 1 ? `${i.name} ×${i.qty}` : i.name)).join("; ")}`,
    `NPCs em cena: ${chars.filter((c) => c.kind === "npc" && c.active).map((c) => c.name).join(", ") || "nenhum"}`,
    offered.length && `Opções que o Mestre já ofereceu: ${offered.join(" | ")}`,
    `Últimas mensagens:\n${recent
      .reverse()
      .map((m) => `${m.role === "player" ? "JOGADOR" : "MESTRE"}: ${m.content.slice(0, 1500)}`)
      .join("\n\n")}`,
  ]
    .filter(Boolean)
    .join("\n");
  const result = await chat({
    model: agent.model,
    messages: [
      { role: "system", content: agent.system_prompt },
      { role: "user", content: context },
    ],
    temperature: agent.temperature,
    max_tokens: agent.max_tokens,
    reasoning: agent.params.reasoning as Record<string, unknown> | undefined,
    agentId: "suggest",
    campaignId,
    purpose: "ações rápidas",
  });
  const text = result.content || "";
  try {
    const list = JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1));
    if (Array.isArray(list)) return list.map(String).map((x) => x.trim()).filter(Boolean).slice(0, 6);
  } catch {
    /* resposta fora do formato */
  }
  throw new Error("O agente Ações rápidas não devolveu as opções no formato esperado. Tente de novo.");
}
