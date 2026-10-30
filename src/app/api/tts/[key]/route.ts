import { NextRequest, NextResponse } from "next/server";
import { q } from "@/lib/db";

export const dynamic = "force-dynamic";

/** GET → o áudio de uma fala do cache de TTS. A chave é o hash do conteúdo, então o cache HTTP é longo. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  if (!/^[0-9a-f]{64}$/.test(key)) return new NextResponse("Chave inválida", { status: 400 });
  const rows = await q<{ mime: string; data: Buffer }>(`SELECT mime, data FROM tts_cache WHERE key = $1`, [key]);
  if (!rows.length) return new NextResponse("Áudio não encontrado", { status: 404 });
  return new NextResponse(new Uint8Array(rows[0].data), {
    headers: { "Content-Type": rows[0].mime, "Cache-Control": "public, max-age=31536000, immutable" },
  });
}
