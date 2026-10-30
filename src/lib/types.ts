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

export interface Ruleset {
  name: string;
  description: string;
  /** Instruções de tom/lore/cânone injetadas no prompt do Mestre */
  loreNotes: string;
  /** true = há uma obra/cânone a respeitar (o Roteirista monta linha do tempo canônica) */
  canonBased: boolean;
  attributes: AttributeDef[];
  resources: ResourceDef[];
  abilityTypes: AbilityTypeDef[];
  /** Níveis de maestria de habilidades (ex: D, C, B, A, S) */
  abilityRanks: string[];
  ranks: RankDef[];
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
}

export interface Persona {
  appearance?: string;
  personality?: string;
  backstory?: string;
  goals?: string;
  secrets?: string; // só o Mestre vê
  // sexo: define a voz padrão. undefined = ainda não decidido (o Jev decide na 1ª fala); null = desconhecido
  gender?: "male" | "female" | null;
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
  | { type: "choices"; choices: string[] }
  | { type: "scene"; scene: Partial<Scene> }
  | { type: "state" } // fichas mudaram; cliente deve recarregar
  | { type: "done" }
  | { type: "error"; message: string };
