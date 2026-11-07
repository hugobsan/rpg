// ---------- Ruleset (mecânica de RPG, agnóstica de cenário) ----------

export interface AttributeDef {
  key: string;
  label: string;
  min: number;
  max: number;
  default: number;
  description?: string;
}

export interface ResourceDef {
  key: string; // ex: hp, chakra
  label: string;
  defaultMax: number;
  color: string; // cor da barra na UI
  description?: string;
}

export interface AbilityTypeDef {
  key: string; // ex: ninjutsu
  label: string;
  description?: string;
}

export interface RankDef {
  key: string;
  label: string;
  xpRequired: number; // xp acumulado para alcançar
}

/** Nível de poder: vem só da XP e sobe sozinho. Não é cargo (rank), que é posição na história. */
export interface PowerLevelDef {
  key: string;
  label: string;
  xpRequired: number;
  /** teto dos atributos neste nível (sem ele, vale o max do atributo) */
  attributeCap?: number;
}

/** Faixa por domínio (0-100): vale a de maior min <= domínio. */
export interface MasteryBand {
  min: number;
  value: number;
}

export interface TrainingRules {
  /** horas de treino por dia do jogo, somando todos os alvos */
  maxHoursPerDay: number;
  /** domínio ganho por hora de treino, por faixa de domínio */
  masteryPerHour: MasteryBand[];
  /** domínio ganho por uso real (use_ability), por faixa de domínio */
  masteryPerUse: MasteryBand[];
  /** teto de domínio ganho por habilidade por dia (treino + uso) */
  maxMasteryPerDay: number;
  /** horas para +1 num atributo = isto x valor atual */
  hoursPerAttributePoint: number;
  /**
   * treino simultâneo (opcional; sem ele o mundo não tem): outros alvos treinados nas mesmas horas, sem o relógio andar
   * de novo. label = como o mundo faz (Naruto: clones das sombras); note = regra para o Mestre (custo, limites)
   */
  parallel?: { label: string; note?: string; max?: number };
}

/** Faixa de consumo do mundo (Ruleset.abilityCosts.byConsumption): key gravada na técnica, nome exibido e custo base */
export interface ConsumptionDef {
  key: string;
  label: string;
  cost: number;
  description?: string;
}

