import { NextRequest, NextResponse } from "next/server";
import { q } from "@/lib/db";
import { queuePortrait } from "@/lib/portrait";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Ctx = { params: Promise<{ id: string; charId: string }> };

/** GET → o retrato em binário (SVG ou imagem). A tela pede com ?v=versão, então o cache é longo. */
export async function GET(_req: NextRequest, { params }: Ctx) {
  const { id, charId } = await params;
  if (!UUID.test(id) || !UUID.test(charId)) return new NextResponse("Retrato inválido", { status: 400 });
  const [p] = await q<{ mime: string; data: Buffer }>(
    `SELECT p.mime, p.data FROM portraits p JOIN characters c ON c.id = p.character_id
      WHERE p.character_id = $1 AND c.campaign_id = $2`,
    [charId, id]
  );
  if (!p) return new NextResponse("Sem retrato", { status: 404 });
  return new NextResponse(new Uint8Array(p.data), {
    headers: {
      "Content-Type": p.mime,
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Security-Policy": "default-src 'none'", // SVG aberto direto na aba: nada roda
    },
  });
}

/** POST → gera ou regera o retrato em segundo plano (a tela acompanha pelas tarefas). */
export async function POST(_req: NextRequest, { params }: Ctx) {
  const { id, charId } = await params;
  if (!UUID.test(id) || !UUID.test(charId)) return NextResponse.json({ error: "Personagem inválido" }, { status: 400 });
  try {
    await queuePortrait(id, charId, { force: true });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
