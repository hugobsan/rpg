import { NextRequest, NextResponse } from "next/server";
import { q } from "@/lib/db";
import { oocTalk } from "@/lib/ooc";
import { activeDirectives } from "@/lib/retrieval";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** GET → conversa fora do jogo com o Mestre + diretrizes ativas. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [notes, directives] = await Promise.all([
    q(`SELECT id, role, content, created_at::text FROM gm_notes WHERE campaign_id = $1 ORDER BY id DESC LIMIT 100`, [id]),
    activeDirectives(id),
  ]);
  return NextResponse.json({ notes: notes.reverse(), directives });
}

/** POST { text } → o Mestre responde fora do jogo e, se for uma orientação, salva como diretriz. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { text?: string };
  const text = String(body.text || "").trim().slice(0, 2000);
  if (!text) return NextResponse.json({ error: "Escreva alguma coisa." }, { status: 400 });
  try {
    return NextResponse.json(await oocTalk(id, text));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

/** DELETE ?directive=ID → o jogador desativa (apaga) uma diretriz. DELETE ?notes=all → limpa a conversa (as diretrizes ficam). */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (req.nextUrl.searchParams.get("notes") === "all") {
    await q(`DELETE FROM gm_notes WHERE campaign_id = $1`, [id]);
    return NextResponse.json({ ok: true });
  }
  const directive = Number(req.nextUrl.searchParams.get("directive"));
  if (!Number.isInteger(directive)) return NextResponse.json({ error: "Diretriz inválida" }, { status: 400 });
  await q(`DELETE FROM memories WHERE id = $1 AND campaign_id = $2 AND kind = 'directive'`, [directive, id]);
  return NextResponse.json({ ok: true });
}