export interface Ruleset {
  name: string;
  description: string;
  /** Slug do tipo de campanha (ex.: "naruto"): escopo da biblioteca. Ler sempre por worldOf (library.ts) */
  world?: string;
  /** Padrão de nomes das habilidades, para o Criador e o Mestre (ex.: romanização oficial + translation) */
  abilityNaming?: string;
  /** Tema visual (chave de THEMES em theme.ts). Sem ele, o tema é inferido pelo nome */
  theme?: string;
  /** Instruções de tom/lore/cânone injetadas no prompt do Mestre */
  loreNotes: string;
  /** Sugestão de ponto de partida (o Criador de aventuras preenche; o assistente usa se o campo estiver vazio) */
  startingPoint?: string;
  /** true = há uma obra/cânone a respeitar (o Roteirista monta linha do tempo canônica) */
  canonBased: boolean;
  attributes: AttributeDef[];
  resources: ResourceDef[];
  abilityTypes: AbilityTypeDef[];
  /** Elementos das habilidades (Naruto: naturezas do chakra), opcional; filtro e campo element da biblioteca */
  abilityElements?: AbilityTypeDef[];
  /** Níveis de maestria de habilidades (ex: D, C, B, A, S) */
  abilityRanks: string[];
  /** Cargos (posição na história); só mudam por set_rank */
  ranks: RankDef[];
  /** Níveis de poder pela XP, com teto de atributo. Sem eles, os ranks servem de fallback (sem teto) */
  powerLevels?: PowerLevelDef[];
  /** Bônus no teste por faixa de domínio da habilidade */
  masteryBonus?: MasteryBand[];
  /** Multiplicador do custo por faixa de domínio */
  masteryCost?: MasteryBand[];
  /** 1 ponto livre de atributo a cada N XP acumulados */
  xpPerAttributePoint?: number;
  /** Teste de habilidade: 1d20 + atributo x isto + bônus do domínio (Naruto: 2) */
  attributeMultiplier?: number;
  /** Atributo padrão do teste por tipo de habilidade (sem ele, o atributo de mesma key) */
  abilityAttributes?: Record<string, string>;
  training?: TrainingRules;
  /** Pontos para distribuir entre atributos na criação */
  creationPoints: number;
  /** Campos extras livres da ficha (ex: elemento, kekkei genkai) */
  extraFields: { key: string; label: string; description?: string }[];
  /** Dinheiro do mundo (uma ou várias moedas); sem ele, o mundo não tem dinheiro na ficha */
  currency?: Currency;
  diceNotes?: string; // convenções de rolagem para o Mestre
  /** Orientação sobre progresso/milestones por habilidade (ex: estágios de um dōjutsu) */
  progressionNotes?: string;
  /** Nome da aba/seção de habilidades na UI (ex: "Jutsus"). Padrão: "Habilidades" */
  abilitiesLabel?: string;
  /**
   * Custo das habilidades no recurso `resource`. Com byConsumption (faixas de consumo do mundo, na ordem da mais
   * barata para a mais cara), a técnica com `consumption` custa o da faixa; sem faixa, vale byRank[rank]; costFree = 0
   */
  abilityCosts?: { resource: string; byRank: Record<string, number>; byConsumption?: ConsumptionDef[] };
  /** Rótulo do multiplicador de custo do personagem (Sheet.costMult; Naruto: "Controle de chakra"). Sem ele: "Eficiência" */
  costControlLabel?: string;
  /** Kit que todo personagem sabe ao atingir cada rank (key de RankDef). Cumulativo: um rank inclui os anteriores */
  startingAbilities?: Record<string, Ability[]>;
}

// ---------- Ficha de personagem ----------

export interface AbilityMilestone {
  /** 0-100: progresso de domínio a partir do qual este marco vale */
  threshold: number;
  /** o que se torna possível a partir deste ponto de domínio */
  description: string;
}

/**
 * Habilidade em memória: a entrada da biblioteca hidratada (hydrateSheet em library.ts) + o que é do personagem.
 * Sem ref = formato antigo (cópia na ficha), mantido como está até a migração. Não há custo próprio: vem do
 * rank (abilityCost); um `cost` que ainda venha no formato antigo é ignorado.
 */
export interface Ability extends LibraryAbility {
  /** library.id */
  ref?: number;
  /** 0-100: domínio/aprendizado desta habilidade especificamente (não do personagem) */
  progress?: number;
  /** multiplicador de custo desta técnica para este personagem (ex.: técnica de linhagem usada por implante ×1,5); padrão 1 */
  costMult?: number;
  /** a entrada foi excluída da biblioteca (soft delete); quem já tinha continua tendo */
  removed?: true;
}

/** Habilidade como fica gravada em characters.sheet.abilities (e nos turn_snapshots). */
export interface StoredAbility {
  ref: number;
  progress?: number;
  costMult?: number;
}

export interface Item {
  name: string;
  qty: number;
  description?: string;
}

/** Moedas do mundo. value = quanto a moeda vale na menor (value 1): Ryō 1; Galeão 493, Sicle 29, Nuque 1. */
export interface Currency {
  units: { key: string; label: string; plural?: string; value: number }[];
  /** saldo inicial do personagem do jogador, na menor moeda */
  start?: number;
  /** preços de referência em texto livre (missões, comida, equipamento), para o Mestre manter os valores coerentes */
  prices?: string;
}

