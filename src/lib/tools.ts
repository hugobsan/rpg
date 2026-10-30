import { randomUUID } from "node:crypto";
import { q } from "./db";
import { ToolDef } from "./openrouter";
import { rollDice } from "./dice";
import { addMemory, searchMemories, searchBookChunks } from "./retrieval";
import { listBooks, readPages } from "./books";
import { Ability, Campaign, Character, Scene, Sheet, TableRules, TurnEvent } from "./types";
import { abilityPromptLine, blankSheet, currentMilestone, nextMilestone } from "./ruleset";
import {
  abilityAttribute,
  attributePoints,
  costAdjustText,
  effectiveCost,
  findAbility,
  gainMastery,
  masteryBonus,
  NEW_ABILITY_MASTERY,
  powerLevel,
  raiseBlocked,
  train,
  useGain,
} from "./progression";
import { clockParts, formatClock, formatDuration, getClock, period, toMinutes } from "./clock";
import { expireObjectives, formatRemaining, getObjectives, Objective, OBJECTIVE_KIND_LABEL, ObjectiveKind } from "./objectives";
import { executeMapTool, MAP_TOOLS, recordScenePlace } from "./map";
import { dcResultText, getTable, tableDc } from "./table";
import { queueProfile } from "./characters";

const MILESTONE_SCHEMA = {
  type: "array",
  description:
    "Marcos de capacidade por nível de domínio (opcional). Use quando a habilidade evolui em estágios com poderes distintos (ex: um dōjutsu que desbloqueia leitura de movimentos aos 25%, cópia de técnicas aos 50%...). Inclua um marco com threshold=0 descrevendo a capacidade inicial.",
  items: {
    type: "object",
    properties: {
      threshold: { type: "number", description: "0-100: domínio a partir do qual este marco vale" },
      description: { type: "string", description: "o que se torna possível a partir deste ponto" },
    },
    required: ["threshold", "description"],
  },
};

const S = (props: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties: props,
  required,
});

