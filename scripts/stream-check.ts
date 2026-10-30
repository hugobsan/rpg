// npx tsx scripts/stream-check.ts — streaming do OpenRouter (SSE sintético) e o corte do bloco de opções
import assert from "node:assert";
import { readStream } from "../src/lib/openrouter";
import { visibleNarration } from "../src/lib/engine";

/** Corpo SSE quebrado em pedaços de `size` bytes (corta no meio de linhas e de caracteres UTF-8). */
function body(events: (object | string)[], size: number, crlf = false): ReadableStream<Uint8Array> {
  const nl = crlf ? "\r\n" : "\n";
  const text = events.map((e) => (typeof e === "string" ? e : `data: ${JSON.stringify(e)}`) + nl + nl).join("");
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i >= bytes.length) return c.close();
      c.enqueue(bytes.slice(i, (i += size)));
    },
  });
}

const chunk = (delta: object, extra: object = {}) => ({ id: "gen-1", model: "m/x", choices: [{ index: 0, delta, finish_reason: null }], ...extra });

async function main() {
  // texto + duas ferramentas em pedaços + usage no fim
  const events = [
    ": OPENROUTER PROCESSING",
    chunk({ role: "assistant", content: "Você entra na " }),
    chunk({ content: "sala — ação ✓ " }),
    chunk({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "roll_dice", arguments: "" } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '{"notation":' } }] }),
    chunk({ tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "advance_time", arguments: '{"minutes":5}' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '"1d20"}' } }] }),
    { id: "gen-1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    { id: "gen-1", choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.0012 } },
    "data: [DONE]",
  ];
  for (const size of [1, 3, 7, 64, 100000])
    for (const crlf of [false, true]) {
      const deltas: string[] = [];
      const out = (await readStream(body(events, size, crlf), (t) => deltas.push(t))) as {
        choices: { message: { content: string; tool_calls: { id: string; function: { name: string; arguments: string } }[] }; finish_reason: string }[];
        usage: { cost: number; prompt_tokens: number };
        error?: unknown;
      };
      const m = out.choices[0].message;
      assert.strictEqual(out.error, undefined);
      assert.strictEqual(m.content, "Você entra na sala — ação ✓ ");
      assert.strictEqual(deltas.join(""), m.content);
      assert.deepStrictEqual(
        m.tool_calls.map((c) => [c.id, c.function.name, JSON.parse(c.function.arguments)]),
        [["call_a", "roll_dice", { notation: "1d20" }], ["call_b", "advance_time", { minutes: 5 }]]
      );
      assert.strictEqual(out.choices[0].finish_reason, "tool_calls");
      assert.strictEqual(out.usage.cost, 0.0012);
      assert.strictEqual(out.usage.prompt_tokens, 100);
    }

  // erro no meio do stream: fica o parcial e o error
  const broken = await readStream(
    body([chunk({ content: "Começo" }), { id: "gen-1", error: { code: 502, message: "Provider disconnected" }, choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }] }, chunk({ content: " nunca" })], 5),
    () => {}
  );
  assert.deepStrictEqual((broken.error as { message: string }).message, "Provider disconnected");
  assert.strictEqual((broken.choices as { message: { content: string } }[])[0].message.content, "Começo");

  // conexão cai no meio
  const dying = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk({ content: "Oi" }))}\n\n`));
      c.error(new Error("socket hang up"));
    },
  });
  const died = await readStream(dying, () => {});
  assert.strictEqual((died.error as { message: string }).message, "socket hang up");

  // visibleNarration: em qualquer corte do texto, o que já foi mostrado nunca inclui o bloco de opções
  const narr = "Você vê `marcas` no chão.\n\n**Iruka:** \"Cuidado.\"\n\n";
  const full = narr + '```choices\n["Seguir", "Voltar"]\n```';
  for (let step = 1; step <= 12; step++) {
    let acc = "";
    let shown = "";
    for (let i = 0; i < full.length; i += step) {
      acc += full.slice(i, i + step);
      const v = visibleNarration(acc);
      assert.ok(v.startsWith(shown), `regrediu no passo ${step}`);
      shown = v.length > shown.length ? v : shown;
    }
    assert.strictEqual(shown, narr);
  }
  assert.strictEqual(visibleNarration("sem opções"), "sem opções");
  assert.strictEqual(visibleNarration("termina em `"), "termina em ");
  assert.strictEqual(visibleNarration("código `x` e ``` cerca"), "código `x` e ``` cerca");
  console.log("stream-check: ok");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
