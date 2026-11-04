import { ADVANCED_DEFAULTS as D, type Advanced, getAdvanced } from "./advanced";
import { getAgent } from "./agents";
import { agentSource, authHeader, logApiCall } from "./openrouter";
import type { SceneMode } from "./types";

/**
 * Jev: modelo de decisão via Decisions API (a do OpenRouter, ou o mesmo endpoint na fonte escolhida no agente).
 * Não gera texto, devolve probabilidades. O modelo julga, o código decide (limiares abaixo). Qualquer
 * falha (sem chave, erro, timeout, resposta torta) devolve null e o chamador
 * segue o comportamento padrão. Adaptado da skill openrouter-decisions (lib.ts).
 */

// relativo à URL da fonte: no OpenRouter (https://openrouter.ai/api/v1) vira https://openrouter.ai/api/alpha/decisions
export const DECISIONS_PATH = "../alpha/decisions";
const TIMEOUT_MS = 7000;

// ---------- limiares padrão (probe de 2026-10-29 no jev-1.14-20261014; refaça com scripts/jev-check.ts) ----------
// O valor em uso vem das Configurações avançadas (lib/advanced.ts, onde mora o número); estes são os padrões.
// Turno complexo se P(complexa) >= limiar. Probe: claros 0.00/1.00, "convencer guarda" 0.34-0.40 (simples),
// "recuar em batalha" 0.81-0.85 (complexo). Erro para baixo: batalha no modelo barato; para cima: custo.
export const COMPLEX_MIN = D.jev.complexMin;
// Liga :online se P >= limiar. Probe: precisa de cânone 0.88-0.98; não precisa até 0.52-0.58 (batalha com Zabuza
// já descrito em cena). Erro para baixo: Mestre sem checar cânone; para cima: ~US$0,01-0,02 por busca.
export const WEB_MIN = D.jev.webMin;
// Memória entra se P(relevante) >= limiar. Probe (3 rodadas): relevantes 0.63-0.98, irrelevantes 0.14-0.16,
// adversarial ("sou sempre relevante") 0.41-0.47. Perder memória útil custa mais que alguns tokens; fica no meio do vão.
export const MEMORY_MIN = D.memory.jevMin;
// NPC recusa se P(toparia conversar) < limiar. Probe: batalha/hostil/ausente 0.07-0.13 (Zabuza em batalha ouvindo
// "uma proposta": 0.29), Sasuke frio 0.53-0.55, amigável 0.85-0.91. Recusa errada trava o jogador (mas ele pode
// insistir e o Jev decide de novo); aceite errado o NPC ainda pode cortar em personagem.
export const NPC_WILLING_MIN = D.jev.npcWillingMin;
// Trecho antigo do chat (recuperação automática) só entra se P(precisa) >= limiar: bem acima do das memórias
// ("com folga"), porque turno inteiro custa mais tokens que um fato. Sem probe ainda; refaça com scripts/jev-check.ts.
export const HISTORY_MIN = D.history.jevMin;
// Árbitro (use_ability/train antes do Mestre) se P(técnica da ficha ou treino) >= limiar. Sem probe ainda.
export const MECHANIC_MIN = D.jev.mechanicMin;
// Conversa fora do jogo (sem turno) se P(fala ao Mestre sobre o registro) >= limiar. Sem probe ainda; alto porque
// desviar uma ação de verdade é pior que gastar um turno com a reclamação.
export const META_MIN = D.jev.metaMin;
// Conversa 1:1 no chat do NPC (sem turno) se P(fala só com aquele NPC em cena) >= limiar. Probe (2026-11-02): só fala com ele
// 0.85-1.00; ação no mundo com ou sem fala, dois NPCs, NPC fora de cena 0.00-0.05; "sorrio e pergunto ao Teuchi..." 0.65.
// Alto pelo mesmo motivo do meta: desviar uma ação de verdade é pior que gastar um turno.
export const TALK_MIN = D.jev.talkMin;
// Trechos dos livros de referência no contexto do turno (2, curtos) se P(a ação precisa dos livros) >= limiar. Probe
// (2026-11-02, 3 rodadas): precisa de fato da obra 0.59-0.97; rotina, treino, o que já está em npcs_em_cena 0.06-0.36.
// Abaixo do meio do vão: errar para baixo custa uma rodada do Mestre no search_book; para cima, ~400 tokens à toa.
export const BOOK_MIN = D.jev.bookMin;

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
  let provider: string | undefined;
  try {
    model ||= (await getAgent("decider")).model;
    const src = await agentSource("decider");
    provider = src.id;
    const res = await fetch(new URL(DECISIONS_PATH, `${src.url}/`), {
      method: "POST",
      headers: { ...authHeader(src), "Content-Type": "application/json" },
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
      provider,
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
  history?: { id: number; text: string }[]; // trechos antigos do chat muito parecidos com a ação
  playerAbilities?: string[]; // técnicas da ficha do jogador: presente = pergunta se a ação é do Árbitro
  askComplexity: boolean;
  askWeb: boolean;
  askMeta?: boolean; // pergunta se a ação é fala fora do jogo sobre o registro (não no Continuar nem no gerar novamente)
  askTalk?: boolean; // pergunta se a ação é conversa à parte com um dos npcsInScene (idem; o chamador pula batalha e treino)
  books?: string[]; // títulos dos livros de referência indexados: presente e não vazio = pergunta se a ação precisa deles
}

export function buildTurnRequest(t: TurnInput, a: Advanced = D): DecisionRequest {
  const candidates = t.memories.filter((m) => m.importance < a.memory.alwaysKeep); // as de cima entram sem pergunta
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
  if (t.playerAbilities)
    questions.mechanic = {
      type: "noul",
      instructions:
        "A `acao_do_jogador` é o personagem do jogador usando agora uma técnica que está em `tecnicas_do_jogador`, ou um bloco de treino (praticar uma técnica ou um atributo por um tempo)?",
      criteria: {
        true: "Sim: ele executa agora uma técnica dessa lista (pelo nome ou por uma descrição inequívoca dela) ou treina.",
        false:
          "Não: outra ação (andar, falar, observar, atacar sem técnica), técnica fora da lista, ou só fala de técnica ou treino sem fazer agora (pergunta, plano, intenção).",
      },
    };
  if (t.askMeta)
    questions.meta = {
      type: "noul",
      instructions:
        "A `acao_do_jogador` é o jogador, a pessoa real, falando com o Mestre sobre o registro do jogo (uma pergunta, reclamação ou correção sobre ficha, inventário, missões, XP, relógio ou regras), e não uma ação ou fala do personagem dentro da história?",
      criteria: {
        true: "Sim: fala fora do jogo ao Mestre sobre o que foi registrado ou sobre as regras, sem ação do personagem (\"por que você me deu uma tigela?\", \"você cancelou 3 missões\", \"obs para o mestre: registrou a missão X como perdida, mas eu cumpri\", \"quanto XP eu tenho?\").",
        false:
          "Não: o personagem age, fala ou pergunta algo dentro da história, inclusive a um NPC (\"você sabe se ele comeu?\") ou sobre o que vê; ou a fala mistura uma ação do personagem com um comentário fora do jogo.",
      },
    };
  if (t.books?.length)
    questions.needs_book = {
      type: "noul",
      instructions:
        "Para narrar ou arbitrar a `acao_do_jogador` com fidelidade, o Mestre precisa de um trecho dos `livros_de_referencia` (um fato do material: personagem, técnica, lugar, evento ou regra) que não está em `cena`, `arco_ativo`, `npcs_em_cena` nem `memorias`?",
      criteria: {
        true: "Sim: a ação depende de um detalhe concreto que esses livros devem cobrir e que falta nesses dados.",
        false: "Não: a ação se resolve com o que está nos dados, é rotina da cena (andar, conversar, comer, treinar o que já sabe) ou é invenção livre da campanha.",
      },
    };
  const npcs = Object.keys(t.npcsInScene).filter((n) => n !== "nenhum");
  if (t.askTalk && npcs.length)
    questions.talk = {
      type: "choice",
      instructions:
        "A `acao_do_jogador` é o personagem do jogador puxando uma conversa à parte com UM dos `npcs_em_cena`, um papo que pode seguir em particular, fora da narração do Mestre, com a cena parada, e não uma fala que faz parte do que a cena está fazendo (veja `cena` e `ultima_narracao_do_mestre`)? Com qual?",
      criteria: {
        ...Object.fromEntries(
          npcs.map((n) => [n, `Conversa à parte com ${n}: papo social, assunto pessoal, curiosidade, histórias e lembranças, pedido ou compra simples, agradecimento; nada em andamento na cena depende da resposta e não há nada para o Mestre arbitrar.`])
        ),
        nenhum:
          "Fala que faz parte da cena: sobre a atividade em andamento (treino, missão, investigação, luta, viagem), perguntar como fazer o que está sendo ensinado, propor ou discutir um método, plano ou próximo passo, aceitar ou escolher o que fazer a seguir (\"vamos começar por...\"), colher informação para a missão. Ou: ação no mundo (entrar, ir, pegar, entregar, oferecer, treinar, atacar, usar técnica), fala junto de uma ação (\"entro e pergunto...\"), fala para vários personagens, fala com quem não está em `npcs_em_cena`, fala fora do jogo ao Mestre.",
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
  for (const h of t.history || [])
    questions[`hist_${h.id}`] = {
      type: "noul",
      instructions: `O trecho antigo do chat \`historico.h${h.id}\` traz algo que o Mestre precisa saber exatamente para narrar ou arbitrar a \`acao_do_jogador\` (o que alguém disse ou fez naquela vez e a ação retoma)?`,
      criteria: {
        true: "Sim: a ação retoma diretamente o que aconteceu no trecho (a mesma pessoa, conversa, promessa, objeto ou acontecimento) e narrar sem ele daria errado.",
        false: "Não: o trecho só se parece no assunto ou nas palavras, ou a ação se resolve sem ele.",
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
      ...(t.playerAbilities ? { tecnicas_do_jogador: t.playerAbilities } : {}),
      ...(t.books?.length ? { livros_de_referencia: t.books } : {}),
      memorias: Object.fromEntries(
        t.memories.map((m) => [`m${m.id}`, `[${m.kind}${m.subject ? `/${m.subject}` : ""}] ${m.content}`])
      ),
      ...(t.history?.length ? { historico: Object.fromEntries(t.history.map((h) => [`h${h.id}`, h.text])) } : {}),
    },
    questions,
  };
}

export interface TurnDecision {
  complex: boolean | null; // null = não perguntou ou falhou
  web: boolean | null;
  mechanic: boolean; // falha do Jev = não (o Árbitro não roda)
  meta: boolean; // fala fora do jogo sobre o registro; falha do Jev = não (turno normal)
  talk: string | null; // nome do NPC com quem a ação é conversa direta; falha do Jev = null (turno normal)
  book: boolean; // trechos dos livros no contexto; falha do Jev = não (o Mestre ainda tem search_book)
  keepMemory: (id: number, importance: number) => boolean;
  keepHistory: (id: number) => boolean; // falha do Jev = nenhum trecho (não infla o contexto)
}

export function gateTurn(answers: Record<string, Answer> | null, a: Advanced = D): TurnDecision {
  const c = answers?.complexity;
  const web = answers ? noulOf(answers, "needs_web") : undefined;
  const t = answers?.talk;
  return {
    complex: c?.type === "choice" ? (c.probabilities?.complexa ?? (c.choice === "complexa" ? 1 : 0)) >= a.jev.complexMin : null,
    web: web === undefined ? null : web >= a.jev.webMin,
    mechanic: (answers ? (noulOf(answers, "mechanic") ?? 0) : 0) >= a.jev.mechanicMin,
    meta: (answers ? (noulOf(answers, "meta") ?? 0) : 0) >= a.jev.metaMin,
    book: (answers ? (noulOf(answers, "needs_book") ?? 0) : 0) >= a.jev.bookMin,
    talk: t?.type === "choice" && t.choice !== "nenhum" && (t.probabilities?.[t.choice] ?? 1) >= a.jev.talkMin ? t.choice : null,
    keepMemory: (id, importance) => {
      if (importance >= a.memory.alwaysKeep || !answers) return true;
      const p = noulOf(answers, `mem_${id}`);
      return p === undefined || p >= a.memory.jevMin;
    },
    keepHistory: (id) => (answers ? (noulOf(answers, `hist_${id}`) ?? 0) >= a.history.jevMin : false),
  };
}

export async function decideTurn(t: TurnInput, campaignId: string): Promise<TurnDecision> {
  const a = await getAdvanced();
  const req = buildTurnRequest(t, a);
  if (!Object.keys(req.questions).length) return gateTurn(null, a);
  return gateTurn(await decide(req, { campaignId, purpose: "decisões do turno" }), a);
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
  return p === undefined || p >= (await getAdvanced()).jev.npcWillingMin;
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
  const top = a.probabilities && Object.entries(a.probabilities).sort((x, y) => y[1] - x[1])[0];
  // Jev em dúvida: fica a do Cronista (real: o Time 7 aprovado no teste dos guizos, 5 do Cronista, virou 1 com 0,39)
  if (top && top[1] < 0.5) return undefined;
  const best = top ? Number(top[0]) : Math.round(a.score);
  return Math.min(5, Math.max(1, best + 1));
}

/** Importância 1-5 por memória; quem o Jev não responder, ou responder sem nível com P ≥ 0,5, fica com a do Cronista. */
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

// ---------- 6: sexo do NPC (escolhe a voz padrão) ----------

// Sexo só vale se P >= limiar; abaixo disso fica desconhecido (voz masculina padrão; o usuário troca no modal).
// Probe (2026-10-30): Iruka Umino male 1.00, Tsunade female 0.99, "Kai" quieto unknown 0.74 (male 0.26),
// golem de pedra unknown 0.86. Errar a voz é barato: o usuário troca no modal.
export const GENDER_MIN = D.jev.genderMin;

export interface GenderInput {
  name: string;
  canon: boolean;
  setting: string;
  persona: { appearance?: string; personality?: string; backstory?: string };
}

export function buildGenderRequest(g: GenderInput): DecisionRequest {
  return {
    state: {
      obra_ou_cenario: g.setting,
      personagem: {
        nome: g.name,
        canonico_da_obra: g.canon,
        aparencia: g.persona.appearance || null,
        personalidade: g.persona.personality || null,
        historia: g.persona.backstory?.slice(0, 800) || null,
      },
    },
    questions: {
      gender: {
        type: "choice",
        instructions:
          "Qual é o sexo do `personagem`, pelo nome, pela descrição e pelo que se sabe dele na `obra_ou_cenario`? Ele define a voz (masculina ou feminina) do personagem.",
        criteria: {
          male: "Masculino: homem, menino ou criatura apresentada como macho.",
          female: "Feminino: mulher, menina ou criatura apresentada como fêmea.",
          unknown: "Não dá para saber: nome neutro sem descrição que indique, ou ser sem sexo definido.",
        },
      },
    },
  };
}

/** "male" | "female" | null (desconhecido). undefined = o Jev falhou (não grave, tente na próxima). */
export async function decideGender(g: GenderInput, campaignId: string): Promise<"male" | "female" | null | undefined> {
  const answers = await decide(buildGenderRequest(g), { campaignId, purpose: `sexo do NPC (${g.name})` });
  const a = answers?.gender;
  if (a?.type !== "choice") return undefined;
  const min = (await getAdvanced()).jev.genderMin;
  for (const k of ["male", "female"] as const)
    if ((a.probabilities?.[k] ?? (a.choice === k ? 1 : 0)) >= min) return k;
  return null;
}

// ---------- 7: quanto tempo passou (quando o Mestre esquece advance_time) ----------

// Faixa → minutos somados ao relógio. O Jev escolhe a faixa (choice); a quantidade fica no código.
export const ELAPSED_MINUTES = {
  quase_nada: 1,
  alguns_minutos: 5,
  quinze_minutos: 15,
  uma_hora: 60,
  algumas_horas: 180,
  meio_dia_ou_mais: 480,
} as const;

export interface ElapsedInput {
  scene: { mode: string; location: string | null };
  clock: string; // "Dia 1 · 08:40 (manhã)"
  playerAction: string;
  gmNarration: string;
}

export function buildElapsedRequest(t: ElapsedInput): DecisionRequest {
  return {
    state: {
      cena: { modo: t.scene.mode, local: t.scene.location },
      hora_antes_do_turno: t.clock,
      acao_do_jogador: t.playerAction,
      narracao_do_mestre: t.gmNarration.slice(-2000),
    },
    questions: {
      elapsed: {
        type: "choice",
        instructions:
          "Quanto tempo se passou dentro da história entre a `acao_do_jogador` e o fim da `narracao_do_mestre`?",
        criteria: {
          quase_nada: "Quase nada, segundos: uma pergunta rápida, uma fala curta, um olhar, um único golpe.",
          alguns_minutos: "Alguns minutos: uma conversa curta, uma troca de golpes, examinar algo, andar até ali perto.",
          quinze_minutos: "Cerca de 15 minutos: uma conversa longa, um combate inteiro, uma busca num lugar pequeno.",
          uma_hora: "Cerca de uma hora: uma refeição, uma aula ou treino curto, atravessar a vila a pé.",
          algumas_horas: "Algumas horas: uma viagem curta, um treino longo, uma tarde ou noite de atividade.",
          meio_dia_ou_mais: "Meio dia ou mais: dormir a noite, uma viagem longa, um salto de tempo para outro dia.",
        },
      },
    },
  };
}

/** Minutos a somar, ou null se o Jev falhar (aí o relógio não anda). */
export async function decideElapsed(t: ElapsedInput, campaignId: string): Promise<number | null> {
  const answers = await decide(buildElapsedRequest(t), { campaignId, purpose: "tempo do turno (Mestre esqueceu)" });
  const a = answers?.elapsed;
  return a?.type === "choice" ? ELAPSED_MINUTES[a.choice as keyof typeof ELAPSED_MINUTES] : null;
}

// ---------- 8: quem continua na cena (quando o Mestre não informou present) ----------

// NPC sai de cena se P(continua) < limiar. Probe (2026-10-30, jev-1.14): calado na mesma sala ou em batalha 0.76-0.93,
// viajou com o grupo sem ser citado 0.86-0.90; foi embora 0.04-0.07, morreu 0.03, ficou no lugar de onde o jogador
// saiu 0.20-0.27. Abaixo do meio do vão: tirar errado esconde o NPC do Mestre (volta sozinho se falar); deixar errado gasta tokens.
export const PRESENT_MIN = D.jev.presentMin;

export interface CastInput {
  scene: { mode: string; location: string | null; title: string | null };
  sceneChanged: boolean;
  playerAction: string;
  gmNarration: string;
  npcs: string[]; // ativos que não falaram na narração
}

export function buildCastRequest(t: CastInput): DecisionRequest {
  return {
    state: {
      cena: { modo: t.scene.mode, local: t.scene.location, titulo: t.scene.title },
      jogador_mudou_de_lugar_neste_turno: t.sceneChanged,
      acao_do_jogador: t.playerAction,
      narracao_do_mestre: t.gmNarration.slice(-3000),
      npcs: Object.fromEntries(t.npcs.map((n, i) => [`n${i}`, n])),
    },
    questions: Object.fromEntries(
      t.npcs.map((_, i) => [
        `n${i}`,
        {
          type: "noul" as const,
          instructions: `No fim da \`narracao_do_mestre\`, o personagem \`npcs.n${i}\` continua em cena: vivo e no mesmo lugar que o jogador, podendo agir ou falar?`,
          criteria: {
            true: "Sim: está ali com o jogador, mesmo sem ser citado. Quem já estava na cena continua nela enquanto o jogador não sai do lugar e a narração não mostra o personagem indo embora.",
            false: "Não: foi embora, ficou no lugar de onde o jogador saiu, morreu ou ficou fora de combate para sempre, ou a cena passou para um lugar onde ele não está.",
          },
        },
      ])
    ),
  };
}

/** Nomes que saíram de cena; null se o Jev falhar (aí ninguém sai). */
export async function decideCast(t: CastInput, campaignId: string): Promise<string[] | null> {
  if (!t.npcs.length) return [];
  const answers = await decide(buildCastRequest(t), { campaignId, purpose: "quem continua na cena" });
  if (!answers) return null;
  const min = (await getAdvanced()).jev.presentMin;
  return t.npcs.filter((_, i) => (noulOf(answers, `n${i}`) ?? 1) < min);
}

// ---------- 9: o jogador mudou de lugar (quando o Mestre não trocou o local com set_scene) ----------

// Mudou de lugar se P >= limiar. Probe (2026-10-30, jev-1.14): foi para casa / pegou a estrada 0.98-0.99, entrou
// na loja ao lado 0.82-0.87, sem local registrado e a narração diz onde 0.68-0.69; ficou conversando, outro canto
// da mesma sala, só planeja ir, narração vaga 0.02-0.04. Meio do vão: erro para cima abre cena num lugar falso,
// para baixo só deixa o local parado (como sem a checagem).
export const MOVED_MIN = D.jev.movedMin;
// Modo da cena pela narração (mesma chamada): troca se o Mestre não trocou e P(modo) >= limiar. Sem probe ainda.
export const MODE_MIN = D.jev.modeMin;

export interface PlaceInput {
  scene: { mode: string; location: string | null };
  playerAction: string;
  gmNarration: string;
}

export function buildPlaceRequest(t: PlaceInput): DecisionRequest {
  return {
    state: {
      cena: { modo: t.scene.mode, local_registrado: t.scene.location || null },
      acao_do_jogador: t.playerAction,
      narracao_do_mestre: t.gmNarration.slice(-3000),
    },
    questions: {
      moved: {
        type: "noul",
        instructions:
          "No fim da `narracao_do_mestre`, o personagem do jogador está num lugar diferente de `cena.local_registrado` (ou, sem local registrado, num lugar que a narração identifica)?",
        criteria: {
          true: "Sim: ele saiu de lá e está em outro lugar (outro prédio, casa, rua, bairro, cidade, região) ou já na estrada para outro.",
          false: "Não: continua no mesmo lugar ou numa parte dele (outro canto da sala, o pátio do mesmo prédio), só planeja ir, ou a narração não diz onde ele está.",
        },
      },
      mode: {
        type: "choice",
        instructions: "Que tipo de cena a `narracao_do_mestre` mostra no fim dela, agora?",
        criteria: {
          exploration: "Exploração: andar, viajar, investigar, procurar, observar um lugar, agir com algum risco fora de luta.",
          dialogue: "Diálogo: a conversa com um ou mais personagens é o centro da cena.",
          battle: "Batalha: luta em andamento ou começando agora, com inimigo agindo.",
          training: "Treino: praticar técnica ou atributo, aula prática, exercício.",
          downtime: "Descanso: em casa, refeição, dormir, compras, tarefas do dia a dia sem tensão, tempo passando.",
        },
      },
    },
  };
}

/** Lugar e modo pela narração; null se o Jev falhar (aí nada muda). mode = null: abaixo do limiar. */
export async function decideMoved(t: PlaceInput, campaignId: string): Promise<{ moved: boolean; mode: SceneMode | null } | null> {
  const answers = await decide(buildPlaceRequest(t), { campaignId, purpose: "jogador mudou de lugar? modo da cena? (Mestre não trocou)" });
  if (!answers) return null;
  const a = await getAdvanced();
  const m = answers.mode;
  return {
    moved: (noulOf(answers, "moved") ?? 0) >= a.jev.movedMin,
    mode: m?.type === "choice" && (m.probabilities?.[m.choice] ?? 1) >= a.jev.modeMin ? (m.choice as SceneMode) : null,
  };
}
