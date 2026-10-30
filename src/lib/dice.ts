import { randomInt } from "node:crypto";
import { DiceResult } from "./types";

/** Rola notação padrão: "2d6+3", "1d20", "d8-1", "3d10". crits: 20 natural passa e 1 natural falha (só 1d20 com CD). */
export function rollDice(notation: string, reason?: string, dc?: number, crits = false): DiceResult {
  const m = notation
    .toLowerCase()
    .replace(/\s+/g, "")
    .match(/^(\d*)d(\d+)([+-]\d+)?$/);
  if (!m) throw new Error(`Notação de dado inválida: "${notation}"`);
  const count = Math.min(parseInt(m[1] || "1", 10), 100);
  const sides = Math.min(parseInt(m[2], 10), 1000);
  const modifier = m[3] ? parseInt(m[3], 10) : 0;
  if (count < 1 || sides < 2) throw new Error(`Notação inválida: "${notation}"`);
  const rolls: number[] = [];
  for (let i = 0; i < count; i++) rolls.push(randomInt(1, sides + 1));
  const total = rolls.reduce((a, b) => a + b, 0) + modifier;
  const hasDc = typeof dc === "number" && Number.isFinite(dc);
  const nat = count === 1 && sides === 20 ? rolls[0] : 0;
  const crit = crits && hasDc && (nat === 20 || nat === 1) ? (nat === 20 ? "success" : "failure") : undefined;
  return {
    notation, rolls, modifier, total, reason,
    ...(hasDc ? { dc, success: crit ? crit === "success" : total >= dc } : {}),
    ...(crit ? { crit } : {}),
  };
}
