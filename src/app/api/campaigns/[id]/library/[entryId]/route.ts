import { NextRequest, NextResponse } from "next/server";
import { getCampaign } from "@/lib/engine";
import { deleteLibrary } from "@/lib/library";

export const dynamic = "force-dynamic";

/** DELETE → tira a entrada da biblioteca do mundo (soft delete: quem já tem continua tendo, marcada como removida). */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string; entryId: string }> }) {
  const { id, entryId } = await params;
  const ok = await deleteLibrary(await getCampaign(id), Number(entryId));
  return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Entrada não encontrada." }, { status: 404 });
}
