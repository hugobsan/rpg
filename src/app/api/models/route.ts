import { NextRequest, NextResponse } from "next/server";
import { listModels } from "@/lib/openrouter";

export const dynamic = "force-dynamic";

// o catálogo do OpenRouter muda pouco: 10 min em memória, só com os campos que as telas usam
const TTL = 10 * 60_000;
let cache: { at: number; data: unknown[] } | null = null;

/** GET /api/models (?fresh=1 ignora o cache, para testar a conexão de verdade). */
export async function GET(req: NextRequest) {
  try {
    if (!cache || Date.now() - cache.at > TTL || req.nextUrl.searchParams.has("fresh")) {
      const data = (await listModels()).map(({ id, name, context, pricing, speech, voices }) => ({
        id, name, context, pricing: { prompt: pricing.prompt, completion: pricing.completion }, speech, voices,
      }));
      cache = { at: Date.now(), data };
    }
    return NextResponse.json(cache.data);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "erro" },
      { status: 502 }
    );
  }
}
