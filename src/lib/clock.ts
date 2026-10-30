/**
 * Relógio do jogo: minutos desde o "Dia 1, 00:00" da campanha, em campaigns.state.clock.
 * Sem calendário de cenário: o dia é relativo ao começo da campanha.
 */
export interface Clock {
  minutes: number;
}

export type Period = "madrugada" | "manhã" | "tarde" | "noite";

export const PERIOD_ICON: Record<Period, string> = { madrugada: "🌌", manhã: "🌅", tarde: "☀️", noite: "🌙" };

/** null = relógio ainda não definido. */
export function getClock(state: Record<string, unknown> | null | undefined): Clock | null {
  const m = (state?.clock as Clock | undefined)?.minutes;
  return typeof m === "number" && Number.isFinite(m) ? { minutes: m } : null;
}

export function clockParts(minutes: number): { day: number; hour: number; minute: number } {
  const m = Math.max(0, Math.round(minutes));
  return { day: Math.floor(m / 1440) + 1, hour: Math.floor((m % 1440) / 60), minute: m % 60 };
}

export function toMinutes(day: number, hour: number, minute: number): number {
  return (day - 1) * 1440 + hour * 60 + minute;
}

export function period(minutes: number): Period {
  const { hour } = clockParts(minutes);
  return hour < 6 ? "madrugada" : hour < 12 ? "manhã" : hour < 18 ? "tarde" : "noite";
}

/** "Dia 3 · 14:30" */
export function formatClock(minutes: number): string {
  const { day, hour, minute } = clockParts(minutes);
  return `Dia ${day} · ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** "+20 min", "+2 h", "+1 dia 3 h" */
export function formatDuration(minutes: number): string {
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  const parts = [d && `${d} dia${d > 1 ? "s" : ""}`, h && `${h} h`, m && `${m} min`].filter(Boolean);
  return parts.length ? parts.join(" ") : "0 min";
}
