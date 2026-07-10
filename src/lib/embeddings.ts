import { getSetting } from "./db";

export interface EmbeddingConfig {
  enabled: boolean;
  baseUrl: string; // endpoint OpenAI-compatível (ex: https://api.openai.com/v1)
  apiKey: string;
  model: string; // ex: text-embedding-3-small
}

export const DEFAULT_EMBEDDING_CONFIG: EmbeddingConfig = {
  enabled: false,
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "text-embedding-3-small",
};

export async function getEmbeddingConfig(): Promise<EmbeddingConfig> {
  return {
    ...DEFAULT_EMBEDDING_CONFIG,
    ...(await getSetting<Partial<EmbeddingConfig>>("embeddings", {})),
  };
}

/**
 * Gera embeddings via endpoint OpenAI-compatível. Retorna null se não
 * configurado ou em erro — o retrieval cai para full-text search do Postgres.
 */
export async function embed(texts: string[]): Promise<number[][] | null> {
  const cfg = await getEmbeddingConfig();
  if (!cfg.enabled || !cfg.apiKey || texts.length === 0) return null;
  try {
    const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
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
