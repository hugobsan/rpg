import { getSetting, setSetting } from "./db";

/**
 * Configurações avançadas: parâmetros de recuperação vetorial, indexação e limiares do Jev, por cenário. O padrão de
 * cada campo é o valor calibrado no código; o banco (settings "advanced") guarda só o que difere do padrão, então um
 * padrão recalibrado vale para quem não mexeu. A tela (components/AdvancedSettings) se monta a partir desta tabela.
 */

interface Field {
  label: string; // técnico de propósito
  help: string;
  def: number;
  min: number;
  max: number;
  step: number; // >= 1: inteiro
  reprocess?: boolean; // só vale para o já indexado depois de Reprocessar embeddings
}

export const ADVANCED_SPEC = {
  memory: {
    title: "Memórias (memories)",
    note: "Memórias não entram mais no turno do Narrador (só as diretrizes); servem à busca fora do jogo e à conversa particular com NPC.",
    fields: {
      toolTopK: { label: "search_memories top-k", help: "Resultados da ferramenta search_memories do Mestre.", def: 8, min: 1, max: 50, step: 1 },
      npcTopK: { label: "NPC top-k (subject = NPC)", help: "Memórias sobre o NPC que entram no prompt da conversa particular.", def: 8, min: 1, max: 50, step: 1 },
    },
  },
  history: {
    title: "Histórico do chat (history_chunks)",
    note: "Chunking por turno: 1 chunk = ação do jogador + narração do Mestre, ou falas do jogador + resposta do NPC. Não há split por tamanho, logo não há chunk overlap.",
    fields: {
      excerptChars: { label: "excerpt window (chars)", help: "Tamanho de cada trecho devolvido ao Mestre: a janela de frases que cobre mais termos da query. A linha do jogador (até 200) entra sempre.", def: 700, min: 200, max: 4000, step: 1 },
      toolTopK: { label: "search_history top-k", help: "Resultados da ferramenta search_history do Mestre.", def: 4, min: 1, max: 20, step: 1 },
      batch: { label: "embedding batch size", help: "Inputs por POST /embeddings ao indexar turnos e no reprocessamento (cada input é um turno inteiro).", def: 16, min: 1, max: 256, step: 1 },
    },
  },
  books: {
    title: "Livros (book_chunks)",
    note: "Chunking por página (um chunk nunca atravessa páginas), em caracteres (~3,4 por token), cortando no último \". \" depois da metade. book_pages guarda as páginas inteiras: o reprocessamento refaz o chunking com estes valores.",
    fields: {
      chunkChars: { label: "chunk size (chars)", help: "Tamanho máximo do chunk. Maior: mais contexto por hit e vetor mais diluído. Menor: hit mais preciso e mais chunks.", def: 2400, min: 200, max: 12000, step: 1, reprocess: true },
      overlapChars: { label: "chunk overlap (chars)", help: "Fim de um chunk repetido no começo do seguinte, para não partir uma ideia no meio. Máximo: metade do chunk size.", def: 0, min: 0, max: 6000, step: 1, reprocess: true },
      topK: { label: "search_lore top-k (livros)", help: "Chunks dos livros devolvidos pela ferramenta search_lore do Narrador (~1.900 caracteres cada na campanha real; o 4º e o 5º quase sempre eram ruído).", def: 3, min: 1, max: 30, step: 1 },
    },
  },
  embeddings: {
    title: "Embeddings",
    note: "Busca por kNN exato (seq scan + ORDER BY <=>), sem índice ANN (HNSW/IVFFlat): as colunas vector não têm dimensão fixa. Vetores de outra dimensão ficam fora da busca vetorial até o reprocessamento.",
    fields: {
      dimensions: { label: "embedding dimensions (Matryoshka truncation)", help: "Envia dimensions no POST /embeddings; 0 = dimensão nativa do modelo. Só modelos treinados com MRL (ex.: text-embedding-3-*) respeitam; o reprocessamento avisa se o modelo ignorar. Máx. 16000 (pgvector).", def: 0, min: 0, max: 16000, step: 1, reprocess: true },
      batch: { label: "embedding batch size", help: "Inputs por POST /embeddings no reprocessamento de memórias e chunks e na indexação de livros.", def: 64, min: 1, max: 512, step: 1 },
    },
  },
  jev: {
    title: "Jev (decisions)",
    note: "Limiares sobre as probabilidades do Jev (Decisions API). Calibrados por probe (scripts/jev-check.ts) para o build fixo do modelo (jev-1.14-20261014): fora dos padrões, o comportamento não foi medido.",
    fields: {
      complexMin: { label: "P(complexa) ≥ → modelo de turno complexo", help: "COMPLEX_MIN. Probe: claros 0,00/1,00, convencer guarda 0,34–0,40, recuar em batalha 0,81–0,85.", def: 0.5, min: 0, max: 1, step: 0.01 },
      webMin: { label: "P(precisa de cânone) ≥ → :online", help: "WEB_MIN. Probe: precisa 0,88–0,98, não precisa até 0,52–0,58. Cada busca custa ~US$ 0,01–0,02.", def: 0.7, min: 0, max: 1, step: 0.01 },
      npcWillingMin: { label: "P(NPC topa conversar) < → recusa", help: "NPC_WILLING_MIN. Probe: hostil/ausente 0,07–0,13, frio 0,53–0,55, amigável 0,85–0,91.", def: 0.4, min: 0, max: 1, step: 0.01 },
      metaMin: { label: "P(fala sobre o registro do jogo) ≥ → conversa fora do jogo", help: "META_MIN. Probe (2026-11-02, falas reais com a narração real de antes): reclamação ou pergunta sobre o registro 0,85–0,99; perguntas a NPC com \"você\", ações e treino 0,02–0,07; \"cancelou 3 missões?\" com um NPC em cena 0,74–0,78; \"por que você me deu uma tigela?\" com o Teuchi em cena 0,07–0,33 (fica turno normal). Acima: a ação (pergunta, reclamação ou correção ao Mestre sobre ficha, inventário, missões, XP, relógio ou regras) vai para a conversa fora do jogo, sem turno do Mestre nem Escrivão. Acima do meio do vão de propósito: desviar uma ação de verdade é pior que gastar um turno.", def: 0.6, min: 0, max: 1, step: 0.01 },
      genderMin: { label: "P(sexo) ≥ → voz padrão", help: "GENDER_MIN. Abaixo disso o sexo fica desconhecido (voz masculina padrão).", def: 0.7, min: 0, max: 1, step: 0.01 },
      talkMin: { label: "P(conversa à parte com um NPC em cena) ≥ → chat do NPC", help: "TALK_MIN. Pergunta: conversa à parte (papo, assunto pessoal, curiosidade, compra simples) ou fala que faz parte da cena (treino, missão, investigação, próximo passo). Batalha e treino nem perguntam. Probe (2026-11-02, 2 rodadas, casos reais): conversa à parte 0,86–0,94; falas do treino com o Genma, escolher por onde começar e informação para a missão 0,00; ação no mundo e fala para vários 0,00–0,20; agradecimento de despedida 0,59–0,61 e curiosidade com gesto 0,66–0,68 (ficam na campanha). Acima: a fala vira a 1ª mensagem da conversa particular (agente NPC, ~3 mil tokens), sem turno do Mestre (~20 mil). Alto de propósito: desviar uma fala da cena é pior que gastar um turno.", def: 0.75, min: 0, max: 1, step: 0.01 },
      bookMin: { label: "P(precisa de trecho dos livros) ≥ → 2 trechos no contexto do turno", help: "BOOK_MIN. Só com livros indexados na campanha. Probe (2026-11-02, 3 rodadas, falas reais): precisa de fato da obra 0,59–0,97 (Minato era rápido? 0,59–0,63); rotina, treino, ir com o NPC, o que já está em npcs_em_cena 0,06–0,36. Abaixo do meio do vão: errar para baixo custa uma rodada do Mestre no search_book, para cima ~400 tokens.", def: 0.45, min: 0, max: 1, step: 0.01 },
    },
  },
} satisfies Record<string, { title: string; note: string; fields: Record<string, Field> }>;

