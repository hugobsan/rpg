import { NextRequest, NextResponse } from "next/server";
import { q } from "@/lib/db";
import { dehydrateSheet } from "@/lib/library";
import { getCharacters, getCurrentScene } from "@/lib/engine";
import { recordFact } from "@/lib/knowledge";
import { getClock } from "@/lib/clock";

export const dynamic = "force-dynamic";

/**
 * POST { name, qty } → o personagem do jogador larga o item (sai da ficha).
 * Vira um fato que quem está na cena viu, para o Narrador saber que o item ficou no local.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { name?: string; qty?: number };
  const name = String(body.name || "").trim();
  if (!name) return NextResponse.json({ error: "Informe o item." }, { status: 400 });

  const [chars, scene] = await Promise.all([getCharacters(id), getCurrentScene(id)]);
  const player = chars.find((c) => c.kind === "player");
  if (!player) return NextResponse.json({ error: "Personagem do jogador não encontrado." }, { status: 404 });
  const item = player.sheet.inventory.find((i) => i.name === name);
  if (!item) return NextResponse.json({ error: `${player.name} não tem "${name}".` }, { status: 404 });

  const qty = Math.min(Math.max(Math.floor(Number(body.qty) || 1), 1), item.qty);
  item.qty -= qty;
  player.sheet.inventory = player.sheet.inventory.filter((i) => i.qty > 0);
  await q(`UPDATE characters SET sheet = $1, updated_at = now() WHERE id = $2`, [JSON.stringify(dehydrateSheet(player.sheet)), player.id]);
  const [camp] = await q<{ state: Record<string, unknown> }>(`SELECT state FROM campaigns WHERE id = $1`, [id]);
  await recordFact(id, `${player.name} largou ${qty}x ${name}${scene.location ? ` em ${scene.location}` : ""}; o item ficou lá`, {
    sceneId: scene.id,
    minute: getClock(camp?.state)?.minutes ?? null,
  });
  return NextResponse.json({ ok: true, dropped: qty, left: item.qty });
}
