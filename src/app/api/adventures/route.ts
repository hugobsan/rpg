import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { q } from "@/lib/db";
import { getAgent } from "@/lib/agents";
import { chat, ChatMessage } from "@/lib/openrouter";
import { THEMES } from "@/lib/theme";
import { Draft, DraftMessage, draftIssues, mergeDraft, OPENING, parseReply, Reply } from "@/lib/adventure";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // modelo que raciocina: uma rodada pode levar mais de um minuto

interface Row {
  id: string;
  messages: DraftMessage[];
  draft: Draft;
  done: boolean;
}

/** GET → rascunhos recentes (para retomar); ?id= → o rascunho inteiro. */
export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (id) {
    const rows = await q<Row>(`SELECT id, messages, draft, done FROM adventure_drafts WHERE id = $1`, [id]).catch(() => []);
    return rows[0] ? NextResponse.json(rows[0]) : NextResponse.json({ error: "Rascunho não encontrado" }, { status: 404 });
  }
  const list = await q(
    `SELECT id, draft->>'name' AS name, messages->1->>'content' AS first, done,
            jsonb_array_length(messages) AS count, updated_at::text
       FROM adventure_drafts ORDER BY updated_at DESC LIMIT 8`
  );
  return NextResponse.json(list);
}

/** DELETE ?id= → apaga o rascunho. */
export async function DELETE(req: NextRequest) {
  await q(`DELETE FROM adventure_drafts WHERE id = $1`, [req.nextUrl.searchParams.get("id")]).catch(() => {});
  return NextResponse.json({ ok: true });
}

const naruto = () => fs.readFileSync(path.join(process.cwd(), "naruto-ruleset.json"), "utf-8");

function context(draft: Draft): string {
  const issues = draftIssues(draft);
  return [
    `TEMAS VISUAIS (theme):\n${THEMES.map((t) => `- ${t.key}: ${t.description}`).join("\n")}`,
    `EXEMPLO COMPLETO (Naruto):\n${naruto()}`,
    `RASCUNHO ATUAL:\n${JSON.stringify(draft)}`,
    `AINDA FALTA OU ESTÁ INCOERENTE (resolva perguntando ou inferindo; só feche com done=true quando esta lista estiver vazia):\n${
      issues.length ? issues.map((i) => `- ${i}`).join("\n") : "(nada)"
    }`,
  ].join("\n\n");
}

async function ask(history: DraftMessage[], draft: Draft): Promise<Reply> {
  const agent = await getAgent("adventure");
  const messages: ChatMessage[] = [
    { role: "system", content: `${agent.system_prompt}\n\n${context(draft)}` },
    ...history.map((m) => ({ role: m.role, content: m.content })),
  ];
  const res = await chat({
    model: agent.model,
    messages,
    temperature: agent.temperature,
    max_tokens: agent.max_tokens,
    webSearch: agent.web_search,
    agentId: "adventure",
    purpose: "criação de aventura",
  });
  const reply = parseReply(res.content);
  if (!reply.message && !Object.keys(reply.patch).length)
    throw new Error("O criador não respondeu (o modelo voltou vazio). Tente de novo.");
  return reply;
}

/** POST { id?, text } → uma rodada da entrevista. Sem id, cria o rascunho (só depois da resposta, para não deixar vazio). */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { id?: string; text?: string };
  const text = String(body.text || "").trim().slice(0, 4000);
  if (!text) return NextResponse.json({ error: "Escreva alguma coisa." }, { status: 400 });
  let row: Row = { id: "", messages: [OPENING], draft: {}, done: false };
  if (body.id) {
    const rows = await q<Row>(`SELECT id, messages, draft, done FROM adventure_drafts WHERE id = $1`, [body.id]).catch(() => []);
    if (!rows[0]) return NextResponse.json({ error: "Rascunho não encontrado" }, { status: 404 });
    row = rows[0];
  }
  const messages: DraftMessage[] = [...row.messages, { role: "user", content: text }];
  try {
    let reply = await ask(messages, row.draft);
    let draft = mergeDraft(row.draft, reply.patch);
    let issues = draftIssues(draft);
    // JSON ilegível ou fechou com pendências: uma rodada de conserto sem incomodar o jogador
    const problem = reply.broken
      ? "O bloco JSON da sua resposta veio inválido e foi descartado. Repita a mesma mensagem para o jogador e o bloco completo, agora com JSON válido."
      : reply.done && issues.length
        ? `A aventura ainda não fecha:\n${issues.map((i) => `- ${i}`).join("\n")}\nCorrija no patch decidindo você mesmo, sem perguntar ao jogador, e repita a mensagem final para ele (ajustada se preciso).`
        : "";
    if (problem) {
      const fix = await ask(
        [...messages, { role: "assistant", content: reply.message }, { role: "user", content: `(aviso do sistema, não do jogador) ${problem}` }],
        draft
      ).catch(() => null); // o conserto falhou: fica a primeira resposta
      if (fix) {
        draft = mergeDraft(draft, fix.patch);
        issues = draftIssues(draft);
        reply = { ...fix, message: fix.message || reply.message };
      }
    }
    const done = reply.done && !issues.length;
    const answer: DraftMessage = { role: "assistant", content: reply.message || "Anotado.", ...(reply.choices.length ? { choices: reply.choices } : {}) };
    const all = JSON.stringify([...messages, answer]);
    const saved = row.id
      ? await q<Row>(`UPDATE adventure_drafts SET messages = $2, draft = $3, done = $4, updated_at = now() WHERE id = $1 RETURNING id, messages, draft, done`, [row.id, all, JSON.stringify(draft), done])
      : await q<Row>(`INSERT INTO adventure_drafts (messages, draft, done) VALUES ($1, $2, $3) RETURNING id, messages, draft, done`, [all, JSON.stringify(draft), done]);
    return NextResponse.json(saved[0]);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
