import GameClient from "@/components/GameClient";
import { campaignView } from "@/lib/campaignView";

export const dynamic = "force-dynamic";

export default async function CampaignPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // estado inicial já no HTML: a tela abre pronta, sem esperar o JS buscar (sem campanha, o cliente mostra o erro)
  const initial = await campaignView(id).catch(() => null);
  return <GameClient key={id} campaignId={id} initial={initial} />;
}
