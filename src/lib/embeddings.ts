import { getSetting } from "./db";
import { getOpenRouterKey } from "./openrouter";

export interface EmbeddingConfig {
  enabled: boolean;
  model: string; // id de modelo de embeddings do OpenRouter
}

export const DEFAULT_EMBEDDING_CONFIG: EmbeddingConfig = {
  enabled: false,
  model: "openai/text-embedding-3-small",
};

export async function getEmbeddingConfig(): Promise<EmbeddingConfig> {
  return {
    ...DEFAULT_EMBEDDING_CONFIG,
    ...(await getSetting<Partial<EmbeddingConfig>>("embeddings", {})),
  };
}

/**
 * Gera embeddings via OpenRouter. Retorna null se não
 * configurado ou em erro — o retrieval cai para full-text search do Postgres.
 */
export async function embed(texts: string[]): Promise<number[][] | null> {
  const cfg = await getEmbeddingConfig();
  const apiKey = await getOpenRouterKey();
  if (!cfg.enabled || !apiKey || texts.length === 0) return null;
  try {
    const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: cfg.model, input: texts }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      data: { index: number; embedding: number[] }[];
    };
    const out: number[][] = new Array(texts.length);
    for (const d of data.data) out[d.index] = d.embedding;
    return out;
  } catch {
    return null;
  }
}

export function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}
