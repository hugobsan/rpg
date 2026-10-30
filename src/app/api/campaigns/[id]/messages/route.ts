import { NextRequest, NextResponse } from "next/server";
import { messagePage, MESSAGE_PAGE, MESSAGE_PAGE_MAX } from "@/lib/messages";

export const dynamic = "force-dynamic";

/** GET ?before=<id>&limit=<n> → mensagens do chat anteriores a esse id (cursor), mais antigas primeiro. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sp = req.nextUrl.searchParams;
  const before = Number(sp.get("before"));
  const limit = Math.min(Math.floor(Number(sp.get("limit"))) || MESSAGE_PAGE, MESSAGE_PAGE_MAX);
  if (!Number.isInteger(before) || before < 1 || limit < 1)
    return NextResponse.json({ error: "before inválido" }, { status: 400 });
  try {
    return NextResponse.json(await messagePage(id, before, limit));
  } catch {
    return NextResponse.json({ error: "Campanha não encontrada" }, { status: 404 });
  }
}
