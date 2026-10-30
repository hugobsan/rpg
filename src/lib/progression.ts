/**
 * Progressão: domínio dos jutsus (bônus e custo), nível de poder pela XP (teto de
 * atributo e pontos livres) e treino. Funções puras sobre ruleset + ficha; as
 * ferramentas (tools.ts) e a rota de atributos gravam e emitem os eventos.
 */
import { Ability, AbilityMilestone, MasteryBand, PowerLevelDef, Ruleset, Sheet, TrainingRules } from "./types";
import { abilityCost, currentMilestone } from "./ruleset";

/** Domínio de habilidade sem `progress` (fichas antigas, NPCs): neutro, sem bônus de custo. */
export const LEGACY_MASTERY = 50;
/** Kit do rank: treinado na Academia/na vida. */
export const KIT_MASTERY = 60;
/** Registrada na hora do uso, sem o Mestre informar o domínio. */
export const NEW_ABILITY_MASTERY = 15;
/** Extras da criação de personagem sem domínio informado. */
export const EXTRA_MASTERY = 30;

export const DEFAULT_MASTERY_BONUS: MasteryBand[] = [
  { min: 0, value: 0 },
  { min: 25, value: 1 },
  { min: 50, value: 2 },
  { min: 75, value: 3 },
  { min: 100, value: 4 },
];
export const DEFAULT_MASTERY_COST: MasteryBand[] = [
  { min: 0, value: 1.5 },
  { min: 25, value: 1 },
  { min: 100, value: 0.75 },
];
export const DEFAULT_TRAINING: TrainingRules = {
  maxHoursPerDay: 10,
  masteryPerHour: [
    { min: 0, value: 3 },
    { min: 50, value: 2 },
    { min: 75, value: 1 },
  ],
  masteryPerUse: [
    { min: 0, value: 5 },
    { min: 25, value: 4 },
    { min: 50, value: 3 },
    { min: 75, value: 2 },
  ],
  maxMasteryPerDay: 25,
  hoursPerAttributePoint: 20,
};
export const DEFAULT_XP_PER_POINT = 50;

export function band(bands: MasteryBand[], p: number): number {
  let best: MasteryBand | undefined;
  for (const b of bands) if (p >= b.min && (!best || b.min > best.min)) best = b;
  return best?.value ?? 0;
}

const clamp100 = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
export const mastery = (a: Ability) => clamp100(a.progress ?? LEGACY_MASTERY);
export const masteryBonus = (r: Ruleset, a: Ability) => band(r.masteryBonus ?? DEFAULT_MASTERY_BONUS, mastery(a));
export const trainingRules = (r: Ruleset): TrainingRules => ({ ...DEFAULT_TRAINING, ...r.training });

/** Custo com o ajuste do domínio. Acréscimo arredonda para cima, desconto para baixo. */
export function effectiveCost(r: Ruleset, a: Ability): { resource: string; amount: number; base: number; mult: number } | null {
  const c = abilityCost(r, a);
  if (!c) return null;
  const mult = band(r.masteryCost ?? DEFAULT_MASTERY_COST, mastery(a)) || 1;
  const raw = c.amount * mult;
  const amount = Math.max(0, mult > 1 ? Math.ceil(raw - 1e-9) : Math.floor(raw + 1e-9));
  return { resource: c.resource, amount, base: c.amount, mult };
}

/** "+50% (domínio < 25%)" / "−25% (domínio 100%)" / "" */
export function costAdjustText(mult: number): string {
  if (mult === 1) return "";
  const pct = Math.round((mult - 1) * 100);
  return `${pct > 0 ? "+" : "−"}${Math.abs(pct)}% pelo domínio`;
}

// ---------- nível de poder ----------

export function powerLevels(r: Ruleset): PowerLevelDef[] {
  const list = r.powerLevels?.length ? r.powerLevels : r.ranks;
  return [...list].sort((a, b) => a.xpRequired - b.xpRequired);
}

export function powerLevel(r: Ruleset, xp: number): { level: PowerLevelDef | undefined; next: PowerLevelDef | undefined } {
  const levels = powerLevels(r);
  let level: PowerLevelDef | undefined = levels[0];
  for (const l of levels) if (xp >= l.xpRequired) level = l;
  return { level, next: levels.find((l) => l.xpRequired > xp) };
}

/** Teto do atributo no nível de poder atual (nunca acima do max do ruleset). */
export function attributeCap(r: Ruleset, xp: number, key: string): number {
  const max = r.attributes.find((a) => a.key === key)?.max ?? Infinity;
  return Math.min(max, powerLevel(r, xp).level?.attributeCap ?? Infinity);
}