export type AdvancedSpec = typeof ADVANCED_SPEC;
export type Advanced = { [G in keyof AdvancedSpec]: { [K in keyof AdvancedSpec[G]["fields"]]: number } };

type Raw = Record<string, Record<string, unknown> | undefined>;
const mapSpec = (fn: (f: Field, g: string, k: string) => number): Advanced =>
  Object.fromEntries(
    Object.entries(ADVANCED_SPEC).map(([g, grp]) => [
      g,
      Object.fromEntries(Object.entries(grp.fields as Record<string, Field>).map(([k, f]) => [k, fn(f, g, k)])),
    ])
  ) as Advanced;

export const ADVANCED_DEFAULTS: Advanced = mapSpec((f) => f.def);

/** Lixo, ausente ou não finito vira o padrão; fora da faixa é preso nela; inteiro arredonda. */
export function normalizeAdvanced(raw: unknown): Advanced {
  const r = (raw && typeof raw === "object" ? raw : {}) as Raw;
  const a = mapSpec((f, g, k) => {
    const v = parseFloat(String(r[g]?.[k]));
    if (!Number.isFinite(v)) return f.def;
    const c = Math.min(f.max, Math.max(f.min, v));
    return f.step >= 1 ? Math.round(c) : Math.round(c * 1e4) / 1e4;
  });
  // overlap > metade do chunk faria o chunking andar menos de meio chunk por passo (ou nem andar)
  a.books.overlapChars = Math.min(a.books.overlapChars, Math.floor(a.books.chunkChars / 2));
  return a;
}

// cache curto no processo (global: o dev server do Next pode carregar o módulo mais de uma vez); salvar troca na hora
const TTL_MS = 5000;
const cache = globalThis as unknown as { __advanced?: { at: number; value: Advanced } };

export async function getAdvanced(): Promise<Advanced> {
  const c = cache.__advanced;
  if (c && Date.now() - c.at < TTL_MS) return c.value;
  const value = normalizeAdvanced(await getSetting("advanced", {}));
  cache.__advanced = { at: Date.now(), value };
  return value;
}

/** Salva (substitui) e devolve o normalizado. Grava só o que difere do padrão. */
export async function saveAdvanced(raw: unknown): Promise<Advanced> {
  const value = normalizeAdvanced(raw);
  const diff: Raw = {};
  for (const [g, grp] of Object.entries(value) as [string, Record<string, number>][])
    for (const [k, v] of Object.entries(grp))
      if (v !== (ADVANCED_DEFAULTS as unknown as Raw)[g]![k]) (diff[g] ??= {})[k] = v;
  await setSetting("advanced", diff);
  cache.__advanced = { at: Date.now(), value };
  return value;
}
