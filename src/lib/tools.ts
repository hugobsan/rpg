import { randomUUID } from "node:crypto";
import { q } from "./db";
import { getAdvanced } from "./advanced";
import { ToolDef } from "./openrouter";
import { rollDice } from "./dice";
import { addMemory, formatHistory, searchHistory, searchMemories, searchBookChunks } from "./retrieval";
import { listBooks, readPages } from "./books";
import { Ability, Campaign, Character, LibraryAbility, LibraryItem, Scene, Sheet, TableRules, TurnEvent } from "./types";
import { abilityPromptLine, blankSheet, currentMilestone, nextMilestone } from "./ruleset";
import { dehydrateSheet, editAbility, findLibrary, hydrateSheets, itemText, libraryLine, linkAbility, listLibrary } from "./library";
import {
  abilityAttribute,
  attributePoints,
  costBreakdown,
  costMultOf,
  COST_MULT_MAX,
  COST_MULT_MIN,
  controlLabel,
  effectiveCost,
  findAbility,
  gainMastery,
  masteryBonus,
  NEW_ABILITY_MASTERY,
  powerLevel,
  raiseBlocked,
  train,
  trainingRules,
  type TrainResult,
  useGain,
} from "./progression";
import { clockParts, formatClock, formatDuration, getClock, period, toMinutes } from "./clock";
import {
  expireObjectives,
  formatRemaining,
  getObjectives,
  Objective,
  OBJECTIVE_KIND_LABEL,
  OBJECTIVE_XP_SIZES,
  ObjectiveKind,
  objectiveXp,
  ObjectiveXpSize,
} from "./objectives";
import { executeMapTool, recordScenePlace } from "./map";
import { executeLocalMapTool, executeMapBrief, MAP_BRIEF_TOOL } from "./cartographer";
import { dcResultText, getTable, tableDc } from "./table";
import { queueProfile } from "./characters";

// add_ability espera o Criador de habilidades até isto; depois registra incompleta com o que o Mestre passou
// (se o Criador responder depois, a resposta completa a entrada: linkAbility)
const CREATOR_TIMEOUT_MS = 90_000;

