import type { AgentConfig } from "./types";

/**
 * Presets de fonte (settings.agentPresets): fonte e modelo de cada agente, para trocar todos de uma vez
 * quando o saldo de uma fonte aperta. Jev, Ilustrador e Voz dependem do OpenRouter e ficam fora.
 */
export const PRESET_FIXED = ["decider", "image", "voice"];

// o que muda junto com a fonte: modelo de turnos complexos (Mestre), cache (só Claude) e busca web (só OpenRouter)
export interface PresetEntry {
  source: string;
  model: string;
  complexModel?: string;
  cache?: boolean;
  web_search?: boolean;
}
export interface AgentPreset {
  id: string;
  name: string;
  agents: Record<string, PresetEntry>;
}

export const presetEntry = (a: AgentConfig): PresetEntry => ({
  source: a.source,
  model: a.model,
  ...(a.params.complexModel !== undefined && { complexModel: String(a.params.complexModel) }),
  cache: !!a.params.cache,
  web_search: a.web_search,
});

/** Foto da configuração atual dos agentes que entram em preset. */
export const snapshot = (agents: AgentConfig[]): Record<string, PresetEntry> =>
  Object.fromEntries(agents.filter((a) => !PRESET_FIXED.includes(a.id)).map((a) => [a.id, presetEntry(a)]));

/** O preset está em uso: todo agente dele está com a mesma fonte e o mesmo modelo. */
export const presetActive = (p: AgentPreset, agents: AgentConfig[]) =>
  Object.entries(p.agents).every(([id, e]) => {
    const a = agents.find((x) => x.id === id);
    return !a || (a.source === e.source && a.model === e.model && (e.complexModel ?? "") === String(a.params.complexModel ?? ""));
  });
