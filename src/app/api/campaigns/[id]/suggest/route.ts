import { NextRequest, NextResponse } from "next/server";
import { suggestActions } from "@/lib/suggest";

export const dynamic = "force-dynamic";

/** POST → { choices }: ações sugeridas para o momento atual da cena (botão Ações rápidas). */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    return NextResponse.json({ choices: await suggestActions(id) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