export interface Sheet {
  attributes: Record<string, number>;
  resources: Record<string, { current: number; max: number }>;
  abilities: Ability[];
  inventory: Item[];
  rank?: string;
  xp: number;
  extra: Record<string, string>;
  /** pontos livres de atributo já gastos (os ganhos vêm da XP) */
  attrPointsSpent?: number;
  /** horas de treino acumuladas por atributo, rumo ao próximo +1 */
  trainingHours?: Record<string, number>;
  /** treino e ganho de domínio do dia do jogo atual (zera quando o dia muda) */
  trainingLog?: { day: number; hours: number; mastery: Record<string, number> };
  /** multiplicador geral de custo das habilidades (Ruleset.costControlLabel; ex.: 0,75 controle excelente, 1,25 ruim); padrão 1 */
  costMult?: number;
  /** dinheiro, na menor moeda do mundo (Ruleset.currency) */
  money?: number;
}

/** Ficha como fica gravada (dehydrateSheet): habilidades só com ref; sem ref só no formato antigo. */
export type StoredSheet = Omit<Sheet, "abilities"> & { abilities: (StoredAbility | Ability)[] };

export interface Persona {
  appearance?: string;
  personality?: string;
  backstory?: string;
  goals?: string;
  secrets?: string; // só o Mestre vê
  // perfil rico (Criador de personagens)
  age?: string; // idade ou aparente: "12 anos", "uns 40"
  role?: string; // papel e afiliação em poucas palavras
  speech?: string; // jeito de falar: tom, vocabulário, bordões
  relationships?: string;
  quirks?: string; // manias, hábitos, gestos
  // situação atual na história (cargo, time, o que já viveu), escrita pelo Cronista antigo (legado): vale mais que o
  // passado, que fica como a origem. Sem ela, NPC canônico ficava preso ao ponto da obra em que foi criado
  current?: string;
  // sexo: define a voz padrão. undefined = ainda não decidido (o Jev decide na 1ª fala); null = desconhecido
  gender?: "male" | "female" | null;
  // ajuste de reprodução da voz (só no navegador, nunca vai para a API do TTS). undefined = padrão (1x, 0 st)
  voiceFx?: VoiceFx;
  // cartão do NPC (Roteirista): o que ele faz por conta própria e o que quer
  agenda?: string;
  wants?: string;
}

/** Efeitos aplicados ao tocar o mp3 do NPC: rate = velocidade (0,5 a 2, mantém o tom); pitch = semitons (-12 a 12, mantém a velocidade). */
export interface VoiceFx {
  rate: number;
  pitch: number;
}

/** Voz escolhida à mão; só vale para o modelo em que foi escolhida. null no personagem = padrão pelo sexo. */
export interface VoiceProfile {
  model: string;
  voice: string;
}

export interface Character {
  id: string;
  campaign_id: string;
  kind: "player" | "npc";
  name: string;
  active: boolean;
  canon: boolean;
  sheet: Sheet;
  persona: Persona;
  voice: VoiceProfile | null;
  // só na tela (campaignView): versão do retrato (vai na URL; null = sem retrato) e se está sendo desenhado
  portrait?: { v: number | null; busy: boolean };
}

// ---------- Campanha / cena ----------

export type CampaignStyle = "open" | "hybrid" | "guided";
export type SceneMode =
  | "exploration"
  | "dialogue"
  | "battle"
  | "training"
  | "downtime";

export interface Campaign {
  id: string;
  name: string;
  style: CampaignStyle;
  ruleset: Ruleset;
  state: Record<string, unknown>;
  // arco ativo (lib/story.ts), lido junto em getCampaign: momento da história para o Ilustrador e o Criador de personagens
  arc?: { title: string; premise: string; stakes: string } | null;
}

export interface Scene {
  id: string;
  campaign_id: string;
  seq: number;
  mode: SceneMode;
  title: string;
  location: string;
  summary: string;
  state: Record<string, unknown>;
  is_current: boolean;
}

export interface GameMessage {
  id: number;
  role: "player" | "gm" | "system" | "tool";
  speaker: string | null;
  content: string;
  meta: { choices?: string[]; dice?: DiceResult[]; kind?: string };
  created_at: string;
}

