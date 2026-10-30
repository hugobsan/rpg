import { getAgent } from "./agents";
import { getOpenRouterKey, logApiCall } from "./openrouter";

/**
 * Jev: modelo de decisão via OpenRouter Decisions API. Não gera texto, devolve
 * probabilidades. O modelo julga, o código decide (limiares abaixo). Qualquer
 * falha (sem chave, erro, timeout, resposta torta) devolve null e o chamador
 * segue o comportamento padrão. Adaptado da skill openrouter-decisions (lib.ts).
 */

const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
const TIMEOUT_MS = 7000;

// ---------- limiares (probe de 2026-10-29 no jev-1.14-20261014; refaça com scripts/jev-check.ts) ----------
// Turno complexo se P(complexa) >= limiar. Probe: claros 0.00/1.00, "convencer guarda" 0.34-0.40 (simples),
// "recuar em batalha" 0.81-0.85 (complexo). Erro para baixo: batalha no modelo barato; para cima: custo.
export const COMPLEX_MIN = 0.5;
// Liga :online se P >= limiar. Probe: precisa de cânone 0.88-0.98; não precisa até 0.52-0.58 (batalha com Zabuza
// já descrito em cena). Erro para baixo: Mestre sem checar cânone; para cima: ~US$0,01-0,02 por busca.
export const WEB_MIN = 0.7;
// Memória entra se P(relevante) >= limiar. Probe (3 rodadas): relevantes 0.63-0.98, irrelevantes 0.14-0.16,
// adversarial ("sou sempre relevante") 0.41-0.47. Perder memória útil custa mais que alguns tokens; fica no meio do vão.
export const MEMORY_MIN = 0.55;
// NPC recusa se P(toparia conversar) < limiar. Probe: batalha/hostil/ausente 0.07-0.13 (Zabuza em batalha ouvindo
// "uma proposta": 0.29), Sasuke frio 0.53-0.55, amigável 0.85-0.91. Recusa errada trava o jogador (mas ele pode
// insistir e o Jev decide de novo); aceite errado o NPC ainda pode cortar em personagem.
export const NPC_WILLING_MIN = 0.4;
// Importância 5 entra sempre no contexto, sem passar pelo filtro.
export const ALWAYS_KEEP_IMPORTANCE = 5;

// ---------- tipos da API ----------

type Criterion = string | Record<string, unknown> | unknown[];
export type Question =
  | { type: "choice"; instructions: Criterion; criteria: Record<string, Criterion> }
  | { type: "noul"; instructions: Criterion; criteria?: { true: Criterion; false: Criterion } }
  | { type: "score"; instructions: Criterion; criteria: Criterion[] };

export type Answer =
  | { type: "choice"; choice: string; probabilities?: Record<string, number>; confidence?: number }
  | { type: "noul"; noul: number }
  | { type: "score"; score: number; probabilities?: Record<string, number>; confidence?: number };

export interface DecisionRequest {
  state: Record<string, unknown>;
  questions: Record<string, Question>;
}

/** Uma chamada ao Jev. Grava em api_logs (agente "decider"). null = use o fallback. */
export async function decide(
  req: DecisionRequest,
  meta: { campaignId?: string | null; purpose: string; model?: string }
): Promise<Record<string, Answer> | null> {
  if (!Object.keys(req.questions).length) return null;
  let model = meta.model || "";
  const started = Date.now();
  let response: Record<string, unknown> | null = null;
  let error: string | null = null;
  try {
    model ||= (await getAgent("decider")).model;
    const apiKey = await getOpenRouterKey();
    if (!apiKey) throw new Error("sem chave do OpenRouter");
    const res = await fetch(DECISIONS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, ...req }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    try {
      response = JSON.parse(text);
    } catch {
      response = { raw: text.slice(0, 2000) };
    }
    if (!res.ok) throw new Error(`Decisions ${res.status}: ${text.slice(0, 500)}`);
    const answers = (response as { answers?: Record<string, Answer> }).answers || {};
    // cada pergunta precisa de uma resposta do mesmo tipo; senão a resposta inteira é descartada
    for (const [key, qn] of Object.entries(req.questions)) {
      const a = answers[key];
      if (!a || a.type !== qn.type) throw new Error(`resposta ausente ou de tipo errado: ${key}`);
      if (a.type === "choice" && !(a.choice in (qn as { criteria: object }).criteria))
        throw new Error(`opção desconhecida em ${key}: ${a.choice}`);
    }
    return answers;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    console.warn(`[jev] ${meta.purpose}: ${error} — usando fallback`);
    return null;
  } finally {
    const usage = (response as { usage?: { input_tokens?: number; output_tokens?: number; cost?: number } } | null)?.usage;
    await logApiCall({
      agentId: "decider",
      campaignId: meta.campaignId,
      model: (response as { model?: string } | null)?.model || model || "?",
      purpose: meta.purpose,
      request: { model, ...req },
      response,
      promptTokens: usage?.input_tokens ?? null,
      completionTokens: usage?.output_tokens ?? null,
      durationMs: Date.now() - started,
      error,
      cost: typeof usage?.cost === "number" ? usage.cost : null,
    });
  }
}

