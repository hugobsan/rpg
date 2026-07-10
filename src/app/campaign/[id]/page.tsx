import GameClient from "@/components/GameClient";

export default async function CampaignPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <GameClient campaignId={id} />;
}
