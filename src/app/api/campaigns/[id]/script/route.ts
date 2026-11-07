import { NextRequest, NextResponse } from "next/server";
import { storyView, writeArc } from "@/lib/story";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** GET → o que o jogador vê do arco ativo: título, o que está em jogo e relógios (nunca os beats). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return NextResponse.json(await storyView(id));
}

/** POST → refaz o arco ativo com o Roteirista (fallback por código se o modelo for fraco ou falhar). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await writeArc(id, "redo");
    return NextResponse.json(await storyView(id));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
