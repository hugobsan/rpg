import { NextRequest, NextResponse } from "next/server";
import { q } from "@/lib/db";

export const dynamic = "force-dynamic";

/** GET → lista as imagens da campanha (mais novas primeiro), sem o data_url (pesado). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const rows = await q(
      `SELECT i.id, i.created_at, s.location, s.title
       FROM scene_images i LEFT JOIN scenes s ON s.id = i.scene_id
       WHERE i.campaign_id = $1 ORDER BY i.id DESC`,
      [id]
    );
    return NextResponse.json({ images: rows });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