/** Primeiro nível de poder cujo teto deixa o atributo subir de `value`. */
export function levelThatAllows(r: Ruleset, key: string, value: number): PowerLevelDef | undefined {
  const max = r.attributes.find((a) => a.key === key)?.max ?? Infinity;
  if (value >= max) return undefined;
  return powerLevels(r).find((l) => (l.attributeCap ?? Infinity) > value);
}

export function attributePoints(r: Ruleset, s: Sheet): { earned: number; spent: number; free: number } {
  const per = r.xpPerAttributePoint ?? DEFAULT_XP_PER_POINT;
  const earned = per > 0 ? Math.floor(Math.max(0, s.xp) / per) : 0;
  const spent = s.attrPointsSpent ?? 0;
  return { earned, spent, free: Math.max(0, earned - spent) };
}

/** Motivo para o atributo não poder subir para `to` (null = pode). Abaixar é sempre livre. */
export function raiseBlocked(r: Ruleset, s: Sheet, key: string, to: number): string | null {
  const def = r.attributes.find((a) => a.key === key);
  if (!def) return `atributo "${key}" não existe`;
  const cur = s.attributes[key] ?? def.default;
  if (to <= cur) return null;
  const cap = attributeCap(r, s.xp, key);
  if (to <= cap) return null;
  const lvl = powerLevel(r, s.xp).level;
  const next = levelThatAllows(r, key, Math.max(cur, cap));
  return `${def.label} ${cur} já está no teto ${cap === Infinity ? def.max : cap} do nível de poder ${lvl?.label ?? "-"}${
    next ? `; aguarda o nível ${next.label} (${next.xpRequired} XP)` : "; é o máximo"
  }`;
}

// ---------- uso e treino ----------

export function findAbility(s: Sheet, name: string): Ability | undefined {
  const n = name.trim().toLowerCase();
  return s.abilities.find((a) => a.name.toLowerCase() === n);
}

/** Atributo do teste: override > mapa do ruleset > atributo de mesma key do tipo > primeiro atributo. */
export function abilityAttribute(r: Ruleset, a: Ability, override?: string): string | null {
  const keys = r.attributes.map((x) => x.key);
  if (override) {
    const o = override.trim().toLowerCase();
    return r.attributes.find((x) => x.key.toLowerCase() === o || x.label.toLowerCase() === o)?.key ?? null;
  }
  const mapped = r.abilityAttributes?.[a.type];
  if (mapped && keys.includes(mapped)) return mapped;
  return keys.includes(a.type) ? a.type : keys[0] ?? null;
}

function todayLog(s: Sheet, day: number) {
  if (!s.trainingLog || s.trainingLog.day !== day) s.trainingLog = { day, hours: 0, mastery: {} };
  return s.trainingLog;
}

/** Sobe o domínio respeitando 100% e o teto diário por habilidade. Muta a ficha. */
export function gainMastery(
  r: Ruleset,
  s: Sheet,
  a: Ability,
  wanted: number,
  day: number
): { before: number; after: number; capped: boolean; milestone: AbilityMilestone | null } {
  const log = todayLog(s, day);
  const key = a.name.toLowerCase();
  const left = Math.max(0, trainingRules(r).maxMasteryPerDay - (log.mastery[key] ?? 0));
  const before = mastery(a);
  const prevMs = currentMilestone({ ...a, progress: before });
  const gain = Math.max(0, Math.min(wanted, left, 100 - before));
  a.progress = before + gain;
  log.mastery[key] = (log.mastery[key] ?? 0) + gain;
  const ms = currentMilestone(a);
  return { before, after: a.progress, capped: gain < wanted && before + gain < 100, milestone: ms && ms.threshold !== prevMs?.threshold ? ms : null };
}

/** Ganho de domínio por um uso real. */
export const useGain = (r: Ruleset, a: Ability) => band(trainingRules(r).masteryPerUse, mastery(a));

export type TrainResult =
  | { error: string }
  | {
      kind: "ability";
      label: string;
      hours: number;
      before: number;
      after: number;
      capped: boolean;
      milestone: AbilityMilestone | null;
      hoursToday: number;
    }
  | {
      kind: "attribute";
      label: string;
      hours: number;
      before: number;
      after: number;
      banked: number; // horas guardadas rumo ao próximo +1
      need: number; // horas do próximo +1 (0 = no teto)
      atCap: boolean;
      hoursToday: number;
    };

/**
 * Treino de `hours` horas num jutsu (nome) ou atributo (key ou rótulo) no dia `day`.
 * Valida tudo antes de mutar: com erro, a ficha fica intacta e o relógio não deve andar.
 */
