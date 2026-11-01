import { NextResponse } from "next/server";
import { getOpenRouterKey } from "@/lib/openrouter";

export const dynamic = "force-dynamic";

// Saldo do OpenRouter pela chave embutida: GET /api/v1/key aceita a chave comum (o /credits, da conta inteira, exige
// chave de gestão, que não faz inferência). Doc: https://openrouter.ai/docs/api-reference/limits
export async function GET() {
  const key = await getOpenRouterKey();
  if (!key) return NextResponse.json({ error: "sem chave do OpenRouter" }, { status: 400 });
  const r = await fetch("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
  const d = await r?.json().catch(() => null);
  if (!r?.ok || !d?.data) return NextResponse.json({ error: r?.status === 401 ? "chave recusada pelo OpenRouter" : `OpenRouter ${r?.status ?? "fora do ar"}` }, { status: 502 });
  // créditos do OpenRouter = US$; limit e limit_remaining são null quando a chave não tem limite
  return NextResponse.json({ limit: d.data.limit, remaining: d.data.limit_remaining, usage: d.data.usage });
}