export interface DiceResult {
  notation: string;
  rolls: number[];
  modifier: number;
  total: number;
  reason?: string;
  dc?: number; // dificuldade do teste; sem ela (ex: disputa direta) não há passou/falhou
  success?: boolean; // total >= dc (ou o crítico)
  baseDc?: number; // CD pedida pelo Mestre, antes das regras da mesa (só quando houve ajuste; dc = efetiva)
  dcAdjust?: { label: string; value: number }[]; // ajustes da mesa, ex: [{ "Difícil", 2 }, { "Combate", 3 }]
  crit?: "success" | "failure"; // 20 natural passa / 1 natural falha (regras da mesa com crits)
  sure?: boolean; // o desfecho não dependia do dado (mínimo já passa ou máximo não alcança): sem animação
}

// ---------- Regras da mesa (campaign.state.table; helpers em lib/table.ts) ----------

export type Difficulty = "story" | "easy" | "normal" | "hard" | "brutal";

/** Ausente = normal, sem ajustes e sem críticos. */
export interface TableRules {
  difficulty: Difficulty;
  dcOffset: number; // somado a toda CD (-10 a 10); trocar o preset traz o dele
  categories: { key: string; label: string; offset: number }[]; // ajuste da CD por tipo de ação (até 12)
  crits: boolean; // 20 natural passa, 1 natural falha (só 1d20 com CD)
  notes?: string; // orientação livre de dificuldade para o Mestre
  xp?: { min: number; max: number; great: number }; // XP por feito, em % do que falta para o próximo nível (missão concluída aplica)
  modes?: Partial<Record<SceneMode, string>>; // como conduzir cada modo de cena (só os que diferem do padrão; vai no contexto do turno)
  rest?: Partial<Record<RestKind, Record<string, { min: number; max: number }>>>; // quanto cada recurso (key do ruleset) recupera por descanso (o bloco de efeitos aplica)
}
export type RestKind = "light" | "full";

/** Mensagem particular de NPC não lida (sessão aberta pelo NPC com npc_message). */
export interface InboxItem {
  npcId: string;
  sessionId: string;
  unread: number; // mensagens do NPC ainda não lidas na sessão
  preview: string; // começo da última não lida
  at: string; // quando chegou a última não lida
}

// ---------- Tarefas em segundo plano (lib/jobs.ts) ----------

export interface Job {
  id: number;
  kind: string; // character | portrait | library
  target: string | null;
  label: string;
  status: "running" | "done" | "error";
  progress: { done: number; total: number } | null;
  error: string | null;
}

// ---------- Biblioteca do mundo (tabela library) ----------

export type LibraryKind = "ability" | "item";

/** Habilidade da biblioteca: só o que é da técnica (não varia com quem usa nem com a mesa; o custo vem do rank). */
export interface LibraryAbility {
  name: string; // no padrão do mundo (Ruleset.abilityNaming)
  /** tradução para exibição (Naruto: em português); não entra na busca */
  translation?: string;
  type: string; // key de AbilityTypeDef
  /** key de Ruleset.abilityElements (Naruto: natureza do chakra); sem elemento = vazio */
  element?: string;
  rank?: string; // D/C/B/A/S
  /** não gasta recurso (técnicas físicas, armas, ofícios, passivas) */
  costFree?: boolean;
  /** key de Ruleset.abilityCosts.byConsumption: quanto recurso a técnica gasta, independente do rank */
  consumption?: string;
  /** o custo é por unidade (texto livre: "clone", "rodada", "invocação"); use_ability multiplica pelas unidades */
  costUnit?: string;
  description?: string;
  /** o que a habilidade faz em jogo (alcance, duração, teste) */
  effect?: string;
  /** dano em notação de dado, ex: "2d6" */
  damage?: string;
  /** requisitos: selos, elemento, kekkei genkai, outra habilidade */
  requirements?: string;
  /** marcos de capacidade por nível de domínio, ordenados por threshold crescente (o progresso é de cada um) */
  milestones?: AbilityMilestone[];
  users?: string; // quem é conhecido por usar (cânone), ex.: "Clã Uchiha, Kakashi"
  /** registrada sem o Criador (só com o que o Mestre passou): falta completar com edit_ability */
  incomplete?: boolean;
}

