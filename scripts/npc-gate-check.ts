// npx tsx scripts/npc-gate-check.ts — confere quem fala sem estar registrado
import assert from "node:assert";
import { unregisteredSpeakers } from "../src/lib/engine";

const chars = [{ name: "Hugo" }, { name: "Daiki-sensei" }, { name: "Iruka Umino" }];
const text = `Narração.\n\n**Iruka-sensei:** "Bom dia."\n\n**Mizuki:** "Pronto?"\n**Daiki-sensei:** "Ok."\n**Hugo (como Daiki):** "Hm."\n**Kakashi Hatake:** "Yo."\n**Mizuki:** "De novo."\nTexto com **ênfase:** no meio não conta.`;
assert.deepStrictEqual(unregisteredSpeakers(text, chars), ["Mizuki", "Kakashi Hatake"]);
assert.deepStrictEqual(unregisteredSpeakers("Sem falas.", chars), []);
assert.deepStrictEqual(unregisteredSpeakers(`**Iruka:** "Oi"`, chars), []);
console.log("npc-gate-check: ok");
