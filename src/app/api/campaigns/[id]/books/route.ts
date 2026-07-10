import { NextRequest, NextResponse } from "next/server";
import { ingestBook, listBooks } from "@/lib/books";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  return NextResponse.json(await listBooks(id));
}

/** POST multipart: file (pdf/txt/md) + title → indexa em páginas e chunks. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const form = await req.formData();
  const file = form.get("file") as File | null;
  if (!file) return NextResponse.json({ error: "Arquivo obrigatório" }, { status: 400 });
  const title = String(form.get("title") || file.name);
  try {
    const buf = Buffer.from(await file.arrayBuffer());
    const result = await ingestBook(id, title, file.name, buf);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
