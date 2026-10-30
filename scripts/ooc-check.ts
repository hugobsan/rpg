// npx tsx scripts/ooc-check.ts — pseudo-chamadas e "📌 Guardei" falsos saem do texto
import assert from "node:assert";
import { splitPseudoCalls } from "../src/lib/ooc";

const fake = `Tá certo, anotei.\n\n(save_directive: Não mencione pontos livres no chat.)\n\n📌 Guardei: Diretriz: Não mencione pontos livres no chat.`;
const a = splitPseudoCalls(fake);
assert.strictEqual(a.clean, "Tá certo, anotei.");
assert.deepStrictEqual(a.pseudo, [{ content: "Não mencione pontos livres no chat." }]);
const b = splitPseudoCalls(`Ok.\nsave_directive({"content":"Mais investigação","kind":"preferencia","scope":"permanente"})`);
assert.deepStrictEqual(b.pseudo, [{ content: "Mais investigação", kind: "preferencia", scope: "permanente" }]);
assert.deepStrictEqual(splitPseudoCalls("Você tem 50 de chakra.").pseudo, []);
console.log("ooc-check: ok");
