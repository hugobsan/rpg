import { randomInt } from "node:crypto";
import { DiceResult } from "./types";

/** Rola notação padrão: "2d6+3", "1d20", "d8-1", "3d10". */
export function rollDice(notation: string, reason?: string): DiceResult {
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
  return {
    notation,
    rolls,
    modifier,
    total: rolls.reduce((a, b) => a + b, 0) + modifier,
    reason,
  };
}
