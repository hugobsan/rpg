import { NextRequest, NextResponse } from "next/server";
import { chatgptStatus, logout, startLogin } from "@/lib/chatgptAuth";

export const dynamic = "force-dynamic";

// Login com ChatGPT: GET status (sem tokens), POST → { url } de autorização para abrir, DELETE desconecta.
export async function GET() {
  return NextResponse.json(await chatgptStatus());
}

export async function POST(req: NextRequest) {
  return NextResponse.json({ url: await startLogin(req.nextUrl.origin) });
}

export async function DELETE() {
  return NextResponse.json({ ...(await logout()), ...(await chatgptStatus()) });
}
