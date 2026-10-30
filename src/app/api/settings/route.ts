import { NextRequest, NextResponse } from "next/server";
import { getSetting, setSetting } from "@/lib/db";
import { getEmbeddingConfig } from "@/lib/embeddings";

export const dynamic = "force-dynamic";

function mask(key: string): string {
  if (!key) return "";
  return key.length > 8 ? `${key.slice(0, 6)}...${key.slice(-4)}` : "***";
}

export async function GET() {
  const openrouter = await getSetting<{ apiKey?: string }>("openrouter", {});
  const { enabled, model } = await getEmbeddingConfig();
  const ui = await getSetting<{ diceAnimation?: boolean }>("ui", {});
  return NextResponse.json({
    openrouter: {
      configured: !!(openrouter.apiKey || process.env.OPENROUTER_API_KEY),
      apiKeyMasked: mask(openrouter.apiKey || process.env.OPENROUTER_API_KEY || ""),
    },
    embeddings: { enabled, model },
    ui: { diceAnimation: ui.diceAnimation !== false }, // ligada por padrão
  });
}

export async function PUT(req: NextRequest) {
  const body = await req.json();
  if (body.openrouterApiKey !== undefined)
    await setSetting("openrouter", { apiKey: String(body.openrouterApiKey).trim() });
  if (body.embeddings)
    await setSetting("embeddings", {
      enabled: !!body.embeddings.enabled,
      model: String(body.embeddings.model || "").trim(),
    });
  if (body.ui) await setSetting("ui", { diceAnimation: !!body.ui.diceAnimation });
  return NextResponse.json({ ok: true });
}
