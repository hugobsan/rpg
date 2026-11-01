"use client";
import { useState } from "react";
import dynamic from "next/dynamic";
import Skeleton from "@/components/ui/Skeleton";
import s from "./agents.module.css";

// React Flow (pesado) só é baixado quando o cartão abre
const AgentsFlow = dynamic(() => import("./AgentsFlow"), {
  ssr: false,
  loading: () => <Skeleton className={s.flowSkeleton} />,
});

export default function AgentsDiagram() {
  // o canvas só monta ao abrir: o React Flow precisa de um container com tamanho para o fitView
  const [open, setOpen] = useState(false);
  return (
    <details className={`card ${s.diagram}`} onToggle={(ev) => setOpen((ev.currentTarget as HTMLDetailsElement).open)}>
      <summary>
        <div>
          <h2>Como os agentes trabalham</h2>
          <p className="muted">Diagrama do turno, das conversas com NPC, do que roda sob demanda e da criação em segundo plano.</p>
        </div>
        <svg className={s.chev} width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
          <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </summary>
      <div className={s.diagramBody}>
        <p className="muted">
          Arraste para mover, use a roda do mouse ou a pinça para dar zoom e passe o mouse (ou toque) num bloco para ver o
          que ele faz, quando é chamado, a frequência, o custo e o que acontece se falhar. A cor da borda indica quem executa.
        </p>
        {open && <AgentsFlow />}
      </div>
    </details>
  );
}
