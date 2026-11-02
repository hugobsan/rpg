import { NextRequest, NextResponse } from "next/server";
import { applyFix, FixError, turns, undoScribe, type Fix } from "@/lib/corrections";

export const dynamic = "force-dynamic";

/**
 * Correção do registro pelo jogador, sem IA (src/lib/corrections.ts). Recusada durante um turno.
 * POST { undo: { messageId, index } } → desfaz um registro do Escrivão do último turno (pela etiqueta no chat).
 * POST { fix: "resource", resource, current?, max? } | { fix: "item", name, qty } (qty < 0 tira) |
 *      { fix: "mastery", ability, progress } | { fix: "xp", xp } | { fix: "objective", objective, status }
 * → { summary } (o que o Mestre lê no próximo turno) | { error }
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (turns.has(id)) return NextResponse.json({ error: "Espere o turno do Mestre terminar." }, { status: 409 });
  const body = (await req.json().catch(() => ({}))) as Fix & { undo?: { messageId: number; index: number } };
  try {
    const summary = body.undo
      ? await undoScribe(id, Number(body.undo.messageId), Number(body.undo.index))
      : await applyFix(id, body);
    return NextResponse.json({ ok: true, summary });
  } catch (e) {
    if (e instanceof FixError) return NextResponse.json({ error: e.message }, { status: 409 });
    throw e;
  }
}
