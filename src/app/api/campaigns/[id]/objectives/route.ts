import { NextRequest, NextResponse } from "next/server";
import { q } from "@/lib/db";
import { getClock } from "@/lib/clock";
import { decideOffer, getObjectives } from "@/lib/objectives";
import { saveObjectives } from "@/lib/tools";

export const dynamic = "force-dynamic";

/**
 * POST { objective, accept } → o jogador aceita (aberto) ou recusa (cancelado) pelo painel uma missão oferecida, sem IA.
 * A marca decidedAt faz o Mestre reconhecer a decisão na cena do próximo turno.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { objective?: string; accept?: boolean };
  const [row] = await q<{ state: Record<string, unknown> }>(`SELECT state FROM campaigns WHERE id = $1`, [id]);
  if (!row) return NextResponse.json({ error: "Campanha não encontrada." }, { status: 404 });
  const list = decideOffer(getObjectives(row.state), String(body.objective || ""), body.accept === true, getClock(row.state)?.minutes);
  if (typeof list === "string") return NextResponse.json({ error: list }, { status: 409 });
  await saveObjectives(id, list);
  return NextResponse.json({ ok: true });
}
