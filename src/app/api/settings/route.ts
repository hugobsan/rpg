import { NextRequest, NextResponse } from "next/server";
import { getSetting, setSetting } from "@/lib/db";
import { getEmbeddingConfig } from "@/lib/embeddings";
import { getSources, sourceView } from "@/lib/openrouter";
import { chatgptStatus } from "@/lib/chatgptAuth";

export const dynamic = "force-dynamic";

function mask(key: string): string {
  if (!key) return "";
  return key.length > 8 ? `${key.slice(0, 6)}...${key.slice(-4)}` : "***";
}

export async function GET() {
  const openrouter = await getSetting<{ apiKey?: string }>("openrouter", {});
  const { enabled, model, source } = await getEmbeddingConfig();
  const sources = (await getSources()).map(sourceView); // fontes de modelos (chave mascarada), também para os embeddings
  const ui = await getSetting<{ diceAnimation?: boolean; imageGeneration?: boolean; diceForce?: number }>("ui", {});
  return NextResponse.json({
    openrouter: {
      configured: !!(openrouter.apiKey || process.env.OPENROUTER_API_KEY),
      apiKeyMasked: mask(openrouter.apiKey || process.env.OPENROUTER_API_KEY || ""),
    },
    embeddings: { enabled, model, source },
    sources,
    chatgpt: await chatgptStatus(), // Login com ChatGPT (sem token)
    // ligadas por padrão
    ui: { diceAnimation: ui.diceAnimation !== false, imageGeneration: ui.imageGeneration !== false, diceForce: ui.diceForce ?? 1 },
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
      source: String(body.embeddings.source || "openrouter"),
    });
  if (body.ui)
    await setSetting("ui", {
      diceAnimation: !!body.ui.diceAnimation,
      imageGeneration: body.ui.imageGeneration !== false,
      diceForce: Math.min(3, Math.max(0.5, Number(body.ui.diceForce) || 1)), // multiplicador do arremesso; lixo vira 1×
    });
  return NextResponse.json({ ok: true });
}
