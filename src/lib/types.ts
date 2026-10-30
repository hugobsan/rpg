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
}

export interface Ruleset {
  name: string;
  description: string;
  /** Tema visual (chave de THEMES em theme.ts). Sem ele, o tema é inferido pelo nome */
  theme?: string;
  /** Instruções de tom/lore/cânone injetadas no prompt do Mestre */
  loreNotes: string;
  /** true = há uma obra/cânone a respeitar (o Roteirista monta linha do tempo canônica) */
  canonBased: boolean;
  attributes: AttributeDef[];
  resources: ResourceDef[];
  abilityTypes: AbilityTypeDef[];
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
  diceNotes?: string; // convenções de rolagem para o Mestre
  /** Orientação sobre progresso/milestones por habilidade (ex: estágios de um dōjutsu) */
  progressionNotes?: string;
  /** Nome da aba/seção de habilidades na UI (ex: "Jutsus"). Padrão: "Habilidades" */
  abilitiesLabel?: string;
  /** Custo padrão por rank de habilidade, usado quando a habilidade não tem custo próprio */
  abilityCosts?: { resource: string; byRank: Record<string, number> };
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

export interface Ability {
  name: string;
  type: string; // key de AbilityTypeDef
  rank?: string; // opcional: nível amplo (D/C/B/A/S) para habilidades simples
  description?: string;
  /** 0-100: domínio/aprendizado desta habilidade especificamente (não do personagem) */
  progress?: number;
  /** marcos de capacidade por nível de domínio, ordenados por threshold crescente */
  milestones?: AbilityMilestone[];
  /** custo por uso; sem ele, vale o padrão do rank (Ruleset.abilityCosts). amount 0 = sem custo */
  cost?: { resource: string; amount: number };
  /** o que a habilidade faz em jogo (alcance, duração, teste) */
  effect?: string;
  /** dano em notação de dado, ex: "2d6" */
  damage?: string;
  /** requisitos: selos, elemento, kekkei genkai, outra habilidade */
  requirements?: string;
}

export interface Item {
  name: string;
  qty: number;
  description?: string;
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
}

export interface Persona {
  appearance?: string;
  personality?: string;
  backstory?: string;
  goals?: string;
  secrets?: string; // só o Mestre vê
  // sexo: define a voz padrão. undefined = ainda não decidido (o Jev decide na 1ª fala); null = desconhecido
  gender?: "male" | "female" | null;
  // ajuste de reprodução da voz (só no navegador, nunca vai para a API do TTS). undefined = padrão (1x, 0 st)
  voiceFx?: VoiceFx;
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
}

// ---------- Campanha / cena ----------

export type CampaignStyle = "open" | "hybrid" | "guided";
export type SceneMode =
  | "exploration"
  | "dialogue"
  | "battle"
  | "training"
  | "downtime";

export interface CampaignScript {
  premise: string;
  arcs: {
    title: string;
    summary: string;
    canonEvents: string[];
    hooks: string[];
    status: "pending" | "active" | "done";
    notes: string[];
  }[];
}

export interface Campaign {
  id: string;
  name: string;
  style: CampaignStyle;
  ruleset: Ruleset;
  script: CampaignScript | null;
  state: Record<string, unknown>;
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

// ---------- Mapa do mundo (campaigns.state.map) e palco da cena (scenes.state.stage) ----------

/** Um local do mapa. x/y em unidades do mapa (x = leste, y = norte), calculados pelo código (map.ts). */
export interface MapPlace {
  id: string; // "l1", "l2"...
  name: string;
  aliases?: string[];
  /** cidade, vila, bairro, predio, casa, sala, torre, templo, floresta, campo, montanha, agua, caverna, ruina, estrada, base, nave, portal, regiao, lugar — ou texto livre */
  kind: string;
  parent?: string; // id do local que contém este
  description?: string;
  x?: number;
  y?: number;
  /** dica de posição do Mestre: para que lado (N, NE, L...) e a que distância de outro local */
  near?: { of: string; dir?: string; dist?: string };
  discoveredAt?: number; // minutos do relógio do jogo
  visits: number;
}

export interface MapRoute {
  from: string;
  to: string;
  label?: string;
  travel?: string; // tempo de viagem, ex.: "20 min a pé"
}

export interface WorldMap {
  places: MapPlace[];
  routes: MapRoute[];
  current?: string; // id do local atual
}

export type StageDistance = "corpo_a_corpo" | "perto" | "medio" | "longe";
export type StageStance = "aliado" | "hostil" | "neutro";

/** Personagem no palco; a distância é sempre até o jogador. */
export interface StageActor {
  name: string;
  zone?: string;
  distance: StageDistance;
  stance: StageStance;
  cover?: "parcial" | "total";
  elevated?: boolean;
  note?: string;
}

export interface SceneStage {
  zones: { name: string; note?: string }[];
  actors: StageActor[];
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
  success?: boolean; // total >= dc
}

/** Mensagem particular de NPC não lida (sessão aberta pelo NPC com npc_message). */
export interface InboxItem {
  npcId: string;
  sessionId: string;
  unread: number; // mensagens do NPC ainda não lidas na sessão
  preview: string; // começo da última não lida
  at: string; // quando chegou a última não lida
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
  // preço do modelo (USD/M tokens) salvo no último Salvar
  pricing?: {
    input: number | null;
    output: number | null;
    cache_read: number | null;
    context: number;
    fetched_at: string;
  } | null;
}

// ---------- Eventos SSE do turno ----------

export type TurnEvent =
  | { type: "status"; text: string }
  | { type: "tool"; name: string; summary: string }
  | { type: "dice"; result: DiceResult }
  | { type: "narration"; content: string; messageId?: number }
  // narração em streaming: pedaços do texto enquanto o Mestre escreve; reset = descarte o rascunho
  // (a rodada virou chamada de ferramenta ou vai ser reescrita). O "narration" final traz o texto inteiro
  | { type: "narration_delta"; text: string }
  | { type: "narration_reset" }
  | { type: "choices"; choices: string[] }
  | { type: "scene"; scene: Partial<Scene> }
  | { type: "state" } // fichas mudaram; cliente deve recarregar
  | { type: "time"; minutes: number } // relógio da história mudou (minutos desde o Dia 1, 00:00)
  | { type: "npc_message"; npcId: string; name: string; preview: string } // NPC chamou o jogador em particular
  | { type: "done" }
  | { type: "error"; message: string };
