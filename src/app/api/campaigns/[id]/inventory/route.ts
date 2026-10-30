import { NextRequest, NextResponse } from "next/server";
import { q } from "@/lib/db";
import { getCharacters, getCurrentScene } from "@/lib/engine";
import { addMemory } from "@/lib/retrieval";

export const dynamic = "force-dynamic";

/**
 * POST { name, qty } → o personagem do jogador larga o item (sai da ficha).
 * Vira uma memória curta para o Mestre saber que o item ficou no local da cena.
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
  await q(`UPDATE characters SET sheet = $1, updated_at = now() WHERE id = $2`, [JSON.stringify(player.sheet), player.id]);
  await addMemory(
    id,
    "event",
    `${player.name} largou ${qty}x ${name}${scene.location ? ` em ${scene.location}` : ""}. O item ficou lá e não está mais com ${player.name}.`,
    player.name,
    2
  );
  return NextResponse.json({ ok: true, dropped: qty, left: item.qty });
}
