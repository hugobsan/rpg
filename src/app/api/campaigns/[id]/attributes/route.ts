import { NextRequest, NextResponse } from "next/server";
import { q } from "@/lib/db";
import { dehydrateSheet } from "@/lib/library";
import { getCampaign, getCharacters } from "@/lib/engine";
import { addMemory } from "@/lib/retrieval";
import { attributePoints, raiseBlocked } from "@/lib/progression";

export const dynamic = "force-dynamic";

/**
 * POST { key } → o jogador gasta 1 ponto livre (ganho pela XP) em +1 no atributo.
 * Valida saldo e teto do nível de poder; vira uma memória curta para o Mestre saber.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { key?: string };
  const key = String(body.key || "");
  const [campaign, chars] = await Promise.all([getCampaign(id), getCharacters(id)]);
  const rs = campaign.ruleset;
  const player = chars.find((c) => c.kind === "player");
  if (!player) return NextResponse.json({ error: "Personagem do jogador não encontrado." }, { status: 404 });
  const def = rs.attributes.find((a) => a.key === key);
  if (!def) return NextResponse.json({ error: `Atributo "${key}" não existe.` }, { status: 400 });
  const s = player.sheet;
  if (attributePoints(rs, s).free < 1) return NextResponse.json({ error: "Sem pontos livres." }, { status: 400 });
  const cur = s.attributes[key] ?? def.default;
  const blocked = raiseBlocked(rs, s, key, cur + 1);
  if (blocked) return NextResponse.json({ error: blocked }, { status: 400 });

  s.attributes[key] = cur + 1;
  s.attrPointsSpent = (s.attrPointsSpent ?? 0) + 1;
  await q(`UPDATE characters SET sheet = $1, updated_at = now() WHERE id = $2`, [JSON.stringify(dehydrateSheet(s)), player.id]);
  await addMemory(id, "event", `${player.name} usou 1 ponto livre de XP: ${def.label} ${cur} → ${cur + 1}.`, player.name, 2);
  return NextResponse.json({ ok: true, value: cur + 1, free: attributePoints(rs, s).free });
}