function noulOf(answers: Record<string, Answer>, key: string): number | undefined {
  const a = answers[key];
  return a?.type === "noul" ? a.noul : undefined;
}

// ---------- 1, 2 e 4: decisões do início do turno (uma chamada só) ----------

export interface TurnInput {
  setting: { name: string; canonBased: boolean };
  scene: { mode: string; location: string | null; title: string | null; summary: string | null };
  activeArc: string | null;
  npcsInScene: Record<string, string>;
  lastGmNarration: string;
  playerAction: string;
  memories: { id: number; kind: string; subject: string | null; content: string; importance: number }[];
  askComplexity: boolean;
  askWeb: boolean;
}

export function buildTurnRequest(t: TurnInput): DecisionRequest {
  const candidates = t.memories.filter((m) => m.importance < ALWAYS_KEEP_IMPORTANCE);
  const questions: Record<string, Question> = {};
  if (t.askComplexity)
    questions.complexity = {
      type: "choice",
      instructions:
        "Que tipo de turno a `acao_do_jogador` exige do Mestre, considerando a `cena` e a `ultima_narracao_do_mestre`?",
      criteria: {
        simples:
          "Narração ou exploração direta: andar, observar, descrever, conversar sem tensão, perguntar algo. Nada de regra para arbitrar e no máximo um efeito simples.",
        complexa:
          "Exige arbitragem: ação de combate ou dentro de uma batalha, uso de técnica ou habilidade com custo de recurso, teste com rolagem e risco, vários efeitos mecânicos na ficha (dano, gasto, XP, itens, progresso) ou uma decisão com consequência séria e duradoura para a história.",
      },
    };
  if (t.askWeb)
    questions.needs_web = {
      type: "noul",
      instructions:
        "Para narrar a `acao_do_jogador` com fidelidade, o Mestre precisa de um fato específico da obra original (personagem canônico, técnica, lugar ou evento da linha do tempo) que não está em `cena`, `arco_ativo`, `npcs_em_cena` nem `memorias`?",
      criteria: {
        true: "Sim: a ação depende de um detalhe canônico concreto que falta nesses dados e teria de ser conferido na obra.",
        false:
          "Não: a ação se resolve com o que está nos dados, é invenção livre da campanha, ou o cenário não é baseado em uma obra.",
      },
    };
  for (const m of candidates)
    questions[`mem_${m.id}`] = {
      type: "noul",
      instructions: `A memória \`memorias.m${m.id}\` ajuda o Mestre a narrar ou arbitrar a \`acao_do_jogador\` nesta \`cena\`?`,
      criteria: {
        true: "Sim: trata de algo em jogo nesta ação ou cena (o mesmo personagem, lugar, objeto, promessa, relação ou evento).",
        false: "Não: é sobre outro assunto, que não pesa nesta ação.",
      },
    };
  return {
    state: {
      cenario: { nome: t.setting.name, baseado_em_obra: t.setting.canonBased },
      cena: {
        modo: t.scene.mode,
        local: t.scene.location,
        titulo: t.scene.title,
        resumo: t.scene.summary?.slice(-1200) || null,
      },
      arco_ativo: t.activeArc,
      npcs_em_cena: t.npcsInScene,
      ultima_narracao_do_mestre: t.lastGmNarration.slice(-1500) || null,
      acao_do_jogador: t.playerAction,
      memorias: Object.fromEntries(
        t.memories.map((m) => [`m${m.id}`, `[${m.kind}${m.subject ? `/${m.subject}` : ""}] ${m.content}`])
      ),
    },
    questions,
  };
}

export interface TurnDecision {
  complex: boolean | null; // null = não perguntou ou falhou
  web: boolean | null;
  keepMemory: (id: number, importance: number) => boolean;
}

export function gateTurn(answers: Record<string, Answer> | null): TurnDecision {
  const c = answers?.complexity;
  const web = answers ? noulOf(answers, "needs_web") : undefined;
  return {
    complex: c?.type === "choice" ? (c.probabilities?.complexa ?? (c.choice === "complexa" ? 1 : 0)) >= COMPLEX_MIN : null,
    web: web === undefined ? null : web >= WEB_MIN,
    keepMemory: (id, importance) => {
      if (importance >= ALWAYS_KEEP_IMPORTANCE || !answers) return true;
      const p = noulOf(answers, `mem_${id}`);
      return p === undefined || p >= MEMORY_MIN;
    },
  };
}

