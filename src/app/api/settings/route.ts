import { NextRequest, NextResponse } from "next/server";
import { getSetting, setSetting } from "@/lib/db";
import { DEFAULT_EMBEDDING_CONFIG, EmbeddingConfig } from "@/lib/embeddings";

export const dynamic = "force-dynamic";

function mask(key: string): string {
  if (!key) return "";
  return key.length > 8 ? `${key.slice(0, 6)}...${key.slice(-4)}` : "***";
}

export async function GET() {
  const openrouter = await getSetting<{ apiKey?: string }>("openrouter", {});
  const embeddings = {
    ...DEFAULT_EMBEDDING_CONFIG,
    ...(await getSetting<Partial<EmbeddingConfig>>("embeddings", {})),
  };
  return NextResponse.json({
    openrouter: {
      configured: !!(openrouter.apiKey || process.env.OPENROUTER_API_KEY),
      apiKeyMasked: mask(openrouter.apiKey || process.env.OPENROUTER_API_KEY || ""),
    },
    embeddings: { ...embeddings, apiKey: undefined, apiKeyMasked: mask(embeddings.apiKey) },
  });
}

export async function PUT(req: NextRequest) {
  const body = await req.json();
  if (body.openrouterApiKey !== undefined)
    await setSetting("openrouter", { apiKey: String(body.openrouterApiKey).trim() });
  if (body.embeddings) {
    const prev = await getSetting<Partial<EmbeddingConfig>>("embeddings", {});
    const next: EmbeddingConfig = {
      ...DEFAULT_EMBEDDING_CONFIG,
      ...prev,
      ...body.embeddings,
    };
    if (!body.embeddings.apiKey) next.apiKey = prev.apiKey || "";
    await setSetting("embeddings", next);
  }
  return NextResponse.json({ ok: true });
}
