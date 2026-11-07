import { ADVANCED_DEFAULTS as D, type Advanced, getAdvanced } from "./advanced";
import { getAgent } from "./agents";
import { agentSource, authHeader, logApiCall } from "./openrouter";

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
// NPC recusa se P(toparia conversar) < limiar. Probe: batalha/hostil/ausente 0.07-0.13 (Zabuza em batalha ouvindo
// "uma proposta": 0.29), Sasuke frio 0.53-0.55, amigável 0.85-0.91. Recusa errada trava o jogador (mas ele pode
// insistir e o Jev decide de novo); aceite errado o NPC ainda pode cortar em personagem.
export const NPC_WILLING_MIN = D.jev.npcWillingMin;
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
// Gatilho narrativo de beat (lib/story.ts): o beat fica pronto se P(a última narração mostra isso) >= limiar. Sem probe
// medido ainda (casos em scripts/jev-check.ts, seção 13); alto porque o padrão é "não" e o beat ainda vence pelo prazo.
export const NARRATIVE_MIN = 0.7;
// Roteirista: beat cuja situation só acontece por ato do personagem do jogador sai do plano se P >= limiar. Sem probe
// medido (seção 14); alto porque o falso positivo mata o mistério ("o selo reage ao chakra dele" é o mundo agindo).
export const PC_ACT_MIN = 0.8;

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

// ---------- decisões do início do turno (uma chamada só) ----------

export interface TurnInput {
  setting: { name: string; canonBased: boolean };
  scene: { mode: string; location: string | null; title: string | null; summary: string | null };
  activeArc: string | null;
  npcsInScene: Record<string, string>;
  lastGmNarration: string;
  playerAction: string;
  askComplexity: boolean;
  askWeb: boolean;
  askMeta?: boolean; // pergunta se a ação é fala fora do jogo sobre o registro (não no Continuar nem no gerar novamente)
  askTalk?: boolean; // pergunta se a ação é conversa à parte com um dos npcsInScene (idem; o chamador pula batalha e treino)
  books?: string[]; // títulos dos livros de referência indexados: presente e não vazio = pergunta se a ação precisa deles
  beatTriggers?: Record<string, string>; // id do beat → pergunta sim/não do gatilho narrativo (sobre a última narração)
}

export function buildTurnRequest(t: TurnInput, a: Advanced = D): DecisionRequest {
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
        "Para narrar a `acao_do_jogador` com fidelidade, o Mestre precisa de um fato específico da obra original (personagem canônico, técnica, lugar ou evento da linha do tempo) que não está em `cena`, `arco_ativo` nem `npcs_em_cena`?",
      criteria: {
        true: "Sim: a ação depende de um detalhe canônico concreto que falta nesses dados e teria de ser conferido na obra.",
        false:
          "Não: a ação se resolve com o que está nos dados, é invenção livre da campanha, ou o cenário não é baseado em uma obra.",
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
        "Para narrar ou arbitrar a `acao_do_jogador` com fidelidade, o Mestre precisa de um trecho dos `livros_de_referencia` (um fato do material: personagem, técnica, lugar, evento ou regra) que não está em `cena`, `arco_ativo` nem `npcs_em_cena`?",
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
  for (const [id, text] of Object.entries(t.beatTriggers ?? {}))
    questions[`beat_${id}`] = {
      type: "noul",
      instructions: `Pela \`ultima_narracao_do_mestre\`, a resposta a esta pergunta é sim: "${text}"?`,
      criteria: {
        true: "Sim: a narração mostra isso claramente, já aconteceu ou está acontecendo.",
        false: "Não, ou a narração não deixa claro.",
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
      ...(t.books?.length ? { livros_de_referencia: t.books } : {}),
    },
    questions,
  };
}

export interface TurnDecision {
  complex: boolean | null; // null = não perguntou ou falhou
  web: boolean | null;
  meta: boolean; // fala fora do jogo sobre o registro; falha do Jev = não (turno normal)
  talk: string | null; // nome do NPC com quem a ação é conversa direta; falha do Jev = null (turno normal)
  book: boolean; // trechos dos livros no contexto; falha do Jev = não (o Narrador ainda tem search_lore)
  beats: Set<string>; // ids dos beats cujo gatilho narrativo o Jev confirmou; falha = nenhum
}

export function gateTurn(answers: Record<string, Answer> | null, a: Advanced = D): TurnDecision {
  const c = answers?.complexity;
  const web = answers ? noulOf(answers, "needs_web") : undefined;
  const t = answers?.talk;
  return {
    complex: c?.type === "choice" ? (c.probabilities?.complexa ?? (c.choice === "complexa" ? 1 : 0)) >= a.jev.complexMin : null,
    web: web === undefined ? null : web >= a.jev.webMin,
    meta: (answers ? (noulOf(answers, "meta") ?? 0) : 0) >= a.jev.metaMin,
    book: (answers ? (noulOf(answers, "needs_book") ?? 0) : 0) >= a.jev.bookMin,
    talk: t?.type === "choice" && t.choice !== "nenhum" && (t.probabilities?.[t.choice] ?? 1) >= a.jev.talkMin ? t.choice : null,
    beats: new Set(
      Object.entries(answers ?? {})
        .filter(([k, v]) => k.startsWith("beat_") && v.type === "noul" && v.noul >= NARRATIVE_MIN)
        .map(([k]) => k.slice(5))
    ),
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
