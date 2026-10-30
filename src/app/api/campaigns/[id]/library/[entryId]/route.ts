import { NextRequest, NextResponse } from "next/server";
import { deleteLibrary } from "@/lib/library";

export const dynamic = "force-dynamic";

/** DELETE → tira a entrada da biblioteca (fichas que já têm a técnica ou o item não mudam). */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string; entryId: string }> }) {
  const { id, entryId } = await params;
  const ok = await deleteLibrary(id, Number(entryId));
  return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Entrada não encontrada." }, { status: 404 });
}