export function train(r: Ruleset, s: Sheet, target: string, hours: number, day: number): TrainResult {
  const tr = trainingRules(r);
  const h = Math.round(hours);
  if (!(h >= 1)) return { error: "hours precisa ser >= 1 (horas inteiras)." };
  const usedToday = s.trainingLog?.day === day ? s.trainingLog.hours : 0;
  if (usedToday + h > tr.maxHoursPerDay) {
    const left = tr.maxHoursPerDay - usedToday;
    return {
      error: `Treino recusado: exausto. Já treinou ${usedToday} h hoje (máximo ${tr.maxHoursPerDay} h por dia)${
        left > 0 ? `; restam ${left} h` : ""
      }. Descanse até o dia seguinte. Nada foi aplicado e o relógio não andou.`,
    };
  }
  const ability = findAbility(s, target);
  const t = target.trim().toLowerCase();
  const attr = ability ? undefined : r.attributes.find((a) => a.key.toLowerCase() === t || a.label.toLowerCase() === t);
  if (!ability && !attr)
    return { error: `"${target}" não é um jutsu da ficha nem um atributo (${r.attributes.map((a) => a.key).join(", ")}). Registre o jutsu com add_ability antes.` };

  if (ability) {
    const before = mastery(ability);
    if (before >= 100) return { error: `${ability.name} já está em 100% de domínio; treinar não rende mais.` };
    const key = ability.name.toLowerCase();
    const leftToday = tr.maxMasteryPerDay - (s.trainingLog?.day === day ? s.trainingLog.mastery[key] ?? 0 : 0);
    if (leftToday <= 0)
      return { error: `${ability.name} já rendeu o máximo de domínio hoje (+${tr.maxMasteryPerDay}%, treino e uso somados). Treine outra coisa ou descanse. Nada foi aplicado e o relógio não andou.` };
    // hora a hora: a faixa muda no meio do treino
    let p = before;
    for (let i = 0; i < h; i++) p = Math.min(100, p + band(tr.masteryPerHour, p));
    const g = gainMastery(r, s, ability, p - before, day);
    todayLog(s, day).hours += h;
    return { kind: "ability", label: ability.name, hours: h, ...g, hoursToday: todayLog(s, day).hours };
  }

  const key = attr!.key;
  const before = s.attributes[key] ?? attr!.default;
  const cap = attributeCap(r, s.xp, key);
  if (before >= cap) {
    const why = raiseBlocked(r, s, key, before + 1);
    return { error: `Treino de ${attr!.label} não rende: ${why}. Nada foi aplicado e o relógio não andou.` };
  }
  const banked0 = (s.trainingHours?.[key] ?? 0) + h;
  let v = before;
  let banked = banked0;
  while (v < cap && banked >= tr.hoursPerAttributePoint * v) {
    banked -= tr.hoursPerAttributePoint * v;
    v++;
  }
  if (v >= cap) banked = 0; // no teto as horas não acumulam
  s.attributes[key] = v;
  s.trainingHours = { ...s.trainingHours, [key]: banked };
  todayLog(s, day).hours += h;
  return {
    kind: "attribute",
    label: attr!.label,
    hours: h,
    before,
    after: v,
    banked,
    need: v >= cap ? 0 : tr.hoursPerAttributePoint * v,
    atCap: v >= cap,
    hoursToday: todayLog(s, day).hours,
  };
}

/** Uma linha com as regras de progressão, para o prompt do Mestre. */
export function progressionPromptLines(r: Ruleset): string[] {
  const tr = trainingRules(r);
  const bands = (b: MasteryBand[], f: (v: number) => string) =>
    [...b].sort((x, y) => x.min - y.min).map((x) => `${x.min}%+: ${f(x.value)}`).join(", ");
  return [
    `Níveis de poder (vêm só da XP e sobem sozinhos; NÃO são cargo; teto de atributo): ${powerLevels(r)
      .map((l) => `${l.label}=${l.xpRequired} XP${l.attributeCap !== undefined ? ` (teto ${l.attributeCap})` : ""}`)
      .join(", ")}. 1 ponto livre de atributo a cada ${r.xpPerAttributePoint ?? DEFAULT_XP_PER_POINT} XP, distribuído pelo jogador.`,
    `Domínio do jutsu: bônus no teste ${bands(r.masteryBonus ?? DEFAULT_MASTERY_BONUS, (v) => `+${v}`)}; custo ${bands(
      r.masteryCost ?? DEFAULT_MASTERY_COST,
      (v) => `x${v}`
    )}. Teste de técnica (use_ability): 1d20 + atributo x${r.attributeMultiplier ?? 1} + bônus do domínio.`,
    `Treino (train): no máximo ${tr.maxHoursPerDay} h por dia; domínio por hora ${bands(tr.masteryPerHour, (v) => `+${v}`)}; uso real ${bands(
      tr.masteryPerUse,
      (v) => `+${v}`
    )}; no máximo +${tr.maxMasteryPerDay}% de domínio por jutsu por dia; +1 de atributo a cada ${tr.hoursPerAttributePoint} h x valor atual.`,
  ];
}