const MILESTONE_SCHEMA = {
  type: "array",
  description:
    "Marcos de capacidade por nível de domínio (opcional). Use quando a habilidade evolui em estágios com poderes distintos (ex: um olho ou dom especial que desbloqueia leitura de movimentos aos 25%, cópia de técnicas aos 50%...). Inclua um marco com threshold=0 descrevendo a capacidade inicial.",
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
        "Altera um recurso (saúde, energia do poder...) de um personagem. Use delta para dano/cura/gasto, ou set para fixar. Opcionalmente ajusta o máximo.",
      parameters: S(
        {
          character: { type: "string", description: "nome exato" },
          resource: { type: "string", description: "key do recurso, como está na mecânica (ex: hp)" },
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
        "Liga uma técnica na ficha: quando o personagem aprende E quando usa uma técnica plausível que ainda não está na ficha (registre antes de resolver). Passe só o nome e um brief: a técnica vem da biblioteca do mundo ou o Criador de habilidades a cria agora, completa (tipo, rank, consumo, efeito, dano, marcos de domínio; o valor do custo vem das regras do mundo). Se já está na ficha, só ajusta o domínio (progress). Para mudar a técnica em si, use edit_ability.",
      parameters: S(
        {
          character: { type: "string" },
          name: { type: "string", description: "nome da técnica como é conhecida no mundo" },
          brief: { type: "string", description: "o que é e faz, em uma frase, para o Criador (se não estiver na biblioteca)" },
          abilityType: { type: "string", description: "opcional: key do tipo, só como dica" },
          element: { type: "string", description: "opcional: key do elemento do mundo, se houver (Naruto: natureza do chakra; Avatar: dobra), só como dica" },
          rank: { type: "string", description: "opcional: nível, só como dica" },
          costFree: { type: "boolean", description: "opcional: true se não gasta recurso (técnicas físicas, armas, ofícios, passivas), só como dica" },
          consumption: { type: "string", description: "opcional: key da faixa de consumo do mundo (MECÂNICA), só como dica" },
          costUnit: { type: "string", description: "opcional: unidade do custo, se o gasto é por unidade (Naruto: clone; Harry Potter: rodada), só como dica" },
          progress: {
            type: "number",
            description: `0-100: domínio inicial (default ${NEW_ABILITY_MASTERY}). Registrada na hora do uso: 10-25; aprendida com treino longo: mais.`,
          },
        },
        ["character", "name"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "edit_ability",
      description:
        "Corrige uma técnica NA BIBLIOTECA DO MUNDO: muda para todos que a têm, em todas as campanhas deste mundo (as fichas apontam para ela). Use para completar uma registrada incompleta, corrigir tipo, rank, consumo, unidade de custo, efeito, dano, marcos ou renomear (siga o padrão de nomes do mundo). Não use para algo que é só de um personagem: domínio é update_ability_progress; custo maior ou menor para alguém é set_cost_modifier. Mande só o que muda; texto vazio apaga o campo.",
      parameters: S(
        {
          name: { type: "string", description: "nome atual da técnica na biblioteca" },
          new_name: { type: "string", description: "novo nome, no padrão de nomes do mundo" },
          translation: { type: "string", description: "tradução para exibição, se o padrão do mundo usar" },
          type: { type: "string", description: "key do tipo" },
          element: { type: "string", description: "key do elemento do mundo, se houver (Naruto: natureza do chakra; Avatar: dobra); vazio = sem elemento" },
          rank: { type: "string" },
          costFree: { type: "boolean", description: "true se não gasta recurso (técnicas físicas, armas, ofícios, passivas)" },
          consumption: { type: "string", description: "key da faixa de consumo do mundo (quanto recurso a técnica gasta, independente do rank); vazio = custo do rank" },
          costUnit: { type: "string", description: "unidade do custo quando o gasto é por unidade, no singular (Naruto: clone; Harry Potter: rodada; invocação); vazio = por uso" },
          description: { type: "string" },
          effect: { type: "string", description: "o que faz em jogo (alcance, duração, teste)" },
          damage: { type: "string", description: "dano em notação de dado, ex: 2d6" },
          requirements: { type: "string", description: "selos, elemento, kekkei genkai, outra técnica" },
          milestones: { ...MILESTONE_SCHEMA, description: "marcos de domínio (lista inteira, substitui a anterior)" },
          users: { type: "string", description: "quem é conhecido por usar" },
        },
        ["name"]
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
        "Resolve o uso de uma técnica DA FICHA do personagem (o que a mecânica chama de habilidade: magia, golpe especial...). O servidor faz a conta: desconta o custo já ajustado (faixa de consumo ou rank × multiplicadores do personagem × domínio; × units se a técnica custa por unidade; falha sem rolar se não houver recurso), rola 1d20 + atributo x multiplicador + bônus do domínio contra a CD (o jogador vê a rolagem) e sobe o domínio pelo uso. Use no lugar de roll_dice + update_resource para técnicas da ficha. O dano, se houver, role à parte com roll_dice.",
      parameters: S(
        {
          character: { type: "string" },
          ability: { type: "string", description: "nome exato da técnica na ficha" },
          attribute: { type: "string", description: "key do atributo do teste, só para trocar o padrão do tipo" },
          dc: { type: "number", description: "dificuldade (CD). Omita só em disputa direta (rolagem oposta). O servidor soma o ajuste das REGRAS DA MESA" },
          category: { type: "string", description: "tipo de ação, uma das keys das REGRAS DA MESA (se houver)" },
          target: { type: "string", description: "alvo, se houver" },
          units: { type: "number", description: "só para técnica com custo por unidade (ex.: quantas cópias, rodadas mantidas ou invocações): inteiro ≥ 1, padrão 1" },
          note: { type: "string", description: "contexto curto do uso" },
        },
        ["character", "ability"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "set_cost_modifier",
      description: `Ajusta quanto um personagem gasta: sem ability, o multiplicador geral de custo das técnicas dele (o nome no mundo vem na MECÂNICA; ex.: controle excelente 0,75, bom 0,9, ruim 1,25, péssimo 1,5); com ability, o multiplicador só daquela técnica para ele (ex.: técnica de linhagem usada por quem não nasceu com ela 1,5). 1 volta ao padrão. Entre ${COST_MULT_MIN} e ${COST_MULT_MAX}. Use quando a história mostra a mudança (treino de controle, uma condição) ou para corrigir; não é da técnica: para todos, use edit_ability.`,
      parameters: S(
        {
          character: { type: "string" },
          ability: { type: "string", description: "opcional: nome exato da técnica na ficha; sem ele, o multiplicador geral" },
          mult: { type: "number", description: `multiplicador (${COST_MULT_MIN} a ${COST_MULT_MAX}; 1 = padrão; menor gasta menos)` },
          reason: { type: "string", description: "por quê, em poucas palavras" },
        },
        ["character", "mult"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "train",
      description:
        "Treino: avança o relógio pelas horas treinadas e só então aplica o ganho. Habilidade: o domínio sobe por hora (menos nos domínios altos). Atributo: as horas acumulam até o próximo +1, até o teto do nível de poder. Há limite de horas de treino por dia e de domínio ganho por habilidade por dia; acima disso o treino é recusado (exausto). Não chame advance_time para as mesmas horas.",
      parameters: S(
        {
          character: { type: "string" },
          target: { type: "string", description: "nome da habilidade da ficha ou key do atributo" },
          hours: { type: "number", description: "horas realistas de treino (inteiras, ex: 2, 4)" },
          parallel: {
            type: "array",
            items: { type: "string" },
            description: "só se o mundo tem Treino simultâneo (veja as regras): outros alvos treinados nas mesmas horas (ex. Naruto: um por clone das sombras)",
          },
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
      description: "Adiciona item ao inventário (soma quantidade se já existir). Item da biblioteca do mundo: a descrição vem dela.",
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
      name: "search_library",
      description:
        "Consulta a biblioteca do mundo (técnicas e itens já criados, do cânone ou não) antes de inventar uma técnica ou um item. Sem query, lista os nomes.",
      parameters: S(
        {
          kind: { type: "string", enum: ["ability", "item"] },
          query: { type: "string", description: "parte do nome ou do texto (ex: fogo, cura)" },
        },
        ["kind"]
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
      name: "search_history",
      description:
        "Busca no chat inteiro da campanha, desde o começo (turnos e conversas particulares com NPCs). Devolve trechos curtos com dia, hora e local. Use para lembrar exatamente o que alguém disse ou fez, ou detalhes antigos que não viraram memória. É o que aconteceu naquele momento: ficha e memórias atuais valem mais.",
      parameters: S(
        { query: { type: "string" }, npc: { type: "string", description: "nome do NPC: só trechos com ele" } },
        ["query"]
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "create_npc",
      description:
        "Registra um NPC novo na hora, ativo na cena. O Criador de personagens monta perfil e ficha em segundo plano a partir do brief. canon=true para personagens da obra.",
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
        "O NPC chama o jogador para conversar em particular (caixa de entrada; o jogador decide se responde, e a conversa segue com o agente do NPC). Com parcimônia, só com motivo real (algo a contar, pedido, aviso, segredo, relação), nunca para exposição ou empurrar a trama. Meio coerente com a distância e o cenário (de lado, recado, mensageiro, rádio...). Na narração, no máximo sinalize a chegada.",
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
        "Opcional: fixa quanto o relógio da história anda neste turno. Sem ela, o sistema estima pelo que a narração mostra; use quando souber a duração exata (uma troca de falas leva minutos, um combate poucos minutos, uma refeição ou um treino curto ~1 h, uma viagem horas). Uma vez por turno. Exige o relógio já definido (set_time).",
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
        "Registra uma missão, um evento marcado ou outro compromisso da história, com prazo opcional em tempo do jogo. Prazo absoluto (day + hour/minute; sem day, a próxima vez que der essa hora) ou relativo (inMinutes/inHours/inDays a partir de agora). Quando o relógio passa do prazo, o sistema marca como perdido. status oferecida: missão proposta que o jogador ainda não aceitou (não vence; o prazo só conta depois de aceita). xpSize: a XP que a missão dá ao ser concluída, calculada pela regra de XP da mesa.",
      parameters: S(
        {
          title: { type: "string", description: "nome curto (ex: 'Escoltar o Tazuna', 'Exame Chūnin')" },
          kind: { type: "string", enum: ["missao", "evento", "outro"] },
          description: { type: "string", description: "o que precisa ser feito ou o que vai acontecer, e onde" },
          reward: { type: "string", description: "recompensa ou o que está em jogo (opcional)" },
          giver: { type: "string", description: "quem ofereceu ou pediu (nome do NPC), se houver" },
          status: { type: "string", enum: ["aberto", "oferecida"], description: "oferecida: o jogador ainda não aceitou (padrão aberto)" },
          xpSize: {
            type: "string",
            enum: OBJECTIVE_XP_SIZES,
            description: "peso na história (XP ao concluir): pequena = favor ou tarefa curta; media = trabalho de um dia ou com algum risco; grande = missão perigosa ou que move um arco; excepcional = só o que as faixas não cobrem (com xp)",
          },
          xp: { type: "number", description: "só com xpSize excepcional: XP livre, proporcional ao feito" },
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
        "Atualiza uma missão/evento registrado: concluir quando cumprido (missão com xpSize já dá a XP ao jogador), cancelar quando deixou de valer na história (ou o jogador recusou a oferecida), aberto quando o jogador aceitou a oferecida, ou mudar o prazo e o tamanho (mesmos campos de add_objective; noDeadline=true tira o prazo). Um objetivo perdido não volta.",
      parameters: S(
        {
          objective: { type: "string", description: "id (ex: o2) ou título" },
          status: { type: "string", enum: ["aberto", "concluido", "cancelado"] },
          description: { type: "string", description: "nova descrição (opcional)" },
          xpSize: {
            type: "string",
            enum: OBJECTIVE_XP_SIZES,
            description: "peso na história (XP ao concluir): pequena = favor ou tarefa curta; media = trabalho de um dia ou com algum risco; grande = missão perigosa ou que move um arco; excepcional = só o que as faixas não cobrem (com xp)",
          },
          xp: { type: "number", description: "só com xpSize excepcional: XP livre, proporcional ao feito" },
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
      name: "fix_objective",
      description:
        "Corrige um REGISTRO ERRADO de missão: o painel diz concluída, perdida, cancelada ou com prazo algo que na história não aconteceu (o jogador apontou ou a narração contradiz). Pode reabrir, mudar o status, o prazo, a descrição ou remover um registro duplicado. Nunca use para desfazer uma perda ou um fracasso que aconteceu na história.",
      parameters: S(
        {
          objective: { type: "string", description: "id (ex: o2) ou título" },
          reason: { type: "string", description: "qual era o erro do registro" },
          status: { type: "string", enum: ["oferecida", "aberto", "concluido", "cancelado", "perdido"] },
          remove: { type: "boolean", description: "true: apaga o registro (duplicado ou criado por engano)" },
          description: { type: "string" },
          day: { type: "number" },
          hour: { type: "number" },
          minute: { type: "number" },
          inMinutes: { type: "number" },
          inHours: { type: "number" },
          inDays: { type: "number" },
          noDeadline: { type: "boolean" },
        },
        ["objective", "reason"]
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
        "Lê páginas inteiras de um livro indexado (poucas por chamada: a resposta avisa onde parou). Use após search_book para contexto completo, página seguinte/anterior ou um intervalo específico.",
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
  // mapa e palco: o Mestre só manda o brief; update_map, set_stage e local_map ficam com o Topógrafo (e no fora do jogo)
  MAP_BRIEF_TOOL,
];

// o Escrivão registra estas depois da narração, pelo que ela mostra: saem do turno do Mestre (o fora do jogo fica com todas)
export const SCRIBE_TOOLS = new Set([
  "update_resource", "add_item", "remove_item", "add_memory", "grant_xp", "update_ability_progress", "update_extra_field",
  "add_objective", "update_objective",
]);

// anotações cujo resultado o Mestre não precisa para narrar: rodam depois da narração, sem outra rodada do modelo
export const DEFERRED_TOOLS = new Set(["advance_time", "set_scene", "set_npc_active", "set_rank", "update_script", "note_objective", "map_brief"]);

/** Ferramentas do turno do Mestre: sem as do Escrivão (advance_time fica: o Mestre controla o ritmo; o Jev só cobre o esquecimento). */
export const GM_TURN_TOOLS: ToolDef[] = [
  ...GM_TOOLS.filter((t) => !SCRIBE_TOOLS.has(t.function.name)),
  {
    type: "function",
    function: {
      name: "note_objective",
      description:
        "Anota numa frase uma missão, evento marcado ou compromisso com prazo que a história criou, mudou, cumpriu ou cancelou (ex.: \"Hokage deu a missão de escoltar o Tazuna até a Vila da Névoa, prazo de 3 dias; recompensa 30 mil ryō\", \"missão do Tazuna concluída\"). Diga o tamanho (pequena, média, grande ou excepcional) e se é só oferecida (o jogador ainda não aceitou). O Escrivão registra com o prazo em tempo do jogo depois da narração.",
      parameters: S({ brief: { type: "string", description: "o que foi combinado, prazo, recompensa e tamanho, como a história disse" } }, ["brief"]),
    },
  },
];

export interface ToolContext {
  campaign: Campaign;
  scene: Scene;
  emit: (e: TurnEvent) => void;
  sceneChanged?: boolean; // set_scene abriu cena nova ou mudou o local neste turno
  castSet?: boolean; // set_scene informou present: o elenco já está certo
  modeSet?: boolean; // set_scene trocou o modo neste turno: o modo pela narração (engine.fallbackPlace) não mexe
  /** habilidades (personagem:ref) que já subiram de domínio neste turno por use_ability ou train: o Escrivão não repete */
  masteryGained?: Set<string>;
  /** é o Escrivão (engine.runScribe); briefs = anotações de missão do Mestre neste turno */
  scribe?: { briefs: number };
  /** XP que missões concluídas deram neste turno: o grant_xp do Escrivão não repete pela mesma conclusão */
  missionXp?: { charId: string; title: string; xp: number }[];
}

// "Evento: Resposta do Hokage" = "resposta do hokage": o modelo repetia missões abertas com prefixo ou pontuação diferente
const titleKey = (s: string) =>
  s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/^\s*(evento|missao|prazo|objetivo|outro)\s*:\s*/, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

const gainedKey = (c: Character, a: Ability) => `${c.id}:${a.ref ?? a.name.toLowerCase()}`;
const markGained = (ctx: ToolContext, c: Character, a: Ability) => (ctx.masteryGained ??= new Set()).add(gainedKey(c, a));

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
  return (await hydrateSheets(rows))[0];
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

export async function loadObjectives(campaignId: string): Promise<Objective[]> {
  const [row] = await q<{ state: Record<string, unknown> }>(`SELECT state FROM campaigns WHERE id = $1`, [campaignId]);
  return getObjectives(row?.state);
}

/** Grava só state.objectives, sem tocar no resto de campaigns.state. */
export async function saveObjectives(campaignId: string, list: Objective[]): Promise<void> {
  await q(`UPDATE campaigns SET state = state || jsonb_build_object('objectives', $1::jsonb) WHERE id = $2`, [
    JSON.stringify(list),
    campaignId,
  ]);
}

/** O turno que começou em `since` terminou: a decisão pelo painel anterior a ele já foi narrada e a marca sai. */
export async function clearPanelDecisions(campaignId: string, since: number): Promise<void> {
  const list = await loadObjectives(campaignId);
  const done = (o: Objective) => (o.decidedAt ?? Infinity) < since;
  if (list.some(done)) await saveObjectives(campaignId, list.map((o) => (done(o) ? { ...o, decidedAt: undefined } : o)));
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
    JSON.stringify(dehydrateSheet(sheet)),
    id,
  ]);
}

/** Soma XP na ficha (grant_xp e a conclusão de missão com tamanho), com os chips e o aviso de nível e pontos. */
async function grantXp(ctx: ToolContext, c: Character, amount: number, reason?: string): Promise<string> {
  const rs = ctx.campaign.ruleset;
  const lvlBefore = powerLevel(rs, c.sheet.xp).level;
  const ptsBefore = attributePoints(rs, c.sheet).earned;
  c.sheet.xp += amount;
  await saveSheet(c.id, c.sheet);
  const { level, next } = powerLevel(rs, c.sheet.xp);
  const pts = attributePoints(rs, c.sheet);
  const up = level && level.key !== lvlBefore?.key && level.xpRequired > (lvlBefore?.xpRequired ?? -1);
  ctx.emit({ type: "state" });
  ctx.emit({ type: "tool", name: "grant_xp", summary: `${c.name} +${amount} XP (total ${c.sheet.xp})${reason ? ` — ${reason}` : ""}` });
  if (up) ctx.emit({ type: "tool", name: "grant_xp", summary: `⬆ Nível de poder: ${level!.label}` });
  if (pts.earned > ptsBefore) ctx.emit({ type: "tool", name: "grant_xp", summary: `+${pts.earned - ptsBefore} ponto(s) livre(s) de atributo` });
  let msg = `${c.name} agora tem ${c.sheet.xp} XP (nível de poder ${level?.label ?? "-"}${next ? `; próximo, ${next.label}, aos ${next.xpRequired}` : ""}).`;
  if (up)
    msg += ` NÍVEL DE PODER SUBIU para ${level!.label}${level!.attributeCap !== undefined ? ` (teto de atributo ${level!.attributeCap})` : ""}. Isso NÃO é promoção de cargo: o cargo só muda por set_rank, se e quando a história levar a isso (exame, cerimônia...).`;
  if (pts.earned > ptsBefore)
    msg += ` +${pts.earned - ptsBefore} ponto(s) livre(s) de atributo (${pts.free} livres): o jogador distribui na ficha; não aplique por ele.`;
  return msg;
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
      const abilityName = String(args.name || "").trim();
      if (!abilityName) return "Erro: informe name.";
      // biblioteca do mundo > Criador de habilidades (com prazo) > o que o Mestre passou (incompleta): a ficha sempre recebe uma ref
      const brief = [
        args.brief,
        args.abilityType && `tipo sugerido: ${args.abilityType}`,
        args.element && `elemento sugerido: ${args.element}`,
        args.rank && `nível sugerido: ${args.rank}`,
        args.costFree === true && "não gasta recurso",
        args.consumption && `consumo sugerido: ${args.consumption}`,
        args.costUnit && `custo por ${args.costUnit}`,
      ]
        .filter(Boolean)
        .join("; ");
      const { entry, from } = await linkAbility(ctx.campaign, abilityName, {
        brief,
        fallback: args,
        timeoutMs: CREATOR_TIMEOUT_MS,
        onCreator: () => ctx.emit({ type: "status", text: `Criador de habilidades: ${abilityName}` }),
      });
      const idx = c.sheet.abilities.findIndex((a) => a.ref === entry.id);
      // já na ficha sem informar o domínio: mantém o que ele tinha
      const progress =
        typeof args.progress === "number"
          ? Math.max(0, Math.min(100, args.progress))
          : idx >= 0
            ? c.sheet.abilities[idx].progress
            : NEW_ABILITY_MASTERY;
      // o multiplicador de custo do vínculo é do personagem: re-ligar não o perde
      const ability: Ability = { ...(entry.data as LibraryAbility), name: entry.name, ref: entry.id, progress, costMult: idx >= 0 ? c.sheet.abilities[idx].costMult : undefined };
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
      const origin =
        from === "library"
          ? "da biblioteca"
          : from === "creator"
            ? "criada pelo Criador de habilidades e guardada na biblioteca"
            : "o Criador não respondeu: registrada INCOMPLETA na biblioteca, só com o que você passou; complete com edit_ability";
      return `Habilidade ${idx >= 0 ? "já estava na ficha" : "adicionada"} (${origin}): ${abilityPromptLine(ctx.campaign.ruleset, ability, Infinity, c.sheet)}.${cur ? ` Marco atual: ${cur.description}` : ""}`;
    }
    case "edit_ability": {
      const target = String(args.name || "").trim();
      if (!target) return "Erro: informe name.";
      const { name: _cur, new_name, ...patch } = args;
      void _cur;
      if (typeof new_name === "string" && new_name.trim()) patch.name = new_name.trim();
      const e = await editAbility(ctx.campaign, target, patch);
      if (typeof e === "string") return `Erro: ${e}`;
      ctx.emit({ type: "state" });
      ctx.emit({ type: "tool", name, summary: `📚 Biblioteca: ${e.name}${e.name !== target ? ` (era ${target})` : ""} editada` });
      return `Técnica editada na biblioteca do mundo (vale para todos que a têm): ${libraryLine(ctx.campaign.ruleset, e)}`;
    }
    case "update_ability_progress": {
      const c = await getChar(cid, String(args.character));
      const ability = findAbility(c.sheet, String(args.name || ""));
      if (!ability)
        return `Erro: ${c.name} não possui a habilidade "${args.name}". Use add_ability para ligá-la primeiro.`;
      // o modelo costuma repetir o ganho que use_ability/train já deram (a narração conta "subiu de 63% para 66%")
      if (typeof args.delta === "number" && typeof args.set !== "number" && ctx.masteryGained?.has(gainedKey(c, ability)))
        return `Nada mudou: o domínio de ${ability.name} já subiu neste turno pelo uso ou treino (${ability.progress ?? 0}%). Não repita o ganho de use_ability/train.`;
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
      const cost = effectiveCost(rs, ability, { sheet: c.sheet, units: Number(args.units) || 1 });
      // a conta só quando algo mudou o valor da faixa/rank (multiplicador ou unidades)
      const how = cost && (cost.amount !== cost.base || cost.unit) ? ` (${costBreakdown(rs, ability, cost)})` : "";
      const pool = cost && cost.amount > 0 ? c.sheet.resources[cost.resource] : undefined;
      if (cost && cost.amount > 0) {
        if (!pool) return `Erro: recurso "${cost.resource}" não existe na ficha de ${c.name}.`;
        if (pool.current < cost.amount) {
          // com unidade: quantas cabem no que resta (para o Mestre narrar menos cópias/rodadas em vez de nada)
          let fit = cost.units - 1;
          while (fit > 0 && effectiveCost(rs, ability, { sheet: c.sheet, units: fit })!.amount > pool.current) fit--;
          return `FALHOU sem rolar: ${ability.name} custa ${cost.amount} ${cost.resource}${how} e ${c.name} tem ${pool.current}.${fit > 0 ? ` Dá para units ${fit} no máximo (por ${cost.unit}).` : ""} Nada foi gasto. Narre a falta de ${cost.resource}.`;
        }
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
      markGained(ctx, c, ability);
      await saveSheet(c.id, c.sheet);
      ctx.emit({ type: "state" });
      if (pool)
        ctx.emit({
          type: "tool",
          name,
          summary: `${c.name} usou ${ability.name}: −${cost!.amount} ${cost!.resource}${cost!.unit && cost!.units > 1 ? ` (${cost!.units} × ${cost!.base} por ${cost!.unit}${cost!.amount !== cost!.units * cost!.base ? ", ajustado" : ""})` : ""} (${pool.current}/${pool.max})`,
        });
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
      msg += pool ? ` Custo pago: ${cost!.amount} ${cost!.resource}${how}; resta ${pool.current}/${pool.max}.` : " Sem custo.";
      msg += g.after > g.before ? ` Domínio ${g.before}% → ${g.after}%.` : g.capped ? ` Domínio ${g.after}% (já rendeu o máximo hoje).` : ` Domínio ${g.after}%.`;
      if (g.milestone) msg += ` NOVO MARCO ALCANÇADO: ${g.milestone.description} — narre esse avanço.`;
      if (ability.damage) msg += ` Dano registrado: ${ability.damage} (role com roll_dice se acertou).`;
      return msg;
    }
    case "set_cost_modifier": {
      const rs = ctx.campaign.ruleset;
      const c = await getChar(cid, String(args.character));
      const mult = Math.round(Number(args.mult) * 100) / 100;
      if (!Number.isFinite(mult) || mult < COST_MULT_MIN || mult > COST_MULT_MAX)
        return `Erro: mult precisa ser um número entre ${COST_MULT_MIN} e ${COST_MULT_MAX} (1 = padrão).`;
      const why = args.reason ? ` (${args.reason})` : "";
      const fmt = (n: number) => String(n).replace(".", ",");
      if (args.ability) {
        const ability = findAbility(c.sheet, String(args.ability));
        if (!ability) return `Erro: ${c.name} não tem "${args.ability}" na ficha.`;
        const before = costMultOf(ability.costMult);
        ability.costMult = mult === 1 ? undefined : mult;
        await saveSheet(c.id, c.sheet);
        ctx.emit({ type: "state" });
        ctx.emit({ type: "tool", name, summary: `${c.name}: custo de ${ability.name} ×${fmt(mult)}${why}` });
        const cost = effectiveCost(rs, ability, { sheet: c.sheet });
        return `Custo de ${ability.name} para ${c.name}: ×${fmt(before)} → ×${fmt(mult)}.${cost ? ` Agora: ${costBreakdown(rs, ability, cost)} ${cost.resource}.` : ""}`;
      }
      const before = costMultOf(c.sheet.costMult);
      c.sheet.costMult = mult === 1 ? undefined : mult;
      await saveSheet(c.id, c.sheet);
      ctx.emit({ type: "state" });
      ctx.emit({ type: "tool", name, summary: `${c.name}: ${controlLabel(rs).toLowerCase()} ×${fmt(mult)}${why}` });
      return `${controlLabel(rs)} de ${c.name}: ×${fmt(before)} → ×${fmt(mult)} (vale para todas as técnicas dele).`;
    }
    case "train": {
      const rs = ctx.campaign.ruleset;
      const c = await getChar(cid, String(args.character));
      const before = getClock(ctx.campaign.state)?.minutes;
      if (before === undefined) return "O relógio ainda não foi definido: chame set_time primeiro.";
      // treino simultâneo: outros alvos nas mesmas horas, se o mundo permite
      const par = trainingRules(rs).parallel;
      const others = (Array.isArray(args.parallel) ? args.parallel : []).map((x) => String(x).trim()).filter(Boolean);
      if (others.length && !par) return "Este mundo não tem treino simultâneo: treine um alvo por vez (cada um avança o relógio).";
      if (par?.max && others.length > par.max) return `Treino simultâneo (${par.label}): no máximo ${par.max} alvos além do principal.`;
      const all = [String(args.target || ""), ...others];
      if (new Set(all.map((x) => x.toLowerCase())).size < all.length) return "Cada alvo do treino simultâneo precisa ser diferente.";
      // tudo ou nada: confere todos os alvos numa cópia antes de mexer na ficha
      const day = clockParts(before).day;
      const dry = structuredClone(c.sheet);
      for (const [i, t] of all.entries()) {
        const res = train(rs, dry, t, Number(args.hours), day, i > 0);
        if ("error" in res) return others.length ? `${t}: ${res.error}` : res.error;
      }
      const r = train(rs, c.sheet, all[0], Number(args.hours), day);
      if ("error" in r) return r.error;
      const extra = others.map((t) => train(rs, c.sheet, t, Number(args.hours), day, true)).filter((x): x is Exclude<TrainResult, { error: string }> => !("error" in x));
      for (const t of all) {
        const trained = findAbility(c.sheet, t);
        if (trained) markGained(ctx, c, trained);
      }
      const minutes = before + r.hours * 60;
      ctx.campaign.state = { ...ctx.campaign.state, clock: { minutes } };
      ctx.emit({ type: "time", minutes });
      ctx.emit({ type: "tool", name, summary: `🕐 ${formatClock(minutes)} (+${formatDuration(r.hours * 60)}) — treino` });
      const lost = await saveClock(cid, minutes, ctx.emit);
      await saveSheet(c.id, c.sheet);
      ctx.emit({ type: "state" });
      type Done = Exclude<TrainResult, { error: string }>;
      const gainOf = (x: Done) =>
        x.kind === "ability"
          ? `${x.label} ${x.before}% → ${x.after}%${x.milestone ? ` — novo marco: ${x.milestone.description}` : ""}`
          : x.after > x.before
            ? `${x.label} ${x.before} → ${x.after}`
            : `${x.label}: ${x.atCap ? "no teto" : `${x.banked}/${x.need} h para +1`}`;
      const detail = (x: Done) => {
        if (x.kind === "ability")
          return ` Domínio de ${x.label}: ${x.before}% → ${x.after}%.${x.capped ? " Rendimento cortado: chegou ao máximo de domínio por dia nesta habilidade." : ""}${
            x.milestone ? ` NOVO MARCO ALCANÇADO: ${x.milestone.description} — narre esse avanço.` : ""
          }`;
        return (
          (x.after > x.before ? ` ${x.label} subiu de ${x.before} para ${x.after}!` : ` ${x.label} continua ${x.after}.`) +
          (x.atCap ? ` Chegou ao teto do nível de poder: as horas não acumulam mais até o próximo nível.` : ` Horas acumuladas: ${x.banked}/${x.need} para o próximo +1.`)
        );
      };
      const how = extra.length ? ` (simultâneo: ${par!.label})` : "";
      ctx.emit({ type: "tool", name, summary: `🏋️ ${c.name} treinou ${r.hours} h${how}: ${[r, ...extra].map(gainOf).join("; ")}` });
      const msg = `Treino de ${r.hours} h${how}. Relógio: ${formatClock(minutes)} (${period(minutes)}). Hoje: ${r.hoursToday} h de treino.${[r, ...extra].map(detail).join("")}`;
      return msg + lost;
    }
    case "add_item": {
      const c = await getChar(cid, String(args.character));
      const qty = Number(args.qty ?? 1);
      const existing = c.sheet.inventory.find(
        (i) => i.name.toLowerCase() === String(args.name).toLowerCase()
      );
      const lib = existing ? null : await findLibrary(ctx.campaign, "item", String(args.name));
      if (existing) existing.qty += qty;
      else
        c.sheet.inventory.push({
          name: lib?.name ?? String(args.name),
          qty,
          description: args.description ? String(args.description) : lib ? itemText(lib.data as LibraryItem) : undefined,
        });
      await saveSheet(c.id, c.sheet);
      ctx.emit({ type: "state" });
      ctx.emit({ type: "tool", name, summary: `${c.name} +${qty}x ${lib?.name ?? args.name}` });
      return lib ? `Item adicionado (da biblioteca): ${itemText(lib.data as LibraryItem)}` : `Item adicionado.`;
    }
    case "search_library": {
      const kind = args.kind === "item" ? "item" : "ability";
      const query = args.query ? String(args.query).trim() : "";
      const list = await listLibrary(ctx.campaign, kind, { query, limit: query ? 15 : 300 });
      if (!list.length) return query ? `Nada na biblioteca com "${query}".` : "A biblioteca ainda não tem nada desse tipo.";
      if (!query) return `${list.length} na biblioteca: ${list.map((e) => e.name).join(", ")}`;
      return list.map((e) => `- ${libraryLine(ctx.campaign.ruleset, e)}`).join("\n");
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
      const c = await getChar(cid, String(args.character));
      const amount = Math.round(Number(args.amount));
      if (!Number.isFinite(amount)) return "amount precisa ser um número.";
      // o Escrivão repetia a XP da missão que acabou de concluir (a conclusão com tamanho já deu)
      const given = ctx.scribe ? ctx.missionXp?.filter((m) => m.charId === c.id) : undefined;
      if (given?.length)
        return `Nada mudou: ${given.map((m) => `a missão ${m.title} já deu ${m.xp} XP`).join("; ")} neste turno.`;
      return grantXp(ctx, c, amount, args.reason ? String(args.reason) : undefined);
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
        limit: (await getAdvanced()).memory.toolTopK,
      });
      if (!hits.length) return "Nenhuma memória encontrada.";
      return hits
        .map((h) => `[${h.kind}${h.subject ? `/${h.subject}` : ""} imp=${h.importance}] ${h.content}`)
        .join("\n");
    }
    case "search_history": {
      const { history } = await getAdvanced();
      const hits = await searchHistory(cid, String(args.query), { npc: args.npc ? String(args.npc) : undefined, limit: history.toolTopK });
      return hits.length ? formatHistory(hits, String(args.query), history.excerptChars) : "Nada encontrado no histórico.";
    }
    case "create_npc": {
      // registro na hora (pelo Mestre antes de narrar ou pelo Escrivão depois); perfil e ficha vêm do Criador em segundo plano
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
        [cid, String(args.name), !!args.canon, JSON.stringify(dehydrateSheet(sheet)), JSON.stringify(persona)]
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
      if (args.mode) ctx.modeSet = true;
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
      // xpSize/xp: undefined = não mexe; xp só vale com excepcional
      const size = args.xpSize === undefined ? undefined : (String(args.xpSize) as ObjectiveXpSize);
      if (size !== undefined && !OBJECTIVE_XP_SIZES.includes(size)) return `xpSize: use ${OBJECTIVE_XP_SIZES.join(", ")}.`;
      const xpArg = args.xp === undefined ? undefined : Math.round(Number(args.xp));
      if (xpArg !== undefined && !(xpArg > 0)) return "xp precisa ser um número positivo (só com xpSize excepcional).";
      const setSize = (o: Objective): string | null => {
        if (size !== undefined) o.xpSize = size;
        if (xpArg !== undefined) o.xp = xpArg;
        if (o.xpSize !== "excepcional") delete o.xp;
        else if (!o.xp) return "xpSize excepcional precisa de xp (número positivo, proporcional ao feito).";
        return null;
      };
      const isLive = (x: Objective) => x.status === "aberto" || x.status === "oferecida";
      let o: Objective;
      let chip: string;
      if (name === "add_objective") {
        const title = String(args.title || "").trim();
        if (!title) return "Informe o title.";
        const same = list.find((x) => isLive(x) && titleKey(x.title) === titleKey(title));
        if (same) return `Nada mudou: já existe [${same.id}] "${same.title}" ${same.status === "oferecida" ? "oferecida" : "em aberto"}. Para mudar prazo, descrição ou status, use update_objective nele.`;
        // o Escrivão recriava a missão que acabou de ser encerrada (por engano) em vez de deixar o Mestre corrigir
        const closed =
          ctx.scribe && now !== undefined && list.find((x) => !isLive(x) && titleKey(x.title) === titleKey(title) && (x.closedAt ?? -Infinity) >= now - 1440);
        if (closed)
          return `Nada mudou: [${closed.id}] "${closed.title}" foi encerrada há pouco (${closed.status}). Se o registro está errado, quem corrige é o Mestre (fix_objective); não crie outra igual.`;
        const kind = (["missao", "evento", "outro"].includes(String(args.kind)) ? args.kind : "outro") as ObjectiveKind;
        o = {
          id: `o${list.reduce((m, x) => Math.max(m, Number(x.id.slice(1)) || 0), 0) + 1}`,
          title,
          kind,
          description: String(args.description || ""),
          deadlineMinutes: deadline,
          status: args.status === "oferecida" ? "oferecida" : "aberto",
          reward: args.reward ? String(args.reward) : undefined,
          giver: args.giver ? String(args.giver) : undefined,
          createdAt: now ?? 0,
        };
        const bad = setSize(o);
        if (bad) return bad;
        list.push(o);
        chip = `📜 ${o.status === "oferecida" ? "Oferecida" : OBJECTIVE_KIND_LABEL[kind]}: ${title} (${deadlineText(deadline, now)})`;
      } else {
        const key = String(args.objective || "").trim().toLowerCase();
        const found =
          list.find((x) => x.id.toLowerCase() === key) ||
          list.find((x) => isLive(x) && x.title.toLowerCase() === key) ||
          list.find((x) => x.title.toLowerCase() === key);
        if (!found) return `Objetivo "${args.objective}" não existe. Abertos e oferecidos: ${list.filter(isLive).map((x) => `${x.id} ${x.title}`).join(", ") || "nenhum"}.`;
        // perdido agora mesmo (o relógio do mesmo turno passou do prazo antes do Escrivão): a narração deste momento
        // pode mostrar que foi cumprido; quando o relógio anda de novo, a perda vira definitiva
        const lostNow = found.status === "perdido" && args.status === "concluido" && now !== undefined && found.closedAt === now;
        if (!isLive(found) && !lostNow) return `"${found.title}" já está ${found.status}; não volta a ficar aberto.`;
        // o Escrivão tirava o prazo sem a narração pedir; só com uma anotação de missão do Mestre neste turno
        if (args.noDeadline === true && found.deadlineMinutes !== undefined && ctx.scribe && !ctx.scribe.briefs)
          return `Nada mudou: [${found.id}] mantém o prazo. Tirar o prazo só com uma ANOTAÇÃO DE MISSÃO do Mestre neste turno.`;
        // o Escrivão cancelava missões aceitas quando o jogador "encerrava" uma atividade; recusar oferta continua livre
        if (args.status === "cancelado" && found.status !== "oferecida" && ctx.scribe && !ctx.scribe.briefs)
          return `Nada mudou: [${found.id}] continua aberto. Cancelar missão aceita só com uma ANOTAÇÃO DE MISSÃO do Mestre neste turno; encerrar uma atividade não encerra missão.`;
        o = { ...found };
        const bad = setSize(o);
        if (bad) return bad;
        const changes: string[] = [];
        if (args.description) o.description = String(args.description);
        if (args.noDeadline === true) (o.deadlineMinutes = undefined), changes.push("sem prazo");
        else if (deadline !== undefined) (o.deadlineMinutes = deadline), changes.push(deadlineText(deadline, now));
        if (size !== undefined || xpArg !== undefined) changes.push(`tamanho ${o.xpSize}`);
        const accepted = args.status === "aberto" && found.status === "oferecida";
        // aceitar com o prazo já vencido viraria perdida no próximo relógio (ex.: a oferta era o próprio bloco de treino)
        const due = args.noDeadline === true ? undefined : deadline ?? found.deadlineMinutes; // prazo que vale depois desta chamada
        if (accepted && due !== undefined && now !== undefined && due < now)
          return `Nada mudou: o prazo de [${found.id}] já passou (${formatClock(due)}). Se a narração mostrou a missão cumprida, conclua (status concluido); se não vale mais, cancele ou dê um prazo novo.`;
        if (args.status === "concluido" || args.status === "cancelado") {
          o.status = args.status;
          o.closedAt = now ?? 0;
        } else if (accepted) o.status = "aberto";
        chip =
          o.status === "concluido" ? `✅ Concluído: ${o.title}` :
          o.status === "cancelado" ? `✖ ${found.status === "oferecida" ? "Recusada" : "Cancelado"}: ${o.title}` :
          accepted ? `📜 Aceita: ${o.title} (${deadlineText(o.deadlineMinutes, now)})` :
          `📜 ${o.title}: ${changes.join(", ") || "atualizado"}`;
        list[list.indexOf(found)] = o;
      }
      // missão com tamanho concluída: a XP vai para o personagem do jogador pela mesma soma do grant_xp
      const [player] =
        o.status === "concluido" && o.xpSize
          ? await hydrateSheets(await q<Character>(`SELECT * FROM characters WHERE campaign_id = $1 AND kind = 'player' LIMIT 1`, [cid]))
          : [];
      const xp = player ? objectiveXp(o, ctx.campaign.ruleset, getTable(ctx.campaign.state), player.sheet.xp) : null;
      if (xp) chip += ` (+${xp} XP)`;
      await saveObjectives(cid, list);
      ctx.campaign.state = { ...ctx.campaign.state, objectives: list };
      ctx.emit({ type: "tool", name, summary: chip });
      ctx.emit({ type: "state" });
      const done = `${o.id} "${o.title}": ${o.status}, ${deadlineText(o.deadlineMinutes, now)}.`;
      if (!player || !xp) return done;
      if (ctx.scribe) (ctx.missionXp ??= []).push({ charId: player.id, title: o.title, xp }); // a trava é só do Escrivão
      return `${done} A missão deu ${xp} XP: ${await grantXp(ctx, player, xp, `missão: ${o.title}`)}`;
    }
    case "fix_objective": {
      const now = getClock(ctx.campaign.state)?.minutes;
      const list = await loadObjectives(cid);
      const key = String(args.objective || "").trim().toLowerCase();
      const found =
        list.find((x) => x.id.toLowerCase() === key) || list.find((x) => x.title.toLowerCase() === key) || list.find((x) => titleKey(x.title) === titleKey(key));
      if (!found) return `Objetivo "${args.objective}" não existe. Registros: ${list.map((x) => `${x.id} ${x.title} (${x.status})`).join(", ") || "nenhum"}.`;
      if (!String(args.reason || "").trim()) return "Informe reason: qual era o erro do registro.";
      let chip: string;
      let out: string;
      if (args.remove === true) {
        list.splice(list.indexOf(found), 1);
        chip = `🛠 Registro removido: ${found.title}`;
        out = `${found.id} "${found.title}" removido.`;
      } else {
        const deadline = parseDeadline(args, now);
        if (typeof deadline === "string") return deadline;
        const o: Objective = { ...found };
        if (args.description) o.description = String(args.description);
        if (args.noDeadline === true) o.deadlineMinutes = undefined;
        else if (deadline !== undefined) o.deadlineMinutes = deadline;
        const st = String(args.status || "");
        if (["oferecida", "aberto", "concluido", "cancelado", "perdido"].includes(st)) {
          o.status = st as Objective["status"];
          if (st === "aberto" || st === "oferecida") delete o.closedAt;
          else o.closedAt = now ?? 0;
        }
        list[list.indexOf(found)] = o;
        const late = o.status === "aberto" && o.deadlineMinutes !== undefined && now !== undefined && o.deadlineMinutes < now;
        chip = `🛠 Missão corrigida: ${o.title} → ${o.status}`;
        out = `${o.id} "${o.title}" corrigido: ${o.status}, ${deadlineText(o.deadlineMinutes, now)}.${late ? " O prazo já passou: no próximo avanço do relógio vira perdido; mude o prazo se ainda vale." : ""}`;
      }
      await saveObjectives(cid, list);
      ctx.campaign.state = { ...ctx.campaign.state, objectives: list };
      ctx.emit({ type: "tool", name, summary: chip });
      ctx.emit({ type: "state" });
      return out;
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
      const hits = await searchBookChunks(cid, String(args.query), (await getAdvanced()).books.topK);
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
      const max = (await getAdvanced()).books.maxPages; // o corte do intervalo (readPages)
      const cut = to >= from + max && pages[pages.length - 1].page === from + max - 1;
      const rest = cut ? `\n\n(limite de ${max} páginas por chamada: continue com read_pages from=${from + max})` : "";
      return pages.map((p) => `=== Página ${p.page} ===\n${p.content}`).join("\n\n") + rest;
    }
    case "list_books": {
      const books = await listBooks(cid);
      if (!books.length) return "Nenhum livro indexado nesta campanha.";
      return books.map((b) => `${b.title} — bookId=${b.id}, ${b.pages} páginas`).join("\n");
    }
    case "update_map":
    case "set_stage":
      return executeMapTool(name, args, ctx);
    case "local_map":
      return executeLocalMapTool(args, ctx);
    case "map_brief":
      return executeMapBrief(args, ctx);
    default:
      return `Ferramenta desconhecida: ${name}`;
  }
}
