import { GET } from "@/app/api/settings/route";
import SettingsForm, { type SettingsShape } from "./SettingsForm";
import s from "./settings.module.css";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  // a mesma resposta da rota, lida no servidor: o formulário já abre preenchido
  const initial = (await (await GET()).json()) as SettingsShape;
  return (
    <main className={`container ${s.wrap}`}>
      <h1>Configurações</h1>
      <p className={`muted ${s.lede}`}>Valem para todas as campanhas. Modelos e prompts de cada agente ficam em Agentes.</p>
      <SettingsForm initial={initial} />
    </main>
  );
}
