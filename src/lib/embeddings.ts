import { getSetting } from "./db";
import { authHeader, getSource } from "./openrouter";

export interface EmbeddingConfig {
  enabled: boolean;
  model: string; // id do modelo de embeddings na fonte
  source: string; // fonte de modelos (padrão OpenRouter)
}

export const DEFAULT_EMBEDDING_CONFIG: EmbeddingConfig = {
  enabled: false,
  model: "openai/text-embedding-3-small",
  source: "openrouter",
};

export async function getEmbeddingConfig(): Promise<EmbeddingConfig> {
  return {
    ...DEFAULT_EMBEDDING_CONFIG,
    ...(await getSetting<Partial<EmbeddingConfig>>("embeddings", {})),
  };
}

/**
 * Gera embeddings na fonte configurada ({url}/embeddings). Retorna null se não
 * configurado ou em erro (sem chave, fonte removida...) — o retrieval cai para full-text search do Postgres.
 */
export async function embed(texts: string[]): Promise<number[][] | null> {
  const cfg = await getEmbeddingConfig();
  if (!cfg.enabled || texts.length === 0) return null;
  try {
    const src = await getSource(cfg.source);
    const res = await fetch(`${src.url}/embeddings`, {
      method: "POST",
      headers: { ...authHeader(src), "Content-Type": "application/json" },
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