/** Item/ferramenta/equipamento da biblioteca. Vai para o inventário como { name, qty, description }. */
export interface LibraryItem {
  name: string;
  category?: string; // arma, ferramenta, consumível, pergaminho, veículo...
  rank?: string;
  description?: string;
  effect?: string;
  damage?: string; // notação de dado
}

export interface LibraryEntry {
  id: number;
  world: string;
  kind: LibraryKind;
  name: string;
  data: LibraryAbility | LibraryItem;
  canon: boolean;
  source: "agent" | "gm";
  /** excluída (soft delete): só aparece na leitura por id (getLibraryByIds) */
  deleted?: boolean;
}

// ---------- Agentes ----------

export interface AgentConfig {
  id: string;
  name: string;
  description: string;
  model: string;
  temperature: number;
  max_tokens: number;
  web_search: boolean;
  system_prompt: string;
  params: Record<string, unknown>;
  // fonte de modelos: "openrouter" ou o id de uma fonte OpenAI-compatível cadastrada em /agents
  source: string;
  // hash do prompt padrão de onde o system_prompt veio (lib/agents.ts)
  prompt_base?: string | null;
  // padrão atual, só quando o prompt foi editado à mão e o padrão mudou depois (para Ver diferença e Restaurar)
  default_prompt?: string;
  // preço do modelo (USD/M tokens) salvo no último Salvar (só no OpenRouter, que tem catálogo com preço)
  pricing?: {
    input: number | null;
    output: number | null;
    cache_read: number | null;
    context: number;
    fetched_at: string;
  } | null;
}

/** Fonte de modelos como sai da API: a chave só mascarada. */
export interface SourceView {
  id: string;
  name: string;
  url: string;
  kind?: string; // tipo conhecido (src/lib/sourcePresets.ts); sem = personalizada
  auth?: "chatgpt"; // fonte OpenAI no Login com ChatGPT (sem = API key)
  apiKeyMasked: string;
}

/** Login com ChatGPT para a tela (src/lib/chatgptAuth.ts): nunca tem token. */
export interface ChatgptStatus {
  connected: boolean;
  email: string | null;
  expiresAt: string | null; // access token (1 h, renovado sozinho)
  sessionUntil: string | null; // refresh token: 30 dias desde a última renovação
}

// ---------- Eventos SSE do turno ----------

export type TurnEvent =
  | { type: "status"; text: string }
  // scribe: efeito aplicado que dá para desfazer (narração e posição em meta.scribe)
  | { type: "tool"; name: string; summary: string; scribe?: { messageId: number; index: number } }
  | { type: "dice"; result: DiceResult }
  | { type: "narration"; content: string; messageId?: number }
  // narração em streaming: pedaços do texto enquanto o Mestre escreve. O "narration" final traz o texto inteiro
  | { type: "narration_delta"; text: string }
  | { type: "choices"; choices: string[] }
  // opções tipadas (contracts.EffectOption); a tela usa os rótulos de "choices" e manda o índice de volta (optionIndex)
  | { type: "options"; options: { label: string; approach: string; steps: { ability?: string; item?: string; target?: string }[] }[] }
  | { type: "scene"; scene: Partial<Scene> }
  | { type: "state" } // fichas mudaram; cliente deve recarregar
  | { type: "time"; minutes: number } // relógio da história mudou (minutos desde o Dia 1, 00:00)
  | { type: "npc_message"; npcId: string; name: string; preview: string } // NPC chamou o jogador em particular
  | { type: "ooc" } // a ação era fala fora do jogo sobre o registro: foi respondida na conversa fora do jogo (gm_notes), sem turno
  // a ação era fala só com um NPC em cena: virou a 1ª mensagem da conversa particular com ele (npc_chats), sem turno
  | { type: "npc_talk"; npcId: string; sessionId: string; messages: { role: "player" | "npc"; content: string }[] }
  | { type: "done" }
  | { type: "error"; message: string };
