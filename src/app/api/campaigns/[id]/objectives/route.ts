import { NextRequest, NextResponse } from "next/server";
import { q } from "@/lib/db";
import { getClock } from "@/lib/clock";
import { decideOffer, getObjectives } from "@/lib/objectives";
import { saveObjectives } from "@/lib/tools";
import { enterMission, getPlay } from "@/lib/story";

export const dynamic = "force-dynamic";

/**
 * POST { objective, accept } → o jogador aceita (aberto) ou recusa (cancelado) pelo painel uma missão oferecida, sem IA.
 * Aceitar entra em missão (só opções); em outra missão, só depois de terminar ou abandonar. A marca decidedAt faz o
 * Mestre reconhecer a decisão na cena do próximo turno.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { objective?: string; accept?: boolean };
  const [row] = await q<{ state: Record<string, unknown> }>(`SELECT state FROM campaigns WHERE id = $1`, [id]);
  if (!row) return NextResponse.json({ error: "Campanha não encontrada." }, { status: 404 });
  const accept = body.accept === true;
  if (accept && getPlay(row.state).mode === "mission")
    return NextResponse.json({ error: "Você está numa missão: termine ou abandone antes de aceitar outra." }, { status: 409 });
  const list = decideOffer(getObjectives(row.state), String(body.objective || ""), accept, getClock(row.state)?.minutes);
  if (typeof list === "string") return NextResponse.json({ error: list }, { status: 409 });
  await saveObjectives(id, list);
  if (accept) await enterMission(id, String(body.objective));
  return NextResponse.json({ ok: true });
}
