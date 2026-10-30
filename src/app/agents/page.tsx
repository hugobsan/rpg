import Link from "next/link";
import { listAgents } from "@/lib/agents";
import { getSources, sourceView } from "@/lib/openrouter";
import AgentsClient from "./AgentsClient";
import s from "./agents.module.css";

export const dynamic = "force-dynamic";

// agentes lidos no servidor: os cartões já vêm no HTML; o catálogo de modelos chega depois, só para o editor
export default async function AgentsPage() {
  const [agents, sources] = await Promise.all([listAgents(), getSources()]);
  return (
    <main className="container">
      <h1>Agentes</h1>
      <p className={`muted ${s.lede}`}>
        Cada agente é um modelo com system prompt e parâmetros, numa fonte de modelos (o OpenRouter ou outra API compatível com a
        da OpenAI, cadastradas em <Link href="/settings#fontes">Configurações</Link>). Toda chamada fica registrada (fonte, tokens, custo, duração, request e resposta) em{" "}
        <Link href="/usage">Custos e uso</Link>, para você comparar e trocar modelos e prompts.
      </p>
      <AgentsClient initialAgents={agents} sources={sources.map(sourceView)} />
    </main>
  );
}
