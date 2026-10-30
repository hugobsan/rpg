import { NextRequest, NextResponse } from "next/server";
import { listModels, listSourceModels, OPENROUTER } from "@/lib/openrouter";

export const dynamic = "force-dynamic";

// os catálogos mudam pouco: 10 min em memória por fonte, só com os campos que as telas usam
const TTL = 10 * 60_000;
const cache = new Map<string, { at: number; data: unknown[] }>();

/** GET /api/models?source=id (padrão openrouter; ?fresh=1 ignora o cache, para testar a conexão de verdade). */
export async function GET(req: NextRequest) {
  const source = req.nextUrl.searchParams.get("source") || OPENROUTER;
  try {
    const hit = cache.get(source);
    if (!hit || Date.now() - hit.at > TTL || req.nextUrl.searchParams.has("fresh")) {
      const data = source === OPENROUTER
        ? (await listModels()).map(({ id, name, context, pricing, speech, voices }) => ({
            id, name, context, pricing: { prompt: pricing.prompt, completion: pricing.completion }, speech, voices,
          }))
        : await listSourceModels(source);
      cache.set(source, { at: Date.now(), data });
    }
    return NextResponse.json(cache.get(source)!.data);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "erro" },
      { status: 502 }
    );
  }
}