export const GM_TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "roll_dice",
      description:
        "Rola dados em notação padrão (ex: 1d20+4, 2d6). O resultado é mostrado ao jogador.",
      parameters: S(
        {
          notation: { type: "string", description: "ex: 1d20+4" },
          reason: { type: "string", description: "o que está sendo testado" },
          dc: {
            type: "number",
            description:
              "dificuldade (CD) do teste, quando houver uma só: o resultado sai como SUCESSO/FALHA e o jogador vê verde/vermelho. Omita em disputas diretas (rolagens opostas). O servidor soma o ajuste das REGRAS DA MESA.",
          },
          category: { type: "string", description: "tipo de ação, uma das keys das REGRAS DA MESA (se houver): soma o ajuste dele na CD" },
        },
        ["notation"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "update_resource",
      description:
        "Altera um recurso (saúde, chakra...) de um personagem. Use delta para dano/cura/gasto, ou set para fixar. Opcionalmente ajusta o máximo.",
      parameters: S(
        {
          character: { type: "string", description: "nome exato" },
          resource: { type: "string", description: "key do recurso (ex: hp, chakra)" },
          delta: { type: "number", description: "variação (+cura/-dano)" },
          set: { type: "number", description: "valor absoluto" },
          setMax: { type: "number", description: "novo máximo" },
        },
        ["character", "resource"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "update_attribute",
      description:
        "Define o valor de um atributo básico de um personagem. Aumentos respeitam o teto do nível de poder (o servidor recusa e explica); reduções (lesão, maldição) são livres. Pontos livres de XP são do JOGADOR, que distribui na ficha: não os gaste por ele.",
      parameters: S(
        {
          character: { type: "string" },
          attribute: { type: "string", description: "key do atributo" },
          value: { type: "number" },
        },
        ["character", "attribute", "value"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "add_ability",
      description:
        "Adiciona (ou redefine, se mesmo nome) uma habilidade/jutsu ao personagem. Use quando ele aprende algo E quando ele usa uma técnica plausível que ainda não está na ficha: registre NA HORA DO USO, antes de resolver (rolagem, custo), com custo, efeito, dano e requisitos — nada de resolver uma técnica que não está na ficha. Para habilidades com evolução em estágios (dōjutsu, técnicas assinatura), defina milestones — o progresso é próprio dessa habilidade, não uma barra genérica do personagem. Para habilidades simples, basta rank.",
      parameters: S(
        {
          character: { type: "string" },
          name: { type: "string" },
          abilityType: { type: "string", description: "key do tipo (ex: ninjutsu)" },
          rank: { type: "string", description: "nível amplo de maestria (ex: C) — para habilidades sem marcos" },
          description: { type: "string" },
          progress: {
            type: "number",
            description: `0-100: domínio inicial (default ${NEW_ABILITY_MASTERY}). Registrada na hora do uso: 10-25; aprendida com treino longo: mais. O domínio dá bônus no teste e muda o custo.`,
          },
          milestones: MILESTONE_SCHEMA,
          cost: {
            type: "object",
            description: "custo por uso. Omita para usar o padrão do rank no ruleset; amount 0 = sem custo",
            properties: {
              resource: { type: "string", description: "key do recurso (ex: chakra)" },
              amount: { type: "number" },
            },
            required: ["resource", "amount"],
          },
          effect: { type: "string", description: "o que faz em jogo: alcance, duração, teste usado" },
          damage: { type: "string", description: "dano em notação de dado (ex: 2d6), se causar dano" },
          requirements: { type: "string", description: "selos, elemento, kekkei genkai, outra habilidade" },
        },
        ["character", "name", "abilityType"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "update_ability_progress",
      description:
        "Avança (ou fixa) o domínio de UMA habilidade específica do personagem, não um atributo geral. Use delta para progresso incremental de treino/uso, ou set para fixar um valor. O retorno informa se um marco de capacidade foi cruzado — narre o que isso desbloqueia.",
      parameters: S(
        {
          character: { type: "string" },
          name: { type: "string", description: "nome exato da habilidade" },
          delta: { type: "number", description: "variação de progresso (0-100)" },
          set: { type: "number", description: "valor absoluto de progresso (0-100)" },
          reason: { type: "string", description: "o que gerou esse avanço" },
        },
        ["character", "name"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "use_ability",
      description:
        "Resolve o uso de uma técnica DA FICHA do personagem (jutsu, golpe especial...). O servidor faz a conta: desconta o custo já ajustado pelo domínio (falha sem rolar se não houver recurso), rola 1d20 + atributo x multiplicador + bônus do domínio contra a CD (o jogador vê a rolagem) e sobe o domínio pelo uso. Use no lugar de roll_dice + update_resource para técnicas da ficha. O dano, se houver, role à parte com roll_dice.",
      parameters: S(
        {
          character: { type: "string" },
          ability: { type: "string", description: "nome exato da técnica na ficha" },
          attribute: { type: "string", description: "key do atributo do teste, só para trocar o padrão do tipo" },
          dc: { type: "number", description: "dificuldade (CD). Omita só em disputa direta (rolagem oposta). O servidor soma o ajuste das REGRAS DA MESA" },
          category: { type: "string", description: "tipo de ação, uma das keys das REGRAS DA MESA (se houver)" },
          target: { type: "string", description: "alvo, se houver" },
          note: { type: "string", description: "contexto curto do uso" },
        },
        ["character", "ability"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "train",
      description:
        "Treino: avança o relógio pelas horas treinadas e só então aplica o ganho. Jutsu: o domínio sobe por hora (menos nos domínios altos). Atributo: as horas acumulam até o próximo +1, até o teto do nível de poder. Há limite de horas de treino por dia e de domínio ganho por jutsu por dia; acima disso o treino é recusado (exausto). Não chame advance_time para as mesmas horas.",
      parameters: S(
        {
          character: { type: "string" },
          target: { type: "string", description: "nome do jutsu da ficha ou key do atributo" },
          hours: { type: "number", description: "horas realistas de treino (inteiras, ex: 2, 4)" },
          note: { type: "string", description: "como treinou" },
        },
        ["character", "target", "hours"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "add_item",
      description: "Adiciona item ao inventário (soma quantidade se já existir).",
      parameters: S(
        {
          character: { type: "string" },
          name: { type: "string" },
          qty: { type: "number" },
          description: { type: "string" },
        },
        ["character", "name"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "remove_item",
      description: "Remove/consome itens do inventário.",
      parameters: S(
        { character: { type: "string" }, name: { type: "string" }, qty: { type: "number" } },
        ["character", "name"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "grant_xp",
      description:
        "Concede XP ao personagem. O nível de poder (teto de atributo) sobe sozinho com a XP e o retorno avisa; a XP também dá pontos livres que o jogador distribui. Cargo (rank) é outra coisa: só muda por decisão narrativa sua, via set_rank.",
      parameters: S(
        { character: { type: "string" }, amount: { type: "number" }, reason: { type: "string" } },
        ["character", "amount"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "set_rank",
      description: "Define o cargo (rank) do personagem: posição na história (key do ruleset, ex: chunin). Não muda o nível de poder, que vem da XP.",
      parameters: S({ character: { type: "string" }, rank: { type: "string" } }, [
        "character",
        "rank",
      ]),
    },
  },
  {
    type: "function",
    function: {
      name: "update_extra_field",
      description: "Define um campo extra da ficha (ex: elemento, kekkei_genkai).",
      parameters: S(
        { character: { type: "string" }, field: { type: "string" }, value: { type: "string" } },
        ["character", "field", "value"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "add_memory",
      description:
        "Registra memória de longo prazo da campanha. kind: event, npc, discovery, milestone (marcos de história), relationship.",
      parameters: S(
        {
          kind: { type: "string", enum: ["event", "npc", "discovery", "milestone", "relationship"] },
          content: { type: "string", description: "fato autossuficiente" },
          subject: { type: "string", description: "NPC/lugar relacionado" },
          importance: { type: "number", description: "1-5" },
        },
        ["kind", "content"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "search_memories",
      description:
        "Busca semântica nas memórias da campanha (eventos passados, interações com NPCs, descobertas, marcos).",
      parameters: S(
        { query: { type: "string" }, kind: { type: "string" }, subject: { type: "string" } },
        ["query"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "create_npc",
      description:
        "Registra um NPC novo na hora, ativo na cena. O Criador de personagens monta perfil, ficha e retrato em segundo plano a partir do brief. canon=true para personagens da obra.",
      parameters: S(
        {
          name: { type: "string" },
          canon: { type: "boolean" },
          gender: { type: "string", enum: ["male", "female", "unknown"], description: "define a voz" },
          brief: { type: "string", description: "quem é, papel, poder e o que já foi narrado ou estabelecido sobre ele" },
          rank: { type: "string", description: "key do cargo, se já definido" },
          personality: { type: "string" },
        },
        ["name", "gender", "brief"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "set_npc_active",
      description:
        "Ativa (entrou em cena/está por perto) ou inativa (saiu de cena, viajou, morreu) um NPC. NPCs inativos não interagem.",
      parameters: S(
        { name: { type: "string" }, active: { type: "boolean" }, note: { type: "string" } },
        ["name", "active"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "npc_message",
      description:
        "O NPC chama o jogador para conversar em particular: a mensagem chega à caixa de entrada do jogador, que decide se abre e responde (a conversa segue com o agente do NPC). Com parcimônia, só quando o NPC tem um motivo real: algo a contar, um pedido, um aviso, um segredo, aprofundar a relação. Coerente com a cena e o relógio: NPC por perto chama de lado ou fala baixo; NPC longe manda recado, mensageiro, pássaro, rádio, holo... conforme o cenário. Nunca para despejar exposição nem empurrar a trama. Na narração, no máximo sinalize a chegada, sem repetir o conteúdo.",
      parameters: S(
        {
          npc: { type: "string", description: "nome exato do NPC registrado" },
          message: {
            type: "string",
            description: "o que o jogador lê: a mensagem em personagem, curta (1 a 3 frases), com o meio de entrega se for à distância",
          },
          intent: {
            type: "string",
            description: "o motivo real, oculto do jogador: o que o NPC quer com a conversa. Vai para o agente do NPC quando o jogador responder",
          },
        },
        ["npc", "message", "intent"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "set_scene",
      description:
        "Atualiza a cena atual (modo/título/local) ou inicia uma nova cena (newScene=true). Modos: exploration, dialogue, battle, training, downtime. Ao abrir cena nova ou mudar o local, present é OBRIGATÓRIO: todos os NPCs que estão no novo lugar com o jogador. Quem ficar de fora sai de cena; quem estiver fora de cena e for listado volta.",
      parameters: S(
        {
          mode: { type: "string", enum: ["exploration", "dialogue", "battle", "training", "downtime"] },
          title: { type: "string" },
          location: { type: "string" },
          newScene: { type: "boolean", description: "true para encerrar a cena atual e abrir outra" },
          present: {
            type: "array",
            items: { type: "string" },
            description: "nomes de TODOS os NPCs presentes na cena/local (lista completa; [] = nenhum). Obrigatório com newScene ou location novo",
          },
        },
        []
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "advance_time",
      description:
        "Avança o relógio da história pelo tempo que a interação levou. Chame uma vez por turno em que o tempo passa, com uma estimativa realista: uma troca de falas leva minutos, um combate poucos minutos, uma refeição ou um treino curto ~1 h, uma viagem horas. Exige o relógio já definido (set_time).",
      parameters: S(
        {
          minutes: { type: "number", description: "minutos que se passaram (ex: 5, 20, 90, 240)" },
          reason: { type: "string", description: "o que levou esse tempo" },
        },
        ["minutes", "reason"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "set_time",
      description:
        "Fixa o relógio da história: na abertura da campanha, quando o relógio ainda não existe, e em saltos explícitos (\"na manhã seguinte\", \"três dias depois\", dormir até de manhã). Sem day, vale o dia atual; se a hora já passou hoje, vira o dia seguinte (o tempo não volta).",
      parameters: S(
        {
          day: { type: "number", description: "dia da campanha (1 = primeiro dia); omita para hoje/próximo" },
          hour: { type: "number", description: "0-23" },
          minute: { type: "number", description: "0-59" },
          reason: { type: "string", description: "por que o relógio mudou" },
        },
        ["hour", "minute", "reason"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "add_objective",
      description:
        "Registra uma missão, um evento marcado ou outro compromisso da história, com prazo opcional em tempo do jogo. Prazo absoluto (day + hour/minute; sem day, a próxima vez que der essa hora) ou relativo (inMinutes/inHours/inDays a partir de agora). Quando o relógio passa do prazo, o sistema marca como perdido.",
      parameters: S(
        {
          title: { type: "string", description: "nome curto (ex: 'Escoltar o Tazuna', 'Exame Chūnin')" },
          kind: { type: "string", enum: ["missao", "evento", "outro"] },
          description: { type: "string", description: "o que precisa ser feito ou o que vai acontecer, e onde" },
          reward: { type: "string", description: "recompensa ou o que está em jogo (opcional)" },
          day: { type: "number", description: "prazo absoluto: dia da campanha" },
          hour: { type: "number", description: "prazo absoluto: hora 0-23 (com day e sem hour: fim do dia)" },
          minute: { type: "number", description: "prazo absoluto: minuto 0-59" },
          inMinutes: { type: "number", description: "prazo relativo: minutos a partir de agora" },
          inHours: { type: "number", description: "prazo relativo: horas a partir de agora" },
          inDays: { type: "number", description: "prazo relativo: dias a partir de agora" },
        },
        ["title", "kind", "description"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "update_objective",
      description:
        "Atualiza uma missão/evento registrado: concluir quando cumprido, cancelar quando deixou de valer na história, ou mudar o prazo (mesmos campos de add_objective; noDeadline=true tira o prazo). Um objetivo perdido não volta.",
      parameters: S(
        {
          objective: { type: "string", description: "id (ex: o2) ou título" },
          status: { type: "string", enum: ["concluido", "cancelado"] },
          description: { type: "string", description: "nova descrição (opcional)" },
          day: { type: "number" },
          hour: { type: "number" },
          minute: { type: "number" },
          inMinutes: { type: "number" },
          inHours: { type: "number" },
          inDays: { type: "number" },
          noDeadline: { type: "boolean" },
        },
        ["objective"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "get_character",
      description: "Lê a ficha completa e persona de um personagem (player ou NPC, ativo ou não).",
      parameters: S({ name: { type: "string" } }, ["name"]),
    },
  },
  {
    type: "function",
    function: {
      name: "get_script",
      description:
        "Lê o roteiro interno da campanha (premissa, arcos, eventos canônicos, progresso). Use para se situar na linha do tempo.",
      parameters: S({}, []),
    },
  },
  {
    type: "function",
    function: {
      name: "update_script",
      description:
        "Anota progresso no roteiro: adiciona nota a um arco e/ou muda seu status (pending/active/done).",
      parameters: S(
        {
          arcTitle: { type: "string" },
          note: { type: "string" },
          status: { type: "string", enum: ["pending", "active", "done"] },
        },
        ["arcTitle"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "search_book",
      description:
        "Busca trechos nos livros/materiais de referência indexados. Retorna chunks com número de página — depois você pode ler páginas inteiras com read_pages.",
      parameters: S({ query: { type: "string" } }, ["query"]),
    },
  },
  {
    type: "function",
    function: {
      name: "read_pages",
      description:
        "Lê páginas inteiras de um livro indexado (até 8 por chamada). Use após search_book para contexto completo, página seguinte/anterior ou um intervalo específico.",
      parameters: S(
        {
          bookId: { type: "string" },
          from: { type: "number", description: "primeira página" },
          to: { type: "number", description: "última página (opcional, default = from)" },
        },
        ["bookId", "from"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "list_books",
      description: "Lista os livros/materiais indexados nesta campanha.",
      parameters: S({}, []),
    },
  },
  ...MAP_TOOLS,
];

export interface ToolContext {
  campaign: Campaign;
  scene: Scene;
  emit: (e: TurnEvent) => void;
  sceneChanged?: boolean; // set_scene abriu cena nova ou mudou o local neste turno
  castSet?: boolean; // set_scene informou present: o elenco já está certo
}

/** Chave para comparar nomes citados: 1º nome sem honorífico ("Iruka-sensei" = "Iruka Umino"); "Hugo (como Daiki)" = Hugo. */
const nameKey = (s: string) =>
  s.replace(/\(.*?\)/g, "").trim().split(/\s+/)[0]?.replace(/-(sensei|sama|kun|chan|san|dono|senpai|hime)$/i, "").toLowerCase() || "";

/** Personagens a que o nome citado se refere: o nome exato, ou senão a chave (1º nome) contra qualquer parte do nome. */
export function findNamed<T extends { name: string }>(chars: T[], said: string): T[] {
  const exact = chars.filter((c) => c.name.toLowerCase() === said.trim().toLowerCase());
  if (exact.length) return exact;
  const k = nameKey(said);
  return k ? chars.filter((c) => nameKey(c.name) === k || c.name.toLowerCase().split(/\s+/).includes(k)) : [];
}

/** Põe NPCs em cena ou tira, com o chip de cada um. */
export async function setNpcsActive(
  campaignId: string,
  npcs: { id: string; name: string }[],
  active: boolean,
  emit: (e: TurnEvent) => void
): Promise<void> {
  if (!npcs.length) return;
  await q(`UPDATE characters SET active = $1, updated_at = now() WHERE campaign_id = $2 AND id = ANY($3::uuid[])`, [
    active,
    campaignId,
    npcs.map((n) => n.id),
  ]);
  for (const n of npcs) emit({ type: "tool", name: "set_npc_active", summary: `${n.name} ${active ? "entrou em cena" : "saiu de cena"}` });
  emit({ type: "state" });
}

async function getChar(campaignId: string, name: string): Promise<Character> {
  const rows = await q<Character>(
    `SELECT * FROM characters WHERE campaign_id = $1 AND lower(name) = lower($2)`,
    [campaignId, name]
  );
  if (!rows.length) throw new Error(`Personagem "${name}" não existe nesta campanha.`);
  return rows[0];
}

/**
 * Ponto único de gravação do relógio (advance_time, set_time, train e o fallback do Jev).
 * Também marca como perdido o objetivo aberto cujo prazo passou. Devolve o aviso para
 * acrescentar ao resultado da ferramenta ("" se nada venceu).
 */
export async function saveClock(campaignId: string, minutes: number, emit?: (e: TurnEvent) => void): Promise<string> {
  const [row] = await q<{ state: Record<string, unknown> }>(
    `UPDATE campaigns SET state = state || jsonb_build_object('clock', jsonb_build_object('minutes', $1::int)) WHERE id = $2 RETURNING state`,
    [minutes, campaignId]
  );
  const { list, lost } = expireObjectives(getObjectives(row?.state), minutes);
  if (!lost.length) return "";
  await saveObjectives(campaignId, list);
  for (const o of lost) emit?.({ type: "tool", name: "objective", summary: `⌛ Prazo perdido: ${o.title}` });
  emit?.({ type: "state" });
  return ` ⌛ PRAZO PERDIDO: ${lost
    .map((o) => `"${o.title}" (vencia ${formatClock(o.deadlineMinutes!)})`)
    .join("; ")}. Narre a consequência na história; a perda não se desfaz.`;
}

/** Grava só state.table (regras da mesa já validadas por normalizeTable). */
export async function saveTable(campaignId: string, table: TableRules): Promise<void> {
  await q(`UPDATE campaigns SET state = state || jsonb_build_object('table', $1::jsonb) WHERE id = $2`, [JSON.stringify(table), campaignId]);
}

async function loadObjectives(campaignId: string): Promise<Objective[]> {
  const [row] = await q<{ state: Record<string, unknown> }>(`SELECT state FROM campaigns WHERE id = $1`, [campaignId]);
  return getObjectives(row?.state);
}

/** Grava só state.objectives, sem tocar no resto de campaigns.state. */
async function saveObjectives(campaignId: string, list: Objective[]): Promise<void> {
  await q(`UPDATE campaigns SET state = state || jsonb_build_object('objectives', $1::jsonb) WHERE id = $2`, [
    JSON.stringify(list),
    campaignId,
  ]);
}

/** Prazo dos args de add/update_objective: undefined = sem prazo; string = erro para o Mestre. */
function parseDeadline(args: Record<string, unknown>, now: number | undefined): number | undefined | string {
  const rel = ["inMinutes", "inHours", "inDays"].some((k) => args[k] !== undefined);
  if (!rel && args.day === undefined && args.hour === undefined) return undefined;
  if (now === undefined)
    return "O relógio ainda não foi definido: chame set_time antes de registrar um prazo (ou registre sem prazo).";
  let at: number;
  if (rel) {
    at = now + Math.round(Number(args.inMinutes ?? 0) + Number(args.inHours ?? 0) * 60 + Number(args.inDays ?? 0) * 1440);
  } else {
    // só day = até o fim daquele dia; sem day = a próxima vez que der essa hora
    const hour = args.hour !== undefined ? Math.round(Number(args.hour)) : 23;
    const minute = args.hour !== undefined ? Math.round(Number(args.minute ?? 0)) : 59;
    if (!(hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59)) return "hour 0-23 e minute 0-59.";
    at = toMinutes(args.day !== undefined ? Math.round(Number(args.day)) : clockParts(now).day, hour, minute);
    if (args.day === undefined && at <= now) at += 1440;
  }
  if (!Number.isFinite(at) || at <= now) return `O prazo precisa ser depois de agora (${formatClock(now)}).`;
  return at;
}

const deadlineText = (at: number | undefined, now: number | undefined) =>
  at === undefined ? "sem prazo" : `prazo ${formatClock(at)}${now !== undefined ? `, ${formatRemaining(at - now)}` : ""}`;

async function saveSheet(id: string, sheet: Sheet): Promise<void> {
  await q(`UPDATE characters SET sheet = $1, updated_at = now() WHERE id = $2`, [
    JSON.stringify(sheet),
    id,
  ]);
}

/** Executa uma tool do Mestre. Retorna string (resultado para o modelo). */
export async function executeGmTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<string> {
  const cid = ctx.campaign.id;
  switch (name) {
    case "roll_dice": {
      const table = getTable(ctx.campaign.state);
      const adj = tableDc(table, typeof args.dc === "number" ? args.dc : undefined, args.category);
      const result = { ...rollDice(String(args.notation), args.reason as string | undefined, adj.dc, table.crits), ...adj.dice };
      ctx.emit({ type: "dice", result });
      return `Rolagem ${result.notation}${result.reason ? ` (${result.reason})` : ""}: dados [${result.rolls.join(", ")}] ${result.modifier ? `mod ${result.modifier} ` : ""}= TOTAL ${result.total}${dcResultText(result, adj.note)}`;
    }
    case "update_resource": {
      const c = await getChar(cid, String(args.character));
      const key = String(args.resource);
      const res = c.sheet.resources[key];
      if (!res) return `Erro: recurso "${key}" não existe na ficha de ${c.name}.`;
      if (typeof args.setMax === "number") res.max = Math.max(1, args.setMax);
      if (typeof args.set === "number") res.current = args.set;
      else if (typeof args.delta === "number") res.current += args.delta;
      res.current = Math.max(0, Math.min(res.current, res.max));
      await saveSheet(c.id, c.sheet);
      ctx.emit({ type: "state" });
      ctx.emit({
        type: "tool",
        name,
        summary: `${c.name}: ${key} → ${res.current}/${res.max}`,
      });
      return `${c.name} agora tem ${key} = ${res.current}/${res.max}.`;
    }
    case "update_attribute": {
      const c = await getChar(cid, String(args.character));
      const value = Math.round(Number(args.value));
      if (!Number.isFinite(value)) return "value precisa ser um número.";
      const blocked = raiseBlocked(ctx.campaign.ruleset, c.sheet, String(args.attribute), value);
      if (blocked) return `Aumento recusado: ${blocked}. Nada mudou.`;
      c.sheet.attributes[String(args.attribute)] = value;
      await saveSheet(c.id, c.sheet);
      ctx.emit({ type: "state" });
      ctx.emit({ type: "tool", name, summary: `${c.name}: ${args.attribute} = ${args.value}` });
      return `Atributo atualizado.`;
    }
    case "add_ability": {
      const c = await getChar(cid, String(args.character));
      const milestones = Array.isArray(args.milestones)
        ? (args.milestones as { threshold: number; description: string }[])
            .map((m) => ({ threshold: Number(m.threshold), description: String(m.description) }))
            .sort((a, b) => a.threshold - b.threshold)
        : undefined;
      const cost = args.cost as { resource?: unknown; amount?: unknown } | undefined;
      const ability: Ability = {
        name: String(args.name),
        type: String(args.abilityType),
        rank: args.rank ? String(args.rank) : undefined,
        description: args.description ? String(args.description) : undefined,
        progress: Math.max(0, Math.min(100, typeof args.progress === "number" ? args.progress : NEW_ABILITY_MASTERY)),
        milestones,
        cost: cost && typeof cost.resource === "string" && Number.isFinite(Number(cost.amount))
          ? { resource: cost.resource, amount: Number(cost.amount) }
          : undefined,
        effect: args.effect ? String(args.effect) : undefined,
        damage: args.damage ? String(args.damage) : undefined,
        requirements: args.requirements ? String(args.requirements) : undefined,
      };
      if (ability.cost && !c.sheet.resources[ability.cost.resource])
        return `Erro: recurso "${ability.cost.resource}" não existe na ficha de ${c.name}.`;
      const idx = c.sheet.abilities.findIndex(
        (a) => a.name.toLowerCase() === ability.name.toLowerCase()
      );
      // redefinir sem informar o domínio mantém o que ele já tinha
      if (idx >= 0 && typeof args.progress !== "number") ability.progress = c.sheet.abilities[idx].progress;
      if (idx >= 0) c.sheet.abilities[idx] = ability;
      else c.sheet.abilities.push(ability);
      await saveSheet(c.id, c.sheet);
      ctx.emit({ type: "state" });
      const cur = currentMilestone(ability);
      ctx.emit({
        type: "tool",
        name,
        summary: `${c.name} ${idx >= 0 ? "aprimorou" : "aprendeu"}: ${ability.name}${ability.rank ? ` (${ability.rank})` : ""}${cur ? ` — ${cur.description}` : ""}`,
      });
      return `Habilidade ${idx >= 0 ? "atualizada" : "adicionada"}: ${abilityPromptLine(ctx.campaign.ruleset, ability)}.${cur ? ` Marco atual: ${cur.description}` : ""}`;
    }
    case "update_ability_progress": {
      const c = await getChar(cid, String(args.character));
      const ability = c.sheet.abilities.find(
        (a) => a.name.toLowerCase() === String(args.name).toLowerCase()
      );
      if (!ability)
        return `Erro: ${c.name} não possui a habilidade "${args.name}". Use add_ability para criá-la primeiro (com milestones, se aplicável).`;
      const before = currentMilestone(ability);
      const prevProgress = ability.progress ?? 0;
      if (typeof args.set === "number") ability.progress = args.set;
      else if (typeof args.delta === "number") ability.progress = prevProgress + args.delta;
      else return `Erro: informe delta ou set.`;
      ability.progress = Math.max(0, Math.min(100, ability.progress));
      await saveSheet(c.id, c.sheet);
      const after = currentMilestone(ability);
      const upcoming = nextMilestone(ability);
      ctx.emit({ type: "state" });
      const crossed = after && after !== before;
      ctx.emit({
        type: "tool",
        name,
        summary: `${c.name}: ${ability.name} → ${ability.progress}%${crossed ? ` — novo marco: ${after!.description}` : ""}`,
      });
      let msg = `${ability.name} agora está em ${ability.progress}% de domínio.`;
      if (crossed) msg += ` NOVO MARCO ALCANÇADO: ${after!.description} — narre esse avanço.`;
      if (upcoming) msg += ` Próximo marco aos ${upcoming.threshold}%: ${upcoming.description}.`;
      return msg;
    }
    case "use_ability": {
      const rs = ctx.campaign.ruleset;
      const c = await getChar(cid, String(args.character));
      const ability = findAbility(c.sheet, String(args.ability || ""));
      if (!ability)
        return `Erro: ${c.name} não tem "${args.ability}" na ficha. Se for plausível que ele saiba, registre antes com add_ability (domínio 10-25) e chame use_ability de novo; se não, a tentativa falha na narrativa. Técnicas da ficha: ${c.sheet.abilities.map((a) => a.name).join(", ") || "nenhuma"}.`;
      const attrKey = abilityAttribute(rs, ability, args.attribute ? String(args.attribute) : undefined);
      if (!attrKey) return `Erro: atributo "${args.attribute}" não existe (${rs.attributes.map((a) => a.key).join(", ")}).`;
      const cost = effectiveCost(rs, ability);
      const pool = cost && cost.amount > 0 ? c.sheet.resources[cost.resource] : undefined;
      if (cost && cost.amount > 0) {
        if (!pool) return `Erro: recurso "${cost.resource}" não existe na ficha de ${c.name}.`;
        if (pool.current < cost.amount)
          return `FALHOU sem rolar: ${ability.name} custa ${cost.amount} ${cost.resource}${cost.mult !== 1 ? ` (base ${cost.base}, ${costAdjustText(cost.mult)})` : ""} e ${c.name} tem ${pool.current}. Nada foi gasto. Narre a falta de ${cost.resource}.`;
        pool.current -= cost.amount;
      }
      const attr = c.sheet.attributes[attrKey] ?? 0;
      const mult = rs.attributeMultiplier ?? 1;
      const bonus = masteryBonus(rs, ability);
      const mod = attr * mult + bonus;
      const table = getTable(ctx.campaign.state);
      const adj = tableDc(table, typeof args.dc === "number" ? args.dc : undefined, args.category);
      const attrLabel = rs.attributes.find((a) => a.key === attrKey)?.label || attrKey;
      const result = {
        ...rollDice(
          `1d20${mod >= 0 ? "+" : ""}${mod}`,
          `${ability.name}${args.target ? ` em ${args.target}` : ""} (${attrLabel} ${attr}${mult !== 1 ? `×${mult}` : ""} + domínio +${bonus})`,
          adj.dc,
          table.crits
        ),
        ...adj.dice,
      };
      const clock = getClock(ctx.campaign.state);
      const g = gainMastery(rs, c.sheet, ability, useGain(rs, ability), clock ? clockParts(clock.minutes).day : 0);
      await saveSheet(c.id, c.sheet);
      ctx.emit({ type: "state" });
      if (pool) ctx.emit({ type: "tool", name, summary: `${c.name} usou ${ability.name}: −${cost!.amount} ${cost!.resource} (${pool.current}/${pool.max})` });
      ctx.emit({ type: "dice", result });
      // depois do dado: com a animação, só aparece quando o jogador rolar
      if (g.after > g.before || g.milestone)
        ctx.emit({
          type: "tool",
          name,
          summary: `${ability.name}: domínio ${g.before}% → ${g.after}%${g.milestone ? ` — novo marco: ${g.milestone.description}` : ""}`,
        });
      let msg = `${ability.name} (${c.name}${args.target ? ` → ${args.target}` : ""}): dados [${result.rolls.join(", ")}] + ${attrLabel} ${attr}${mult !== 1 ? `×${mult}` : ""} + domínio ${bonus} = TOTAL ${result.total}`;
      msg += result.dc !== undefined ? `${dcResultText(result, adj.note)}.` : `${adj.note} (disputa: compare com a rolagem oposta).`;
      msg += pool ? ` Custo pago: ${cost!.amount} ${cost!.resource}${cost!.mult !== 1 ? ` (base ${cost!.base}, ${costAdjustText(cost!.mult)})` : ""}; resta ${pool.current}/${pool.max}.` : " Sem custo.";
      msg += g.after > g.before ? ` Domínio ${g.before}% → ${g.after}%.` : g.capped ? ` Domínio ${g.after}% (já rendeu o máximo hoje).` : ` Domínio ${g.after}%.`;
      if (g.milestone) msg += ` NOVO MARCO ALCANÇADO: ${g.milestone.description} — narre esse avanço.`;
      if (ability.damage) msg += ` Dano registrado: ${ability.damage} (role com roll_dice se acertou).`;
      return msg;
    }
    case "train": {
      const rs = ctx.campaign.ruleset;
      const c = await getChar(cid, String(args.character));
      const before = getClock(ctx.campaign.state)?.minutes;
      if (before === undefined) return "O relógio ainda não foi definido: chame set_time primeiro.";
      const r = train(rs, c.sheet, String(args.target || ""), Number(args.hours), clockParts(before).day);
      if ("error" in r) return r.error;
      const minutes = before + r.hours * 60;
      ctx.campaign.state = { ...ctx.campaign.state, clock: { minutes } };
      ctx.emit({ type: "time", minutes });
      ctx.emit({ type: "tool", name, summary: `🕐 ${formatClock(minutes)} (+${formatDuration(r.hours * 60)}) — treino` });
      const lost = await saveClock(cid, minutes, ctx.emit);
      await saveSheet(c.id, c.sheet);
      ctx.emit({ type: "state" });
      const gain =
        r.kind === "ability"
          ? `${r.label} ${r.before}% → ${r.after}%${r.milestone ? ` — novo marco: ${r.milestone.description}` : ""}`
          : r.after > r.before
            ? `${r.label} ${r.before} → ${r.after}`
            : `${r.label}: ${r.atCap ? "no teto" : `${r.banked}/${r.need} h para +1`}`;
      ctx.emit({ type: "tool", name, summary: `🏋️ ${c.name} treinou ${r.hours} h: ${gain}` });
      let msg = `Treino de ${r.hours} h. Relógio: ${formatClock(minutes)} (${period(minutes)}). Hoje: ${r.hoursToday} h de treino.`;
      if (r.kind === "ability") {
        msg += ` Domínio de ${r.label}: ${r.before}% → ${r.after}%.`;
        if (r.capped) msg += " Rendimento cortado: chegou ao máximo de domínio por dia neste jutsu.";
        if (r.milestone) msg += ` NOVO MARCO ALCANÇADO: ${r.milestone.description} — narre esse avanço.`;
      } else {
        msg += r.after > r.before ? ` ${r.label} subiu de ${r.before} para ${r.after}!` : ` ${r.label} continua ${r.after}.`;
        msg += r.atCap
          ? ` Chegou ao teto do nível de poder: as horas não acumulam mais até o próximo nível.`
          : ` Horas acumuladas: ${r.banked}/${r.need} para o próximo +1.`;
      }
      return msg + lost;
    }
    case "add_item": {
      const c = await getChar(cid, String(args.character));
      const qty = Number(args.qty ?? 1);
      const existing = c.sheet.inventory.find(
        (i) => i.name.toLowerCase() === String(args.name).toLowerCase()
      );
      if (existing) existing.qty += qty;
      else
        c.sheet.inventory.push({
          name: String(args.name),
          qty,
          description: args.description ? String(args.description) : undefined,
        });
      await saveSheet(c.id, c.sheet);
      ctx.emit({ type: "state" });
      ctx.emit({ type: "tool", name, summary: `${c.name} +${qty}x ${args.name}` });
      return `Item adicionado.`;
    }
    case "remove_item": {
      const c = await getChar(cid, String(args.character));
      const qty = Number(args.qty ?? 1);
      const item = c.sheet.inventory.find(
        (i) => i.name.toLowerCase() === String(args.name).toLowerCase()
      );
      if (!item) return `Erro: ${c.name} não possui "${args.name}".`;
      item.qty -= qty;
      if (item.qty <= 0)
        c.sheet.inventory = c.sheet.inventory.filter((i) => i !== item);
      await saveSheet(c.id, c.sheet);
      ctx.emit({ type: "state" });
      ctx.emit({ type: "tool", name, summary: `${c.name} -${qty}x ${args.name}` });
      return `Item removido.`;
    }
    case "grant_xp": {
      const rs = ctx.campaign.ruleset;
      const c = await getChar(cid, String(args.character));
      const amount = Math.round(Number(args.amount));
      if (!Number.isFinite(amount)) return "amount precisa ser um número.";
      const lvlBefore = powerLevel(rs, c.sheet.xp).level;
      const ptsBefore = attributePoints(rs, c.sheet).earned;
      c.sheet.xp += amount;
      await saveSheet(c.id, c.sheet);
      const { level, next } = powerLevel(rs, c.sheet.xp);
      const pts = attributePoints(rs, c.sheet);
      const up = level && level.key !== lvlBefore?.key && level.xpRequired > (lvlBefore?.xpRequired ?? -1);
      ctx.emit({ type: "state" });
      ctx.emit({ type: "tool", name, summary: `${c.name} +${amount} XP (total ${c.sheet.xp})` });
      if (up) ctx.emit({ type: "tool", name, summary: `⬆ Nível de poder: ${level!.label}` });
      if (pts.earned > ptsBefore) ctx.emit({ type: "tool", name, summary: `+${pts.earned - ptsBefore} ponto(s) livre(s) de atributo` });
      let msg = `${c.name} agora tem ${c.sheet.xp} XP (nível de poder ${level?.label ?? "-"}${next ? `; próximo, ${next.label}, aos ${next.xpRequired}` : ""}).`;
      if (up)
        msg += ` NÍVEL DE PODER SUBIU para ${level!.label}${level!.attributeCap !== undefined ? ` (teto de atributo ${level!.attributeCap})` : ""}. Isso NÃO é promoção de cargo: o cargo só muda por set_rank, se e quando a história levar a isso (exame, cerimônia...).`;
      if (pts.earned > ptsBefore)
        msg += ` +${pts.earned - ptsBefore} ponto(s) livre(s) de atributo (${pts.free} livres): o jogador distribui na ficha; não aplique por ele.`;
      return msg;
    }
    case "set_rank": {
      const c = await getChar(cid, String(args.character));
      c.sheet.rank = String(args.rank);
      await saveSheet(c.id, c.sheet);
      ctx.emit({ type: "state" });
      ctx.emit({ type: "tool", name, summary: `${c.name} → ${args.rank}` });
      return `Rank atualizado.`;
    }
    case "update_extra_field": {
      const c = await getChar(cid, String(args.character));
      c.sheet.extra[String(args.field)] = String(args.value);
      await saveSheet(c.id, c.sheet);
      ctx.emit({ type: "state" });
      return `Campo atualizado.`;
    }
    case "add_memory": {
      // quando aconteceu, para o Mestre medir prazos e "há quanto tempo"
      const clock = getClock(ctx.campaign.state);
      const when = clock ? `[Dia ${clockParts(clock.minutes).day}, ${period(clock.minutes)}] ` : "";
      await addMemory(
        cid,
        String(args.kind),
        when + String(args.content),
        args.subject ? String(args.subject) : null,
        Number(args.importance ?? 3)
      );
      ctx.emit({ type: "tool", name, summary: `📌 ${String(args.content).slice(0, 80)}` });
      return `Memória registrada.`;
    }
    case "search_memories": {
      const hits = await searchMemories(cid, String(args.query), {
        kind: args.kind ? String(args.kind) : undefined,
        subject: args.subject ? String(args.subject) : undefined,
        limit: 8,
      });
      if (!hits.length) return "Nenhuma memória encontrada.";
      return hits
        .map((h) => `[${h.kind}${h.subject ? `/${h.subject}` : ""} imp=${h.importance}] ${h.content}`)
        .join("\n");
    }
    case "create_npc": {
      // registro na hora (o portão de NPC exige antes da narração); perfil e ficha vêm do Criador em segundo plano
      const sheet = blankSheet(ctx.campaign.ruleset);
      const said = String(args.rank ?? "").trim().toLowerCase();
      const rank = ctx.campaign.ruleset.ranks.find((k) => said && (k.key === said || k.label.toLowerCase() === said));
      if (rank) sheet.rank = rank.key;
      const brief = String(args.brief ?? "").trim();
      const persona = {
        personality: args.personality ? String(args.personality) : undefined,
        backstory: brief || undefined, // até o Criador terminar (ou se ele falhar), o Mestre se guia pelo brief
        // sem o parâmetro fica undefined e o Jev decide na 1ª fala
        gender: args.gender === "male" || args.gender === "female" ? args.gender : args.gender === "unknown" ? null : undefined,
      };
      const [npc] = await q<Character & { inserted: boolean }>(
        `INSERT INTO characters (campaign_id, kind, name, active, canon, sheet, persona)
         VALUES ($1,'npc',$2,TRUE,$3,$4,$5)
         ON CONFLICT (campaign_id, name) DO UPDATE SET active = TRUE
         RETURNING *, (xmax = 0) AS inserted`,
        [cid, String(args.name), !!args.canon, JSON.stringify(sheet), JSON.stringify(persona)]
      );
      ctx.emit({ type: "state" });
      if (!npc.inserted) {
        ctx.emit({ type: "tool", name: "set_npc_active", summary: `${npc.name} entrou em cena` });
        return `${npc.name} já estava registrado: voltou para a cena.`;
      }
      await queueProfile(ctx.campaign, npc, { brief: [brief, !rank && said && `cargo: ${args.rank}`].filter(Boolean).join(". "), fixedRank: !!rank });
      ctx.emit({ type: "tool", name, summary: `✨ NPC criado: ${npc.name}` });
      return `NPC ${npc.name} registrado e ativo na cena. O Criador de personagens monta perfil e ficha em segundo plano; até lá, interprete pelo brief.`;
    }
    case "set_npc_active": {
      const c = await getChar(cid, String(args.name));
      await q(`UPDATE characters SET active = $1, updated_at = now() WHERE id = $2`, [
        !!args.active,
        c.id,
      ]);
      if (args.note)
        await addMemory(cid, "npc", `${c.name}: ${args.note}`, c.name, 2);
      ctx.emit({ type: "state" });
      ctx.emit({
        type: "tool",
        name,
        summary: `${c.name} ${args.active ? "entrou em cena" : "saiu de cena"}`,
      });
      return `OK.`;
    }
    case "npc_message": {
      const c = await getChar(cid, String(args.npc));
      if (c.kind !== "npc") return `Erro: ${c.name} não é NPC.`;
      const message = String(args.message || "").trim().slice(0, 1500);
      if (!message) return "Erro: message vazia.";
      const [pending] = await q(`SELECT 1 FROM npc_chats WHERE npc_id = $1 AND unread LIMIT 1`, [c.id]);
      if (pending) return `${c.name} já tem uma mensagem que o jogador ainda não leu. Nada foi enviado.`;
      // sessão nova cujo 1º registro é do NPC; o intent só o agente do NPC vê
      await q(
        `INSERT INTO npc_chats (campaign_id, npc_id, session_id, role, content, unread, intent)
         VALUES ($1, $2, $3, 'npc', $4, TRUE, $5)`,
        [cid, c.id, randomUUID(), message, String(args.intent || "").trim().slice(0, 1000) || null]
      );
      await addMemory(cid, "npc", `${c.name} chamou o jogador para conversar em particular: "${message}"`, c.name, 3);
      ctx.emit({ type: "npc_message", npcId: c.id, name: c.name, preview: message.slice(0, 140) });
      ctx.emit({ type: "tool", name, summary: `✉️ ${c.name} quer falar com você em particular` });
      return `Mensagem de ${c.name} entregue ao jogador em particular. Ele decide se responde; a conversa é com o agente do NPC. Não repita o conteúdo na narração.`;
    }
    case "set_scene": {
      const moved = !!args.newScene || (args.location !== undefined && String(args.location) !== ctx.scene.location);
      await recordScenePlace(ctx, args); // mapa: local novo e rota desde o anterior (antes de a cena mudar)
      if (args.newScene) {
        await q(`UPDATE scenes SET is_current = FALSE WHERE campaign_id = $1`, [cid]);
        const rows = await q<Scene>(
          `INSERT INTO scenes (campaign_id, seq, mode, title, location)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [
            cid,
            ctx.scene.seq + 1,
            String(args.mode || ctx.scene.mode),
            String(args.title || ""),
            String(args.location || ctx.scene.location),
          ]
        );
        ctx.scene = rows[0];
        Object.assign(ctx, { scene: rows[0] });
      } else {
        if (args.mode) ctx.scene.mode = args.mode as Scene["mode"];
        if (args.title !== undefined) ctx.scene.title = String(args.title);
        if (args.location !== undefined) ctx.scene.location = String(args.location);
        await q(
          `UPDATE scenes SET mode = $1, title = $2, location = $3 WHERE id = $4`,
          [ctx.scene.mode, ctx.scene.title, ctx.scene.location, ctx.scene.id]
        );
      }
      // só present (correção do elenco): sem chip de cena repetido
      if (args.newScene || args.mode || args.title !== undefined || args.location !== undefined) {
        ctx.emit({ type: "scene", scene: ctx.scene });
        ctx.emit({
          type: "tool",
          name,
          summary: `🎬 ${ctx.scene.mode}${ctx.scene.location ? ` — ${ctx.scene.location}` : ""}`,
        });
      }
      if (moved) ctx.sceneChanged = true;
      let cast = "";
      if (Array.isArray(args.present)) {
        // elenco declarado: quem não está na lista sai, quem está volta
        const chars = await q<{ id: string; name: string; kind: string; active: boolean }>(
          `SELECT id, name, kind, active FROM characters WHERE campaign_id = $1`,
          [cid]
        );
        const here = new Set<string>();
        const unknown: string[] = [];
        for (const said of args.present.map(String)) {
          const found = findNamed(chars, said);
          if (!found.length) unknown.push(said);
          for (const c of found) here.add(c.id);
        }
        const npcs = chars.filter((c) => c.kind === "npc");
        await setNpcsActive(cid, npcs.filter((c) => c.active && !here.has(c.id)), false, ctx.emit);
        await setNpcsActive(cid, npcs.filter((c) => !c.active && here.has(c.id)), true, ctx.emit);
        ctx.castSet = true;
        cast = ` NPCs em cena: ${npcs.filter((c) => here.has(c.id)).map((c) => c.name).join(", ") || "nenhum"}.`;
        if (unknown.length) cast += ` Sem registro: ${unknown.join(", ")} (se tem nome e está na cena, chame create_npc).`;
      } else if (moved) {
        const still = await q<{ name: string }>(`SELECT name FROM characters WHERE campaign_id = $1 AND kind = 'npc' AND active`, [cid]);
        if (still.length)
          cast = ` FALTOU present: ${still.map((c) => c.name).join(", ")} continuam em cena. Chame set_scene de novo só com present (a lista de quem está no novo lugar).`;
      }
      return `Cena atualizada: modo=${ctx.scene.mode}, local=${ctx.scene.location}.${cast}`;
    }
    case "advance_time":
    case "set_time": {
      const before = getClock(ctx.campaign.state)?.minutes;
      let minutes: number;
      if (name === "advance_time") {
        if (before === undefined) return "O relógio ainda não foi definido: chame set_time primeiro.";
        const delta = Math.round(Number(args.minutes));
        if (!Number.isFinite(delta) || delta < 0) return "minutes precisa ser um número >= 0.";
        minutes = before + Math.min(delta, 30 * 1440);
      } else {
        const hour = Math.round(Number(args.hour));
        const minute = Math.round(Number(args.minute ?? 0));
        if (!(hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59)) return "hour 0-23 e minute 0-59.";
        const today = before === undefined ? 1 : clockParts(before).day;
        const day = args.day !== undefined ? Math.max(1, Math.round(Number(args.day)) || 1) : today;
        minutes = toMinutes(day, hour, minute);
        // sem day explícito o tempo não volta: hora que já passou hoje = amanhã
        if (args.day === undefined && before !== undefined && minutes < before) minutes += 1440;
      }
      ctx.campaign.state = { ...ctx.campaign.state, clock: { minutes } };
      ctx.emit({ type: "time", minutes });
      const delta = before === undefined ? "" : ` (${minutes >= before ? "+" : "-"}${formatDuration(Math.abs(minutes - before))})`;
      ctx.emit({ type: "tool", name, summary: `🕐 ${formatClock(minutes)}${delta}${args.reason ? ` — ${args.reason}` : ""}` });
      const lost = await saveClock(cid, minutes, ctx.emit); // depois do chip do relógio: "⌛ Prazo perdido" vem em seguida
      return `Relógio: ${formatClock(minutes)} (${period(minutes)})${delta}.${lost}`;
    }
    case "add_objective":
    case "update_objective": {
      const now = getClock(ctx.campaign.state)?.minutes;
      const list = await loadObjectives(cid);
      const deadline = parseDeadline(args, now);
      if (typeof deadline === "string") return deadline;
      let o: Objective;
      let chip: string;
      if (name === "add_objective") {
        const title = String(args.title || "").trim();
        if (!title) return "Informe o title.";
        if (list.some((x) => x.status === "aberto" && x.title.toLowerCase() === title.toLowerCase()))
          return `Já existe "${title}" em aberto: use update_objective.`;
        const kind = (["missao", "evento", "outro"].includes(String(args.kind)) ? args.kind : "outro") as ObjectiveKind;
        o = {
          id: `o${list.reduce((m, x) => Math.max(m, Number(x.id.slice(1)) || 0), 0) + 1}`,
          title,
          kind,
          description: String(args.description || ""),
          deadlineMinutes: deadline,
          status: "aberto",
          reward: args.reward ? String(args.reward) : undefined,
          createdAt: now ?? 0,
        };
        list.push(o);
        chip = `📜 ${OBJECTIVE_KIND_LABEL[kind]}: ${title} (${deadlineText(deadline, now)})`;
      } else {
        const key = String(args.objective || "").trim().toLowerCase();
        const found =
          list.find((x) => x.id.toLowerCase() === key) ||
          list.find((x) => x.status === "aberto" && x.title.toLowerCase() === key) ||
          list.find((x) => x.title.toLowerCase() === key);
        if (!found) return `Objetivo "${args.objective}" não existe. Abertos: ${list.filter((x) => x.status === "aberto").map((x) => `${x.id} ${x.title}`).join(", ") || "nenhum"}.`;
        if (found.status !== "aberto") return `"${found.title}" já está ${found.status}; não volta a ficar aberto.`;
        o = found;
        const changes: string[] = [];
        if (args.description) o.description = String(args.description);
        if (args.noDeadline === true) (o.deadlineMinutes = undefined), changes.push("sem prazo");
        else if (deadline !== undefined) (o.deadlineMinutes = deadline), changes.push(deadlineText(deadline, now));
        if (args.status === "concluido" || args.status === "cancelado") {
          o.status = args.status;
          o.closedAt = now ?? 0;
        }
        chip =
          o.status === "concluido" ? `✅ Concluído: ${o.title}` :
          o.status === "cancelado" ? `✖ Cancelado: ${o.title}` :
          `📜 ${o.title}: ${changes.join(", ") || "atualizado"}`;
      }
      await saveObjectives(cid, list);
      ctx.campaign.state = { ...ctx.campaign.state, objectives: list };
      ctx.emit({ type: "tool", name, summary: chip });
      ctx.emit({ type: "state" });
      return `${o.id} "${o.title}": ${o.status}, ${deadlineText(o.deadlineMinutes, now)}.`;
    }
    case "get_character": {
      const c = await getChar(cid, String(args.name));
      return JSON.stringify(
        { name: c.name, kind: c.kind, active: c.active, canon: c.canon, sheet: c.sheet, persona: c.persona },
        null,
        1
      );
    }
    case "get_script": {
      return ctx.campaign.script
        ? JSON.stringify(ctx.campaign.script, null, 1)
        : "Esta campanha não tem roteiro gerado.";
    }
    case "update_script": {
      const script = ctx.campaign.script;
      if (!script) return "Sem roteiro para atualizar.";
      const arc = script.arcs.find(
        (a) => a.title.toLowerCase() === String(args.arcTitle).toLowerCase()
      );
      if (!arc) return `Arco "${args.arcTitle}" não encontrado. Arcos: ${script.arcs.map((a) => a.title).join("; ")}`;
      if (args.note) arc.notes.push(String(args.note));
      if (args.status) arc.status = args.status as "pending" | "active" | "done";
      await q(`UPDATE campaigns SET script = $1, updated_at = now() WHERE id = $2`, [
        JSON.stringify(script),
        cid,
      ]);
      ctx.emit({ type: "tool", name, summary: `📜 roteiro: ${arc.title} (${arc.status})` });
      return "Roteiro atualizado.";
    }
    case "search_book": {
      const hits = await searchBookChunks(cid, String(args.query), 5);
      if (!hits.length) return "Nada encontrado nos livros indexados.";
      return hits
        .map((h) => `[${h.title} | bookId=${h.book_id} | pág. ${h.page}]\n${h.content}`)
        .join("\n---\n");
    }
    case "read_pages": {
      const from = Number(args.from);
      const to = Number(args.to ?? from);
      const pages = await readPages(String(args.bookId), from, to);
      if (!pages.length) return "Páginas não encontradas (verifique bookId e intervalo).";
      return pages.map((p) => `=== Página ${p.page} ===\n${p.content}`).join("\n\n");
    }
    case "list_books": {
      const books = await listBooks(cid);
      if (!books.length) return "Nenhum livro indexado nesta campanha.";
      return books.map((b) => `${b.title} — bookId=${b.id}, ${b.pages} páginas`).join("\n");
    }
    case "update_map":
    case "set_stage":
      return executeMapTool(name, args, ctx);
    default:
      return `Ferramenta desconhecida: ${name}`;
  }
}
