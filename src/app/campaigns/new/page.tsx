import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_RULESET, normalizeRuleset } from "@/lib/ruleset";
import Wizard from "./Wizard";

// os presets já vão no HTML: o assistente abre pronto, sem buscar /api/rulesets
export default async function NewCampaign() {
  const naruto = normalizeRuleset(JSON.parse(await fs.readFile(path.join(process.cwd(), "naruto-ruleset.json"), "utf-8")));
  return <Wizard presets={{ naruto, default: DEFAULT_RULESET }} />;
}
