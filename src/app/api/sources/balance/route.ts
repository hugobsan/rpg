import { NextResponse } from "next/server";
import { getOpenRouterKey } from "@/lib/openrouter";

export const dynamic = "force-dynamic";

// Saldo da conta do OpenRouter pela chave embutida: GET /api/v1/credits (créditos = US$ comprados e gastos na conta).
// Doc: https://openrouter.ai/docs/api-reference/get-credits
export async function GET() {
  const key = await getOpenRouterKey();
  if (!key) return NextResponse.json({ error: "sem chave do OpenRouter" }, { status: 400 });
  const r = await fetch("https://openrouter.ai/api/v1/credits", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
  const d = await r?.json().catch(() => null);
  if (!r?.ok || !d?.data) return NextResponse.json({ error: r?.status === 401 ? "chave recusada pelo OpenRouter" : `OpenRouter ${r?.status ?? "fora do ar"}` }, { status: 502 });
  return NextResponse.json({ credits: d.data.total_credits, usage: d.data.total_usage });
}
