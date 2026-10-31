import { Suspense } from "react";
import { usageLogs, usageSummary } from "./data";
import UsageClient from "./UsageClient";
import s from "./usage.module.css";

export const dynamic = "force-dynamic";

// 1ª carga no servidor (o painel já vem no HTML); trocar filtro ou página busca no cliente
export default async function UsagePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) if (typeof v === "string") sp.set(k, v);
  const [summary, logs] = await Promise.all([usageSummary(sp), usageLogs(sp)]);
  return (
    <main className="container">
      <h1>Custos e uso</h1>
      <p className={`muted ${s.lede}`}>Todas as chamadas de IA, de todas as fontes, somadas no recorte dos filtros. O custo é o real do OpenRouter e, nos agentes de outras fontes com o custo pelo preço do OpenRouter ligado, uma estimativa (≈).</p>
      {/* useSearchParams pede Suspense no App Router */}
      <Suspense>
        <UsageClient initial={{ qs: sp.toString(), summary, logs }} />
      </Suspense>
    </main>
  );
}
