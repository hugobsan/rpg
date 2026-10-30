import { NextRequest, NextResponse } from "next/server";
import { q } from "@/lib/db";

export const dynamic = "force-dynamic";

/** GET → a imagem em binário (decodifica o data URL). Nunca muda, então o cache é longo. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; imageId: string }> }
) {
  const { id, imageId } = await params;
  if (!/^\d+$/.test(imageId)) return new NextResponse("Imagem inválida", { status: 400 });
  try {
    const rows = await q<{ data_url: string }>(
      `SELECT data_url FROM scene_images WHERE id = $1 AND campaign_id = $2`,
      [imageId, id]
    );
    const m = rows[0]?.data_url.match(/^data:([^;,]+)(;base64)?,(.*)$/s);
    if (!m) return new NextResponse("Imagem não encontrada", { status: 404 });
    const body = m[2] ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3]));
    return new NextResponse(new Uint8Array(body), {
      headers: { "Content-Type": m[1], "Cache-Control": "public, max-age=31536000, immutable" },
    });
  } catch (e) {
    return new NextResponse(e instanceof Error ? e.message : String(e), { status: 500 });
  }
}
