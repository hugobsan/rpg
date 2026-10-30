// Fontes conhecidas (sem banco: usado no cliente e no servidor). Ao adicionar uma fonte, o tipo preenche nome e URL;
// o usuário só cola a API key. URLs conferidas na documentação de cada uma em 2026-10-30.
export interface SourcePreset {
  kind: string;
  name: string;
  url: string;
  note: string; // limitações, mostradas no aviso da fonte
  noTemperature?: boolean; // não mandar temperature (o provedor rejeita os valores que os agentes usam)
  reasoningEffort?: boolean; // params.reasoning.effort vira reasoning_effort (formato da OpenAI)
}

export const SOURCE_PRESETS: SourcePreset[] = [
  {
    kind: "openai",
    name: "OpenAI",
    url: "https://api.openai.com/v1",
    reasoningEffort: true,
    note: "API da OpenAI. O raciocínio do agente (params.reasoning) vai como reasoning_effort, que só os modelos de raciocínio aceitam; eles podem recusar max_tokens ou temperature.",
  },
  {
    kind: "anthropic",
    name: "Anthropic",
    url: "https://api.anthropic.com/v1",
    noTemperature: true,
    note:
      "Camada de compatibilidade com a OpenAI, que a própria Anthropic diz não ser solução de produção. Sem response_format nem cache de prompt; as mensagens de sistema vão juntas para o início. Nos Claude 4.7 ou mais novos temperature abaixo de 1 dá erro: a temperatura e o raciocínio do agente (params.reasoning) não são enviados. Modelos: claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5, claude-fable-5-1.",
  },
  {
    kind: "gemini",
    name: "Gemini",
    url: "https://generativelanguage.googleapis.com/v1beta/openai",
    note: "Endpoint compatível com a OpenAI do Google AI (beta). Gera imagem só por /images/generations: o Ilustrador não funciona por aqui.",
  },
  {
    kind: "opencode",
    name: "OpenCode",
    url: "https://opencode.ai/inference/v1",
    note: "Console do OpenCode: todo modelo de texto responde em /chat/completions (ele traduz). Os modelos grátis só funcionam dentro do OpenCode: aqui, use os pagos.",
  },
];

export const presetOf = (kind?: string) => SOURCE_PRESETS.find((p) => p.kind === kind);
