import { GET } from "@/app/api/settings/route";
import { listAgents } from "@/lib/agents";
import { ADVANCED_SPEC, getAdvanced } from "@/lib/advanced";
import SettingsForm, { type SettingsShape } from "./SettingsForm";
import s from "./settings.module.css";

export const dynamic = "force-dynamic";

// ?chatgpt=ok ou ?chatgpt_erro=... chegam do retorno do Login com ChatGPT (/auth/callback)
export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ chatgpt?: string; chatgpt_erro?: string }> }) {
  // a mesma resposta da rota, lida no servidor: o formulário já abre preenchido
  const [initial, agents, sp, values] = await Promise.all([GET().then((r) => r.json() as Promise<SettingsShape>), listAgents(), searchParams, getAdvanced()]);
  const usedBy: Record<string, string[]> = {};
  for (const a of agents) (usedBy[a.source] ??= []).push(a.name);
  const notice = sp.chatgpt_erro ? { ok: false, text: sp.chatgpt_erro } : sp.chatgpt === "ok" ? { ok: true, text: "" } : null;
  return (
    <main className={`container ${s.wrap}`}>
      <h1>Configurações</h1>
      <p className={`muted ${s.lede}`}>Valem para todas as campanhas. As fontes de modelos e as chaves ficam aqui; o modelo e o prompt de cada agente, em Agentes.</p>
      <SettingsForm initial={initial} advanced={{ spec: ADVANCED_SPEC, values }} usedBy={usedBy} notice={notice} />
    </main>
  );
}