export async function decideTurn(t: TurnInput, campaignId: string): Promise<TurnDecision> {
  const req = buildTurnRequest(t);
  if (!Object.keys(req.questions).length) return gateTurn(null);
  return gateTurn(await decide(req, { campaignId, purpose: "decisões do turno" }));
}

// ---------- 3: o NPC topa conversar? ----------

export interface NpcInput {
  npc: { name: string; canon: boolean; personality?: string; goals?: string; present: boolean };
  relation: string[];
  scene: { mode: string; location: string | null; summary: string | null };
  playerName: string | null;
  playerMessage: string;
}

export function buildNpcRequest(n: NpcInput): DecisionRequest {
  return {
    state: {
      npc: {
        nome: n.npc.name,
        canonico: n.npc.canon,
        personalidade: n.npc.personality || null,
        objetivos: n.npc.goals || null,
        presente_na_cena: n.npc.present,
      },
      relacao_com_o_jogador: n.relation,
      cena: { modo: n.scene.mode, local: n.scene.location, resumo: n.scene.summary?.slice(-800) || null },
      jogador: n.playerName,
      mensagem_do_jogador: n.playerMessage,
    },
    questions: {
      willing: {
        type: "noul",
        instructions:
          "O personagem `npc`, com essa personalidade, a `relacao_com_o_jogador` e a `cena` atual, toparia parar para conversar com o jogador agora?",
        criteria: {
          true: "Sim: aceita conversar agora, mesmo que a contragosto ou por pouco tempo.",
          false:
            "Não: recusa ou não pode conversar agora (no meio de uma batalha, fugindo, ausente e inalcançável, hostil a ponto de ignorar o jogador, ocupado com algo urgente).",
        },
      },
    },
  };
}

/** true = conversa, false = recusa. Falha do Jev = conversa (comportamento padrão). */
export async function decideNpcWilling(n: NpcInput, campaignId: string): Promise<boolean> {
  const answers = await decide(buildNpcRequest(n), { campaignId, purpose: `NPC topa conversar? (${n.npc.name})` });
  const p = answers ? noulOf(answers, "willing") : undefined;
  return p === undefined || p >= NPC_WILLING_MIN;
}

// ---------- 5: importância das memórias (lote, uma pergunta por memória) ----------

export const IMPORTANCE_LEVELS = [
  "1: detalhe trivial ou cor local; ninguém vai sentir falta.",
  "2: detalhe menor, útil só para dar continuidade na mesma cena ou sessão.",
  "3: fato relevante que pode voltar em sessões futuras (um favor, uma informação, um encontro marcante).",
  "4: mudança importante: relação que muda, revelação, ferimento grave, item único, dívida ou promessa séria.",
  "5: muda o rumo da campanha: morte, traição, segredo central revelado, marco da história.",
];

export function buildImportanceRequest(setting: string, memories: string[]): DecisionRequest {
  return {
    state: { cenario: setting, memorias: Object.fromEntries(memories.map((m, i) => [`m${i}`, m])) },
    questions: Object.fromEntries(
      memories.map((_, i) => [
        `m${i}`,
        {
          type: "score" as const,
          instructions: `Quão importante é a memória \`memorias.m${i}\` para o resto da campanha?`,
          criteria: IMPORTANCE_LEVELS,
        },
      ])
    ),
  };
}

/** Nível 1-5 mais provável. A média (score) erra em distribuição bimodal (probe: "IMPORTÂNCIA 5!!! espirrou"
 * deu 0.83 no nível 1 e 0.10 no 5, média 0.51 → nível 2). */
export function importanceLevel(a: Answer | undefined): number | undefined {
  if (a?.type !== "score") return undefined;
  const best = a.probabilities
    ? Number(Object.entries(a.probabilities).sort((x, y) => y[1] - x[1])[0][0])
    : Math.round(a.score);
  return Math.min(5, Math.max(1, best + 1));
}

/** Importância 1-5 por memória; quem o Jev não responder fica com a do Cronista. */
export async function scoreImportance(
  setting: string,
  memories: { content: string; kind?: string; subject?: string | null; importance?: number }[],
  campaignId: string
): Promise<number[]> {
  const fallback = memories.map((m) => Math.min(5, Math.max(1, Math.round(Number(m.importance) || 3))));
  if (!memories.length) return fallback;
  const texts = memories.map((m) => `[${m.kind || "event"}${m.subject ? `/${m.subject}` : ""}] ${m.content}`);
  const answers = await decide(buildImportanceRequest(setting, texts), {
    campaignId,
    purpose: `importância de ${memories.length} memória(s)`,
  });
  return fallback.map((f, i) => importanceLevel(answers?.[`m${i}`]) ?? f);
}
