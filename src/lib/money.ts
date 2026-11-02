import type { Currency } from "./types";

// ponytail: a carteira guarda o total na menor moeda (troco automático), não as moedas físicas; separar por moeda
// só se algum mundo precisar de câmbio ou de "não tenho troco"
const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();

/** Moedas válidas (key, label, value inteiro ≥ 1), da mais valiosa para a mais barata; sem nenhuma, o mundo não tem dinheiro. */
export function normalizeCurrency(input: unknown): Currency | undefined {
  const c = input as Partial<Currency> | undefined;
  if (!c || typeof c !== "object" || !Array.isArray(c.units)) return undefined;
  const units = c.units
    .filter((u) => u && typeof u.key === "string" && u.key.trim() && typeof u.label === "string" && u.label.trim() && Number.isInteger(u.value) && u.value >= 1)
    .map((u) => ({ key: u.key.trim(), label: u.label.trim(), ...(typeof u.plural === "string" && u.plural.trim() && { plural: u.plural.trim() }), value: u.value }))
    .sort((a, b) => b.value - a.value);
  if (!units.length) return undefined;
  return {
    units,
    ...(typeof c.start === "number" && c.start >= 0 && { start: Math.round(c.start) }),
    ...(typeof c.prices === "string" && c.prices.trim() && { prices: c.prices.trim() }),
  };
}

const n = (x: number) => x.toLocaleString("pt-BR");

/** Valor na menor moeda em texto: "1.500 Ryō"; com várias, da maior para a menor ("2 Galeões, 3 Sicles e 5 Nuques"). */
export function formatMoney(amount: number, c: Currency): string {
  const sign = amount < 0 ? "-" : "";
  let rest = Math.abs(Math.round(amount));
  const name = (u: Currency["units"][number], q: number) => (q === 1 ? u.label : u.plural ?? u.label);
  if (c.units.length === 1) return `${sign}${n(rest / c.units[0].value)} ${name(c.units[0], rest)}`;
  const parts: string[] = [];
  for (const u of c.units) {
    const q = Math.floor(rest / u.value);
    rest -= q * u.value;
    if (q) parts.push(`${n(q)} ${name(u, q)}`);
  }
  if (!parts.length) return `0 ${name(c.units.at(-1)!, 0)}`;
  return sign + (parts.length > 1 ? `${parts.slice(0, -1).join(", ")} e ${parts.at(-1)}` : parts[0]);
}

/** Quantia numa moeda (key, nome ou plural; sem ela, a única do mundo) → menor moeda, ou o erro em texto. */
export function toBase(amount: number, unit: string | undefined, c: Currency): number | string {
  if (!Number.isFinite(amount)) return "amount precisa ser um número.";
  const u = unit
    ? c.units.find((x) => [x.key, x.label, x.plural ?? ""].some((s) => s && norm(s) === norm(unit)))
    : c.units.length === 1 ? c.units[0] : undefined;
  if (!u) return `Moeda ${unit ? `"${unit}" não existe` : "não informada"}: use unit com uma de ${c.units.map((x) => x.key).join(", ")}.`;
  return Math.round(amount * u.value);
}

/** Moedas do mundo para os prompts: nomes, valores e preços de referência. */
export function currencyPromptLine(c: Currency): string {
  const low = c.units.at(-1)!;
  const units = c.units.map((u) => `${u.label} (${u.key}${u.value > 1 ? ` = ${n(u.value)} ${low.plural ?? low.label}` : ""})`).join(", ");
  return `Dinheiro: ${units}. O saldo fica na ficha (dinheiro) e só muda por update_money; ninguém compra o que não pode pagar.${c.prices ? ` Preços de referência (variam com lugar, vendedor e barganha): ${c.prices}` : ""}`;
}
