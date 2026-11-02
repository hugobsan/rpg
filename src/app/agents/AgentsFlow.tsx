"use client";
import "@xyflow/react/dist/style.css";
import { useCallback, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";

// Mesma paleta de globals.css (hex porque as setas SVG e o minimapa não leem var()).
const COLOR = {
  player: "#9a95a8",
  code: "#6b6880",
  gm: "#d4a24e",
  npc: "#a78bfa",
  chron: "#fbbf24",
  writer: "#3fb8af",
  img: "#66bb6a",
  jev: "#60a5fa",
  db: "#4de08a",
  infra: "#9a95a8",
  char: "#fb7185",
  abil: "#ec5a55",
  items: "#f59e6b",
  carto: "#38bdf8",
  surv: "#2dd4bf",
  adv: "#e879f9",
  scribe: "#a3e635",
  referee: "#f97316",
  suggest: "#818cf8",
  voice: "#f9a8d4",
} as const;
type Who = keyof typeof COLOR;

const KIND_LABEL: Record<Who, string> = {
  player: "Jogador",
  code: "Código (sem IA)",
  gm: "Mestre",
  npc: "NPC",
  chron: "Cronista",
  writer: "Roteirista",
  img: "Ilustrador",
  jev: "Jev",
  db: "Banco de dados",
  infra: "Infraestrutura",
  char: "Criador de personagens",
  abil: "Criador de habilidades",
  items: "Criador de itens",
  carto: "Cartógrafo",
  surv: "Topógrafo",
  adv: "Criador de aventuras",
  scribe: "Escrivão",
  referee: "Árbitro",
  suggest: "Ações rápidas",
  voice: "Voz",
};

interface Tip {
  oque: string;
  quando?: string;
  freq?: string;
  custo?: string;
  fallback?: string;
}
interface FlowData extends Record<string, unknown> {
  who: Who;
  title: string;
  sub: string;
  tip: Tip;
}
type FlowNode = Node<FlowData, "flow">;
type LaneNode = Node<{ label: string }, "lane">;

const TIP_LABELS: [keyof Tip, string][] = [
  ["oque", "O que faz"],
  ["quando", "Quando é chamado"],
  ["freq", "Frequência"],
  ["custo", "Custo"],
  ["fallback", "Se falhar"],
];

// ---------- nós ----------
// Colunas: passo de 270px. Lanes: sob demanda, turno, NPC e criação em segundo plano, de cima para baixo.
const X = [20, 290, 560, 830, 1100, 1370];

const n = (id: string, x: number, y: number, who: Who, title: string, sub: string, tip: Tip): FlowNode => ({
  id,
  type: "flow",
  position: { x, y },
  // tamanho fixo: o minimapa só desenha nós com width/height explícitos
  width: 165,
  height: 96,
  data: { who, title, sub, tip },
});

const lane = (id: string, y: number, h: number, w: number, label: string): LaneNode => ({
  id,
  type: "lane",
  position: { x: 0, y },
  data: { label },
  style: { width: w, height: h, pointerEvents: "none" },
  selectable: false,
  draggable: false,
  focusable: false,
  zIndex: -1,
});

const NODES: (FlowNode | LaneNode)[] = [
  lane("L3", -430, 390, 1300, "3. Sob demanda: Roteirista, Ilustrador, Criador de aventuras, Voz e fora do jogo"),
  lane("L1", 0, 505, 1570, "1. Turno do jogador"),
  lane("L2", 540, 290, 1570, "2. Conversa particular com um NPC"),
  lane("L4", 870, 720, 1570, "4. Criação em segundo plano: personagens, retratos, biblioteca do mundo e mapas"),

  // --- sob demanda ---
  n("v_btn", X[0], -370, "player", "Botão “Ouvir a fala”", "fala de NPC no chat ou na conversa", {
    oque: "O áudio só é gerado quando o jogador clica no alto-falante ao lado de uma fala de NPC (no chat da campanha ou na conversa particular) ou em Ouvir prévia, no modal do NPC.",
  }),
  n("v_voice", X[1], -370, "voice", "Voz", "fala do NPC em áudio (TTS)", {
    oque: "Lê só a fala (o que está entre aspas, ou o texto sem as ações entre asteriscos) com o modelo de fala do agente, na voz escolhida no modal do NPC ou na padrão do sexo dele. Sexo nunca decidido: o Jev decide pela persona e o código grava. Não passa pelo Mestre e não entra no contexto de nenhum agente.",
    quando: "Só no botão de ouvir.",
    freq: "1 chamada por fala nova: o áudio fica em cache (modelo + voz + texto) e ouvir de novo não cobra.",
    custo: "Grátis com o modelo padrão (HeyGen pelo OpenRouter). Fora do OpenRouter o custo não é informado.",
    fallback: "A tela mostra o erro. Se o Jev falhar, vale a voz masculina e ele tenta de novo na próxima fala.",
  }),
  n("o_btn", X[3], -370, "player", "Fora do jogo", "o jogador fala como ele mesmo", {
    oque: "Conversa com o Mestre fora da história: dúvidas de regra, correções de ficha, pedidos de como conduzir a mesa. Não entra no histórico do turno nem na foto do “gerar novamente”.",
  }),
  n("o_gm", X[4], -370, "gm", "Mestre fora do jogo", "diretrizes, regras da mesa, correções", {
    oque: "O mesmo modelo do Mestre, com outro prompt: responde curto, sem narrar nem dar spoiler (não vê roteiro nem segredos de NPC). Vê a cena, missões, regras e modos de cena da mesa, a ficha completa, os últimos trechos da história e as diretrizes ativas. Orientação de como conduzir vira diretriz (save_directive), que entra no contexto de todo turno; dificuldade, críticos, ritmo de XP e o texto de cada modo de cena vão em set_table_rules; corrige fichas, relógio e missões com as ferramentas do turno (menos roteiro, get_character, npc_message e map_brief), corrige a técnica na biblioteca do mundo com edit_ability (vale para todas as campanhas do mundo), tira técnica de uma ficha com remove_ability (a entrada fica na biblioteca), mexe direto no mapa e pede lotes da biblioteca.",
    quando: "A cada mensagem na conversa fora do jogo, e quando o Jev vê no chat do jogo uma pergunta ou reclamação sobre o registro (a tela abre a conversa com a resposta).",
    freq: "1 a 4 chamadas por mensagem (outra rodada só para ler uma busca ou escrever a resposta).",
    custo: "O modelo principal do Mestre, sem Jev e sem busca web; contexto menor que o do turno.",
  }),
  n("s_btn1", X[0], -250, "player", "Criar ou replanejar campanha", "gera o roteiro", {
    oque: "O roteiro é gerado ao criar a campanha (se a opção estiver marcada) ou quando você pede para replanejar.",
  }),
  n("s_writer", X[1], -250, "writer", "Roteirista", "premissa, arcos, ganchos", {
    oque: "Planeja a campanha: premissa, de 4 a 8 arcos, eventos canônicos e ganchos ligados ao passado do personagem, em JSON. Se o cenário é baseado em obra, ancora os arcos na linha do tempo canônica, com busca web.",
    quando: "Ao criar a campanha (se marcado) e ao pedir replanejamento.",
    freq: "Raro: 1 chamada por geração.",
    custo: "Médio e pontual: saída de até 4 mil tokens, mais a busca web.",
    fallback: "Sem JSON válido, nada é salvo e a tela mostra erro (502); o roteiro anterior continua.",
  }),
  n("s_script", X[2], -250, "code", "Roteiro da campanha", "campaigns.script", {
    oque: "Fica salvo na campanha. O arco ativo entra no contexto do Mestre a cada turno, na decisão do Jev e, como momento da história, no prompt do Ilustrador; o Mestre consulta (get_script) e atualiza (update_script, uma anotação) o roteiro por ferramenta.",
  }),
  n("s_btn2", X[0], -130, "player", "Botão “Ver ambiente”", "na tela da campanha", {
    oque: "A imagem só é gerada quando o jogador clica.",
  }),
  n("s_img", X[1], -130, "img", "Ilustrador", "imagem do ambiente", {
    oque: "Gera uma imagem a partir do cenário, do local, do modo da cena, da hora (luz e céu), do momento da história (arco ativo), de quem está em cena com a aparência da ficha e das duas últimas narrações do Mestre. O estilo fixado no card do Ilustrador (vazio = anime cinematográfico) vai no começo; com “Reescrever o prompt” ligado, um modelo de texto reescreve o pedido curto e em inglês antes. Não passa pelo Mestre e não entra no contexto de nenhum agente.",
    quando: "Só quando o jogador clica em “Ver ambiente”, com a geração de imagens ligada nas Configurações.",
    freq: "Sob demanda.",
    custo: "Cobrado por imagem gerada: bem mais que uma chamada de texto curta. A entrada é pequena; a reescrita, se ligada, é uma chamada de texto curta a mais.",
    fallback: "Se o modelo não devolver imagem ou a moderação recusar, a tela mostra o erro (com a sugestão de trocar o modelo) e nada é salvo. Reescrita que falha: vai o pedido original.",
  }),
  n("s_out", X[2], -130, "code", "Imagem salva na cena", "scene_images", {
    oque: "A imagem fica guardada no Postgres, ligada à cena, e a última aparece na ficha da tela da campanha.",
  }),

  n("a_btn", X[3], -250, "player", "Criar com IA", "nova campanha, passo Mundo", {
    oque: "No assistente de campanha nova, o jogador escolhe criar a aventura (a mecânica do RPG) conversando, em vez de usar um preset ou importar um JSON.",
  }),
  n("a_adv", X[4], -250, "adv", "Criador de aventuras", "entrevista em linguagem natural", {
    oque: "Faz 1 ou 2 perguntas por vez sobre o universo, o tom e como o poder funciona, deduz pela obra o óbvio e vai preenchendo o JSON da mecânica (atributos, barras, tipos e níveis de habilidade, cargos, progressão, tema visual) com o Naruto como exemplo. O jogador nunca vê o JSON.",
    quando: "A cada resposta do jogador na entrevista.",
    freq: "De 3 a 10 chamadas por aventura.",
    custo: "Grátis com o modelo padrão (o mesmo do Mestre), mas lento: 1 a 2 min por resposta.",
    fallback: "O rascunho fica salvo e pode ser retomado. Se o modelo diz que acabou com pendências, ou o JSON vem ilegível, o servidor pede um conserto uma vez sem envolver o jogador.",
  }),
  n("a_out", X[3], -130, "code", "Mecânica validada", "baixar JSON ou iniciar", {
    oque: "O rascunho passa pela validação (keys, faixas, custos, kit, tema) e pela normalização da mecânica. O jogador baixa o JSON ou inicia a campanha com ele, como no Importar mecânica.",
  }),

  // --- turno ---
  n("t_player", X[0], 60, "player", "Ação do jogador", "texto, opção ou Continuar", {
    oque: "O jogador digita uma ação, clica numa opção (do Mestre ou das Ações rápidas) ou aperta Continuar, que manda “(continuar a cena)”: essa ação fica salva mas não aparece no chat, e o Mestre a recebe trocada por uma nota de sistema. Antes de qualquer IA rodar, o código tira uma foto do estado e salva a mensagem no histórico da cena. Gerar novamente (com motivo opcional) e o lápis na última ação voltam à foto e rodam o turno de novo, com a mesma ação ou com o texto editado.",
    quando: "A cada turno.",
  }),
  n("t_suggest", X[0], 230, "suggest", "Ações rápidas", "4 a 5 ações para o momento", {
    oque: "Propõe de 4 a 5 ações curtas, em primeira pessoa, a partir do cenário, da cena (modo, local, título, fim do resumo), da ficha do jogador (recursos, técnicas com o custo, itens), dos NPCs em cena, das opções que o Mestre já ofereceu (para não repetir) e das últimas 6 mensagens. Não narra nem muda nada: as opções aparecem no lugar das do Mestre; clicar envia como ação, o lápis edita antes.",
    quando: "Só quando o jogador clica em Ações rápidas, no campo da ação.",
    freq: "1 chamada por clique.",
    custo: "Baixo: modelo barato e rápido (Gemini Flash, raciocínio baixo), saída de até 1,5 mil tokens.",
    fallback: "Erro ou resposta fora do formato: aviso na tela e as opções do Mestre continuam.",
  }),
  n("t_mem", X[1], 60, "code", "Memórias candidatas", "6 parecidas + 8 importantes", {
    oque: "Sem IA: busca no Postgres as 6 memórias mais parecidas com a ação (vetorial no pgvector, ou por texto se não houver embeddings) e junta as 8 de maior importância e mais recentes, sem repetir. Com embeddings, junta também até 2 trechos antigos do chat (fora da janela recente) muito parecidos com a ação, que só entram se o Jev aprovar com folga. Também lê o histórico recente não compactado (janela de ≈9 mil tokens, cujo começo anda em saltos de 1/4 dela, para o cache valer de um turno para o outro).",
    quando: "No início do turno, antes de a ação ser salva (o Jev ainda decide se é turno).",
    custo: "Dois embeddings da ação (baratos) e consultas SQL.",
  }),
  n("t_jev", X[2], 60, "jev", "Jev: decide o turno", "modelo, web, memórias, Árbitro, fora do jogo", {
    oque: "Uma única chamada devolve probabilidades, não texto: (1) turno complexo? Escolhe entre o modelo do Mestre e o caro de turnos complexos (se configurado). (2) Precisa de busca web (:online)? Só quando o turno depende de um fato do cânone que não está no contexto. (3) Cada memória candidata é relevante? As de importância 5 entram sem perguntar. (4) A ação usa uma técnica da ficha do jogador ou é treino? Se sim, o Árbitro resolve antes do Mestre. (5) É o jogador perguntando ou reclamando do registro (ficha, itens, missões, XP, relógio, regras), não uma ação do personagem? Se sim, não há turno: a fala vai ao Mestre fora do jogo, que responde (e corrige) na conversa fora do jogo, e nada entra no chat da história. Os limiares ficam nas Configurações avançadas.",
    quando: "No início de cada turno, depois das candidatas. No Continuar sem nada a perguntar (sem modelo caro, sem web, sem memórias), nem é chamado.",
    freq: "No máximo 1 request por turno para esta decisão (depois da narração há outras: relógio, local e elenco).",
    custo: "Mínimo: cerca de US$ 0,00005 e ≈0,4 s por chamada; saída só em probabilidades.",
    fallback: "Timeout de 7 s. Qualquer falha: modelo padrão do Mestre, web conforme a configuração dele, todas as memórias entram e o turno segue normal.",
  }),
  n("t_referee", X[2], 230, "referee", "Árbitro", "técnica da ficha ou treino", {
    oque: "Quando o Jev diz que a ação é usar uma técnica da ficha ou treinar, resolve antes do Mestre, sempre para o personagem do jogador: use_ability com a CD escolhida pela ficção, train com horas realistas e roll_dice para o dano de técnica que passou no teste. Vê a ficha do jogador, os NPCs em cena, as regras da mesa (escala de CD), as regras de treino, a hora, a última narração e a ação. As ferramentas rodam no mesmo contexto do turno: dados, chips e domínio saem iguais aos do Mestre. O resultado entra no contexto do turno (JÁ RESOLVIDO NESTE TURNO) e o Mestre narra numa chamada só; se ele chamar de novo a mesma técnica ou treino, recebe o resultado pronto sem executar. Técnica fora da ficha, ação ambígua ou que depende de decisão do Mestre: não chama nada.",
    quando: "Antes do Mestre, só nos turnos em que o Jev aprovou (técnica da ficha ou treino).",
    freq: "No máximo 1 chamada por turno.",
    custo: "Baixo: modelo barato, raciocínio baixo, ≈2 mil tokens de entrada. Economiza a 2ª rodada do Mestre (≈20 mil tokens) que use_ability e train forçavam.",
    fallback: "Jev falhou ou disse não: o Árbitro não roda e o Mestre resolve como antes. Ferramenta com erro fica para o Mestre.",
  }),
  n("t_ctx", X[3], 60, "code", "Montagem do contexto", "ficha, cena, NPCs, roteiro", {
    oque: "Sem IA, em três partes, na ordem que aproveita o cache: (1) o fixo da campanha: prompt do Mestre, estilo e mecânica (com o padrão de nomes das técnicas do mundo); (2) o histórico recente; (3) o contexto do turno, numa mensagem logo antes da ação: regras da mesa, cena atual com hora e MODO DA CENA (o texto do modo, ajustável na Mesa), resumo compactado (na cena nova ainda sem resumo, o fim do da anterior), missões e prazos, local, rotas e palco do mapa, ficha do jogador e dos NPCs em cena (técnicas completadas pela biblioteca, com o custo calculado e a marca de INCOMPLETA ou de fora da biblioteca; efeito e requisito cortados em 160 caracteres e o passado em 300; o completo sai no get_character), arco ativo do roteiro, só as memórias e trechos antigos aprovados pelo Jev, o que o Escrivão registrou depois da narração anterior e as diretrizes do jogador.",
    quando: "Antes de cada turno do Mestre.",
  }),
  n("t_gm", X[4], 60, "gm", "Mestre", "narra e arbitra", {
    oque: "Narra o mundo, arbitra as regras, controla o relógio e altera o jogo por ferramentas. Usa o modelo escolhido pelo Jev, mantido em todas as rodadas do turno. A narração vai ao jogador em streaming. No Continuar, segue a cena sem o personagem agir (ou, se a narração anterior esperava algo dele, responde só com uma linha curta de que a cena aguarda).",
    quando: "Em cada turno do jogador, em loop com as ferramentas.",
    freq: "1 a 9 chamadas por turno. Termina quando responde só com texto, ou com a narração e só anotações (relógio, cena, elenco, cargo, roteiro, missão, mapa), que rodam depois dela sem outra chamada.",
    custo: "O mais caro: cada rodada reenvia prompt, ficha, memórias, histórico (até ≈9 mil tokens) e as definições das ferramentas. A busca web (:online) vale só na 1ª rodada e é cobrada por busca.",
  }),
  n("t_tools", X[5], 60, "code", "Ferramentas", "dados, ficha, cena, delegações", {
    oque: "Executadas pelo código a pedido do Mestre: rolar dados, resolver (cobrando o custo calculado) e treinar técnicas, atributos, ligar técnica na ficha pela biblioteca (add_ability) e corrigir a técnica na biblioteca do mundo (edit_ability), criar NPC, mensagem de NPC ao jogador (npc_message), relógio (advance_time, set_time), buscar memórias, buscar no chat inteiro da campanha (search_history: trechos curtos com dia, hora e local), consultar livros, ficha, roteiro e biblioteca, mandar o brief do mapa (map_brief). Dano, itens, XP, memórias e missões não estão aqui: ficam com o Escrivão. As escritas vão direto ao Postgres; criar NPC, técnica nova e mapa são delegados (lane 4). As anotações (advance_time, set_scene, set_npc_active, set_rank, update_script, note_objective, map_brief) respondem \"Anotado\" na hora e só rodam depois da narração.",
    quando: "Sempre que o Mestre pedir, em qualquer rodada.",
    custo: "Sem IA: só SQL (e embeddings ao gravar ou buscar memórias e histórico).",
  }),
  n("t_fx", X[4], 230, "code", "Efeitos persistidos", "narração e opções salvas", {
    oque: "A narração e o bloco de opções são salvos e enviados ao jogador. Depois, antes do fim do turno: primeiro as anotações do Mestre (só SQL); então, em paralelo, a compactação (Cronista, se estourou o limite), cada map_brief (Topógrafo), o relógio seguido do Escrivão e o local seguido do elenco. Relógio: só se o Mestre não chamou advance_time, set_time nem train, o Jev estima o tempo que passou. Local e modo: se o Mestre não abriu cena nem trocou o local, o Jev julga numa chamada se o jogador mudou de lugar e que modo a narração mostra; mudou, o Cronista dá o nome e abre cena nova ali, já no modo novo; ficou, só o modo muda (se o Mestre não o trocou). Elenco: o Jev diz quem dos NPCs calados ainda está na cena. Por fim, o turno entra no histórico vetorial (search_history).",
    quando: "Quando o Mestre responde só com texto, ou com texto e só anotações (ou estoura as rodadas).",
  }),
  n("t_chron", X[3], 230, "chron", "Cronista: compacta", "só se estourar o limite", {
    oque: "Resume as mensagens antigas ainda não compactadas (todas menos as 12 mais recentes) num resumo acumulado na cena, marca-as como compactadas e extrai memórias estruturadas: evento, NPC, descoberta, marco, relação.",
    quando: "Depois da narração, se as mensagens não compactadas passam de ≈11 mil tokens.",
    freq: "De vez em quando (estimativa: 1 a cada 10 a 15 turnos). Também roda 1 vez por conversa com NPC.",
    custo: "Baixo: modelo barato, mas lê de uma vez todo o trecho antigo (≈11 mil tokens de entrada).",
  }),
  n("t_scribe", X[1], 230, "scribe", "Escrivão", "registra o que a narração mostrou", {
    oque: "Lê a ação, a narração, o que as ferramentas do Árbitro e do Mestre já fizeram, as fichas, as diretrizes do jogador (segue as de registro), a hora, as missões e a regra de XP da mesa (Mesa > Ganho de XP), e registra só o que a narração estabeleceu: dano, cura e gasto, itens, XP (técnica nova aprendida também dá), domínio por evento, campos da ficha, memórias e missões (as anotações de missão do Mestre viram objetivos com o prazo certo). Quem fala na narração (**Nome:**) sem estar registrado chega a ele numa lista: registra com create_npc quem é personagem com nome e ignora título, cabeçalho ou cargo genérico; a narração nunca volta ao Mestre. Uma chamada com as ferramentas em paralelo. O que gravou fica junto da narração (meta.notes) e entra no contexto do turno seguinte, para o Mestre reconhecer na história o que for marcante (marco de domínio, nível novo); o “gerar novamente” apaga junto.",
    quando: "Depois de cada narração, logo depois do relógio (do Jev, quando é ele quem anda com o tempo), antes do fim do turno.",
    freq: "1 chamada por turno (2 se alguma ferramenta deu erro).",
    custo: "Baixo: modelo barato e rápido, ≈3 mil tokens de entrada; ~US$ 0,001 e 1 a 3 s.",
    fallback: "Se falhar, nada é registrado; o jogador corrige pedindo ao Mestre fora do jogo.",
  }),
  n("t_imp", X[3], 400, "jev", "Jev: nota de importância", "1 a 5, em lote", {
    oque: "Dá a nota de 1 a 5 de todas as memórias extraídas numa única chamada. Nota 5 entra sempre no contexto; as demais disputam as vagas por importância.",
    quando: "Logo depois que o Cronista extrai memórias (compactação ou fim de conversa com NPC).",
    freq: "1 request por lote de memórias.",
    custo: "Mínimo: cerca de US$ 0,00005 e ≈0,4 s por chamada; saída só em probabilidades.",
    fallback: "Se falhar, vale a nota que o Cronista escreveu.",
  }),
  n("pg", X[5], 230, "db", "Postgres + pgvector", "memórias, fichas, mensagens", {
    oque: "Guarda tudo: campanhas, cenas, fichas, mensagens, memórias (com embeddings para busca por similaridade), roteiro, conversas de NPC, imagens e o log de cada chamada de IA (tokens, custo, duração).",
    custo: "Local (Docker). Nenhuma chamada paga; só os embeddings das memórias passam pelo OpenRouter.",
  }),
  n("or", X[5], -250, "infra", "OpenRouter e outras fontes", "toda IA passa por aqui", {
    oque: "Todas as chamadas de IA (Jev, Mestre, Escrivão, Ações rápidas, NPC, Cronista, Roteirista, Ilustrador, Voz, Topógrafo e os criadores) saem pela fonte de modelos do agente: o OpenRouter (padrão) ou outra fonte cadastrada em Fontes de modelos (OpenAI, Anthropic, Gemini, OpenCode, outra API compatível com a da OpenAI ou o Login com ChatGPT). Cada chamada vira uma linha no histórico do agente: fonte, tokens, duração, custo, request e resposta. O Jev usa a Decisions API (probabilidades), a Voz o endpoint de fala (audio/speech) e os demais, chat completions (modelo que só gera imagem vai pelo endpoint de imagens).",
    custo: "Você paga o preço do modelo escolhido em cada agente, direto à fonte. Só o OpenRouter informa o custo de cada chamada; das outras ficam os tokens.",
  }),

  // --- NPC ---
  n("n_player", X[0], 600, "player", "Jogador fala com o NPC", "conversa particular", {
    oque: "Conversa fora da narração do Mestre. O histórico fica guardado por sessão de conversa. A sessão também pode ser aberta pelo NPC: o Mestre manda npc_message (mensagem curta e um motivo oculto), que chega na caixa de entrada; se o jogador responde, a conversa segue com o agente do NPC, que sabe por que chamou.",
    quando: "A cada mensagem do jogador ao NPC.",
  }),
  n("n_jev", X[1], 600, "jev", "Jev: o NPC topa?", "só no início da conversa", {
    oque: "Decide se o NPC toparia conversar agora, olhando persona, objetivos, relação com o jogador, cena e se o NPC está presente.",
    quando: "Antes da 1ª chamada do NPC da sessão (histórico vazio). Uma troca recusada não é gravada: se o jogador insistir, a checagem roda de novo. No meio de uma conversa aceita não há checagem: o NPC pode cortar sozinho, em personagem. Sessão aberta pelo NPC (npc_message) não passa pela checagem.",
    freq: "1 request no início de cada conversa.",
    custo: "Mínimo: cerca de US$ 0,00005 e ≈0,4 s por chamada; saída só em probabilidades.",
    fallback: "Se falhar, o NPC conversa normalmente.",
  }),
  n("n_npc", X[2], 600, "npc", "NPC responde", "persona + memórias da relação", {
    oque: "Interpreta o NPC em primeira pessoa com persona, ficha, cenário, cena atual, as 8 memórias mais ligadas ao NPC, o motivo (se foi ele quem chamou) e as últimas 30 mensagens da conversa. A troca é gravada e entra no histórico vetorial (search_history do Mestre).",
    quando: "A cada mensagem do jogador, depois do aval do Jev.",
    freq: "1 chamada por mensagem.",
    custo: "Baixo: contexto pequeno e resposta curta (máx. 700 tokens).",
  }),
  n("n_no", X[2], 730, "npc", "NPC recusa em personagem", "troca não gravada", {
    oque: "É a mesma chamada do NPC, com uma instrução extra no prompt: recusar em personagem, numa fala curta. Substitui o antigo prefixo [RECUSA]. A tela recebe refused=true e a troca não é gravada.",
    quando: "Quando o Jev diz que o NPC não toparia conversar agora.",
    custo: "O mesmo de uma resposta normal do NPC.",
  }),
  n("n_end", X[3], 600, "player", "Encerrar a conversa", "botão de encerrar", {
    oque: "Ao encerrar, a conversa vira memória da campanha: o Mestre passa a saber o essencial, e o NPC continua lembrando de tudo.",
  }),
  n("n_chron", X[4], 600, "chron", "Cronista: extrai memórias", "1 vez por conversa", {
    oque: "Lê a conversa inteira e guarda só o que o Mestre precisa saber (revelações, acordos, mudanças de relação) como memórias de tipo npc ou relationship. Só roda se houve ao menos uma troca.",
    quando: "Ao encerrar a conversa com o NPC, em segundo plano (o modal fecha na hora e o cabeçalho mostra a tarefa).",
    freq: "1 chamada por conversa.",
    custo: "Baixo: modelo barato; a entrada é a conversa toda.",
  }),
  n("n_imp", X[5], 600, "jev", "Jev: nota de importância", "1 a 5, em lote", {
    oque: "Dá a nota de 1 a 5 das memórias extraídas da conversa, numa única chamada.",
    quando: "Logo depois que o Cronista extrai as memórias.",
    freq: "1 request por conversa.",
    custo: "Mínimo: cerca de US$ 0,00005 e ≈0,4 s por chamada; saída só em probabilidades.",
    fallback: "Se falhar, vale a nota que o Cronista escreveu.",
  }),

  // --- criação em segundo plano ---
  n("c_gm", X[0], 930, "gm", "Mestre: create_npc", "nome, sexo, canon e brief", {
    oque: "O Mestre só registra quem entrou na história (se esquecer, o Escrivão registra depois da narração): nome, sexo, se é do cânone e um brief (quem é, papel, o que já foi narrado). Não escreve a ficha.",
    quando: "Antes de narrar, quando um personagem com nome aparece pela primeira vez.",
  }),
  n("c_reg", X[1], 930, "code", "NPC registrado na hora", "ativo na cena, o turno segue", {
    oque: "Sem IA: grava o NPC ativo na cena (o brief vira o passado provisório) e responde ao Mestre na hora, para a checagem de quem fala passar. Abre uma tarefa em segundo plano, que aparece no cabeçalho do jogo e avisa quando termina.",
    custo: "Só SQL (≈5 ms).",
  }),
  n("c_char", X[2], 930, "char", "Criador de personagens", "perfil rico e ficha", {
    oque: "Lê a mecânica (com o padrão de nomes do mundo), o mundo (premissa, arco, cena, NPCs) e os nomes da biblioteca e devolve aparência, idade, papel, personalidade, jeito de falar, passado, objetivos, segredos, relações e manias, mais atributos, recursos, cargo, técnicas (de preferência as da biblioteca, com o nome exato; nova só no padrão de nomes) e itens coerentes com o poder. Cada técnica vira ref pela mesma regra do add_ability: a do mundo pelo nome; senão o Criador de habilidades a cria (sem prazo); se ele falhar, entra incompleta com a definição do Criador de personagens. Personagem do cânone: fiel à obra no ponto da história.",
    quando: "Em segundo plano, depois de cada create_npc de NPC novo e no botão Refazer perfil do modal do NPC.",
    freq: "1 chamada por NPC novo.",
    custo: "Grátis com o modelo padrão (o mesmo do Mestre); leva de 1,5 a 4 min.",
    fallback: "O NPC fica com o brief do Mestre e a tela avisa; o botão Refazer perfil tenta de novo.",
  }),
  n("c_merge", X[3], 930, "code", "Ficha gravada com merge", "preserva o que o Mestre mudou", {
    oque: "Sem IA: grava o perfil e a ficha com a linha travada. O que o Mestre mudou nesse meio tempo (dano, gasto, cargo, sexo) fica como ele deixou; técnicas se somam pela ref da biblioteca e itens por nome; a ficha é gravada só com ref e domínio.",
  }),
  n("c_pix", X[4], 930, "img", "Ilustrador", "retrato do personagem", {
    oque: "Pinta o retrato de busto do personagem com o modelo de imagem, a partir do cenário, do momento da história (arco ativo), do cargo, dos campos da ficha e da aparência. O estilo fixado no card do Ilustrador (vazio = pixel art 16-bit) vai no começo; com “Reescrever o prompt” ligado, um modelo de texto reescreve o pedido curto e em inglês antes. Só com a geração de imagens ligada nas Configurações; desligada, o botão avisa e nada é gerado.",
    quando: "Só nos botões Gerar e Regerar retrato (modal do NPC ou ficha).",
    freq: "1 imagem por clique.",
    custo: "Cobrado por imagem gerada, cerca de US$ 0,03 por retrato.",
    fallback: "A tarefa vira erro com aviso; o personagem mostra as iniciais e o botão Regerar.",
  }),
  n("c_out", X[5], 930, "code", "Retrato salvo", "NPCs, modal, ficha e falas", {
    oque: "O retrato fica no Postgres com versão (cache longo no navegador) e aparece nos cartões de NPC, no modal, na ficha do jogador e ao lado das falas no chat.",
  }),

  n("b_gm", X[0], 1050, "gm", "Mestre: add_ability", "nome e brief → ref na ficha", {
    oque: "Quando o personagem aprende ou usa uma técnica que ainda não está na ficha, o Mestre só passa o nome e um brief (tipo, rank e costFree só como dica). O código procura no mundo pelo nome (sem diferenciar maiúsculas e acentos, sem as excluídas); se não acha, chama o Criador de habilidades; se ele falha ou passa do prazo, grava na biblioteca o que o Mestre passou, marcada como incompleta. A ficha sempre recebe a ref; se a técnica já estava nela, só ajusta o domínio. Antes de inventar, pode consultar a biblioteca (search_library). add_item completa a descrição pelo item da biblioteca.",
    quando: "No turno, antes de resolver uma técnica que não está na ficha; também no fora do jogo.",
    fallback: "A incompleta aparece ao Mestre marcada (na ficha e no search_library) para ele completar com edit_ability.",
  }),
  n("b_lib", X[1], 1050, "db", "Biblioteca do mundo", "fonte única das técnicas", {
    oque: "A única descrição de cada técnica: nome no padrão do mundo, tradução, tipo, rank, costFree, efeito, dano, requisitos, marcos e quem usa. Não guarda o valor do custo: só a faixa de consumo e a unidade (o valor é regra do mundo e o ajuste é de quem usa). Também os itens. É por mundo (Ruleset.world, ex.: naruto), não por campanha: as campanhas do mesmo mundo usam as mesmas entradas, e cada nome existe uma vez por mundo. Excluir na aba Biblioteca é soft delete: some da lista e da busca, mas quem já tem continua tendo, marcada como fora da biblioteca. Fonte do add_ability, do add_item e do Criador de personagens.",
    custo: "Local (Postgres).",
  }),
  n("b_abil", X[2], 1050, "abil", "Criador de habilidades", "técnica nova, validada", {
    oque: "Cria a técnica seguindo a mecânica da campanha (tipos, ranks, recursos, faixas de domínio), o cânone e o padrão de nomes do mundo (abilityNaming; no Naruto, o nome romanizado oficial, com a tradução à parte). Não define o valor do custo: só costFree, a faixa de consumo do mundo (pela energia que gasta, não pelo rank) e a unidade, se o gasto é por unidade. O código valida tipo, rank, dano e marcos e guarda na biblioteca do mundo. Com padrão de nomes vale o nome do Criador, que pode ser outro que o do Mestre (e já estar na biblioteca).",
    quando: "Na hora, quando o add_ability ou o Criador de personagens liga uma técnica que não está no mundo; em lotes, quando o jogador pede.",
    freq: "1 chamada por técnica nova; lotes de 6 até chegar ao total pedido.",
    custo: "Grátis com o modelo padrão; 70 a 120 s por chamada.",
    fallback: "No add_ability o prazo é 90 s: falhou ou estourou, a técnica entra incompleta com o que o Mestre passou; se o Criador responde depois, a resposta completa essa mesma entrada (que as fichas já apontam). No Criador de personagens não há prazo; se falhar, entra incompleta com a definição dele.",
  }),
  n("b_player", X[3], 1050, "player", "Gerar biblioteca", "aba Biblioteca ou Fora do jogo", {
    oque: "O jogador pede N técnicas ou itens com um foco (ex.: jutsus canônicos de Konoha até o Exame Chūnin), pela aba Biblioteca ou pedindo ao Mestre fora do jogo. O que entra vale para todas as campanhas do mesmo mundo.",
  }),
  n("b_items", X[4], 1050, "items", "Criador de itens", "ferramentas, armas, consumíveis", {
    oque: "Cria itens e equipamentos do mundo em lotes, recebendo os nomes que já existem para não repetir. O código valida e descarta repetidos.",
    quando: "Em lotes, quando o jogador pede.",
    freq: "Lotes de 6 até o total; para depois de 2 lotes sem nada novo.",
    custo: "Grátis com o modelo padrão.",
  }),
  n("b_jobs", X[5], 1050, "code", "Tarefas em segundo plano", "indicador no cabeçalho", {
    oque: "Perfis, retratos, lotes da biblioteca e mapas rodam fora do turno. O cabeçalho do jogo mostra o que está rodando (com progresso) e, quando termina, a tela recarrega e avisa. Duas tarefas iguais não rodam juntas.",
    fallback: "Se o servidor reinicia no meio, a tarefa vira erro depois de 15 min sem sinal.",
  }),

  n("b_edit", X[0], 1210, "gm", "Mestre: edit_ability", "no turno e fora do jogo", {
    oque: "Corrige a técnica na biblioteca do mundo (tipo, rank, efeito, dano, marcos, quem usa, costFree, tradução ou o nome, no padrão do mundo), mandando só o que muda. Como as fichas apontam pela ref, vale na hora para todos que a têm, em todas as campanhas do mesmo mundo. Completar uma incompleta é editá-la (sai a marca). O que é de um personagem só não passa por aqui: domínio é update_ability_progress, gastar mais ou menos é set_cost_modifier e tirar da ficha é remove_ability (fora do jogo).",
    quando: "Técnica incompleta ou errada: o Mestre no turno, ou o Mestre fora do jogo a pedido do jogador.",
    custo: "Sem IA: só SQL.",
    fallback: "Nome que já existe no mundo ou tipo inválido: a edição é recusada com o motivo e nada muda.",
  }),
  n("b_sheet", X[1], 1210, "code", "Ficha: ref + domínio", "completada na leitura", {
    oque: "Sem IA: a ficha de cada personagem (jogador e NPC) guarda só a ligação com a entrada da biblioteca (ref) e o domínio. Toda leitura completa as técnicas pela biblioteca numa consulta só (as excluídas vêm marcadas como fora da biblioteca) e toda gravação volta a reduzir a ref e domínio. O custo é calculado na hora: o valor da faixa de consumo da técnica (ou, sem faixa, o do rank) nas regras do mundo (abilityCosts) × as unidades, se a técnica custa por unidade × o multiplicador geral do personagem (costMult da ficha) × o da técnica para ele (costMult do vínculo) × o do domínio, ou 0 se costFree; é o que as telas e o Mestre veem e o que o use_ability cobra. A ficha guarda ref, domínio e, se houver, o costMult do vínculo.",
  }),
  n("b_new", X[2], 1210, "player", "Criar campanha", "kit inicial e extras", {
    oque: "Sem IA: o kit do rank inicial (startingAbilities) e as técnicas extras da tela entram na biblioteca do mundo (a que já existe pelo nome é reaproveitada) e a ficha do jogador recebe as refs com o domínio. Mecânica sem world ganha o slug do nome, fixo desde a criação.",
    quando: "Ao criar a campanha.",
  }),

  n("m_gm", X[0], 1330, "gm", "Mestre: map_brief", "o que mudou no espaço", {
    oque: "No lugar das ferramentas do mapa, o Mestre manda uma frase: começo e movimentos de uma luta (quem está onde, distância, cobertura), um lugar de que o jogador ouviu falar, um lugar que merece mapa 3D. Não espera o resultado para narrar. Os lugares visitados entram no mapa do mundo sozinhos pelo set_scene.",
  }),
  n("m_surv", X[1], 1330, "surv", "Topógrafo", "brief → ferramentas do mapa", {
    oque: "Lê o brief com o estado do mapa (local, rotas, palco, mapas 3D, quem está em cena) e chama as ferramentas: set_stage (zonas e posições do palco), update_map (lugar conhecido, direção, distância, rota) e local_map (pede ao Cartógrafo gerar ou editar o mapa 3D de um lugar; não regera um mapa que já existe, e a iniciativa pode ser desligada nas Configurações). Os pontos de interesse do mapa 3D viram as zonas do palco.",
    quando: "Quando o Mestre manda um map_brief (em batalha, no começo e a cada movimento relevante): é uma anotação, roda depois da narração, em paralelo com o Escrivão, já no local que o set_scene marcou.",
    freq: "1 chamada por brief; poucas por campanha fora de batalha.",
    custo: "Modelo barato e rápido: ~3 mil tokens de entrada, cerca de US$ 0,002 e poucos segundos por brief. Tira ~1,6 mil tokens de cada chamada do Mestre.",
    fallback: "Erro em uma ferramenta não derruba o turno; o palco e o mapa ficam como estavam.",
  }),
  n("m_btn", X[2], 1450, "player", "Botões da aba Mapa", "gerar, regerar, editar, remover", {
    oque: "O jogador pode pedir o mapa de qualquer lugar por onde passou, regerar, editar com uma instrução ou remover.",
  }),
  n("m_carto", X[2], 1330, "carto", "Cartógrafo", "mapa 3D de um lugar", {
    oque: "Compõe a maquete 3D de um lugar a partir da obra, da narração e da cena: relevo, contornos extrudados, caminhos e rios, espalhamento de árvores e casas, materiais, luz do horário e pontos de interesse. Devolve uma descrição declarativa, nunca código.",
    quando: "Quando o Mestre ou o jogador pede gerar ou editar o mapa de um lugar.",
    freq: "1 chamada por geração ou edição; um mapa desenhado por vez.",
    custo: "Opus 5.5 com raciocínio médio: o mais caro dos criadores. Cerca de US$ 0,14 e 1 min por mapa novo; US$ 0,18 por edição (recebe o mapa atual compacto).",
    fallback: "A tarefa vira erro com aviso; o mapa anterior (se houver) continua.",
  }),
  n("m_spec", X[3], 1330, "code", "Mapa validado", "limites, cores, contagens", {
    oque: "Sem IA: o código valida e limita o que o Cartógrafo devolveu (quantidades, faixas, cores) e guarda o mapa ligado ao lugar do mapa do mundo.",
  }),
  n("m_view", X[4], 1330, "code", "Aba Mapa", "o da cena em destaque", {
    oque: "Mostra em destaque o mapa 3D do lugar da cena atual (girar, zoom, pontos clicáveis) e a galeria dos mapas dos outros lugares por onde o jogador passou. O diorama do mundo continua na visão Mundo.",
  }),
];

// ---------- setas ----------
const colorOf = (id: string) => {
  const nd = NODES.find((x) => x.id === id) as FlowNode | undefined;
  return nd ? COLOR[nd.data.who] : COLOR.code;
};

function e(
  s: string,
  sh: string,
  t: string,
  th: string,
  label?: string,
  opts: { both?: boolean; dashed?: boolean } = {}
): Edge {
  const color = colorOf(s);
  return {
    id: `${s}-${t}`,
    source: s,
    sourceHandle: sh,
    target: t,
    targetHandle: th,
    type: "smoothstep",
    label,
    markerEnd: { type: MarkerType.ArrowClosed, color, width: 18, height: 18 },
    markerStart: opts.both ? { type: MarkerType.ArrowClosed, color, width: 18, height: 18 } : undefined,
    style: { stroke: color, strokeWidth: 1.6, strokeDasharray: opts.dashed ? "5 4" : undefined },
    labelStyle: { fill: "var(--text)", fontSize: 11 },
    labelBgStyle: { fill: "var(--bg-panel)", stroke: "var(--border)" },
    labelBgPadding: [6, 3],
    labelBgBorderRadius: 6,
  };
}

const EDGES: Edge[] = [
  // turno
  e("t_player", "sr", "t_mem", "tl"),
  e("t_mem", "sr", "t_jev", "tl", "candidatas"),
  e("t_jev", "sr", "t_ctx", "tl", "aprovadas"),
  e("t_jev", "sb", "t_referee", "tt", "técnica ou treino"),
e("t_jev", "st", "o_gm", "tb", "pergunta sobre o registro", { dashed: true }),
  e("t_referee", "sr", "t_ctx", "tb", "já resolvido"),
  e("t_ctx", "sr", "t_gm", "tl"),
  e("t_gm", "sr", "t_tools", "tl", "ferramentas ⇄", { both: true }),
  e("t_gm", "sb", "t_fx", "tt", "só texto"),
  e("t_fx", "sl", "t_chron", "tr", "estourou o limite"),
  e("t_fx", "sb", "t_scribe", "tb", "depois da narração"),
  e("t_scribe", "sb", "pg", "tb", "grava fichas e missões"),
  e("t_chron", "sb", "t_imp", "tt", "memórias"),
  e("t_imp", "sr", "pg", "tb", "grava memórias"),
  e("t_tools", "sb", "pg", "tt", "grava ficha, cena, memórias"),
  e("t_fx", "sr", "pg", "tl", "grava narração"),
  e("t_gm", "st", "or", "tb", "toda IA", { dashed: true }),
  e("t_suggest", "st", "t_player", "tb", "opções"),
  e("t_scribe", "st", "t_ctx", "tb", "o que gravou, no próximo turno", { dashed: true }),
  // NPC
  e("n_player", "sr", "n_jev", "tl"),
  e("n_jev", "sr", "n_npc", "tl", "topa"),
  e("n_jev", "sb", "n_no", "tl", "não topa"),
  e("n_npc", "sr", "n_end", "tl", "até encerrar"),
  e("n_end", "sr", "n_chron", "tl"),
  e("n_chron", "sr", "n_imp", "tl", "memórias"),
  e("n_imp", "st", "pg", "tb", "grava memórias"),
  // sob demanda
  e("s_btn1", "sr", "s_writer", "tl"),
  e("s_writer", "sr", "s_script", "tl", "JSON"),
  e("s_script", "sr", "t_ctx", "tl", "arco ativo"),
  e("s_btn2", "sr", "s_img", "tl"),
  e("s_img", "sr", "s_out", "tl", "imagem"),
  e("v_btn", "sr", "v_voice", "tl"),
  e("o_btn", "sr", "o_gm", "tl", "conversa ⇄", { both: true }),
  // aventura
  e("a_btn", "sr", "a_adv", "tl", "conversa ⇄", { both: true }),
  e("a_adv", "sb", "a_out", "tr", "JSON"),
  // criação em segundo plano
  e("c_gm", "sr", "c_reg", "tl"),
  e("c_reg", "sr", "c_char", "tl", "tarefa"),
  e("c_char", "sr", "c_merge", "tl", "JSON"),
  e("c_merge", "sr", "c_pix", "tl", "botão de retrato", { dashed: true }),
  e("c_pix", "sr", "c_out", "tl", "imagem"),
  e("c_char", "sb", "b_lib", "tt", "liga por ref"),
  e("b_gm", "sr", "b_lib", "tl", "procura no mundo"),
  e("b_lib", "sr", "b_abil", "tl", "não existe ⇄ guarda", { both: true }),
  e("b_lib", "sb", "b_sheet", "tt", "completa a ficha"),
  e("b_edit", "st", "b_lib", "tb1", "edita para o mundo"),
  e("b_new", "st", "b_lib", "tb2", "kit e extras"),
  e("b_new", "sl", "b_sheet", "tr", "refs"),
  e("b_player", "sl", "b_abil", "tr", "N com foco"),
  e("b_player", "sr", "b_items", "tl", "N com foco"),
  e("b_items", "sb", "b_lib", "tb2"),
  e("m_gm", "sr", "m_surv", "tl", "brief"),
  e("m_surv", "sr", "m_carto", "tl", "local_map"),
  e("m_btn", "st", "m_carto", "tb", "botões"),
  e("m_carto", "sr", "m_spec", "tl", "JSON"),
  e("m_spec", "sr", "m_view", "tl"),
];

// ---------- componentes dos nós ----------
const hidden: CSSProperties = { opacity: 0, pointerEvents: "none" };
// b1/b2: pontos extras embaixo (20% e 80%), para mais de uma seta sair ou chegar por baixo sem se sobrepor
const SIDES: [string, Position, string?][] = [
  ["t", Position.Top],
  ["b", Position.Bottom],
  ["b1", Position.Bottom, "20%"],
  ["b2", Position.Bottom, "80%"],
  ["l", Position.Left],
  ["r", Position.Right],
];

function FlowNodeView({ data }: NodeProps<FlowNode>) {
  const c = COLOR[data.who];
  const infra = data.who === "db" || data.who === "infra";
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        background: "var(--bg-panel)",
        border: `1px ${infra ? "dashed" : "solid"} ${infra ? c : "var(--border)"}`,
        borderLeft: `4px solid ${c}`,
        borderRadius: 10,
        padding: "8px 10px",
        cursor: "help",
      }}
    >
      {SIDES.map(([k, pos, left]) => (
        <span key={k}>
          <Handle id={`s${k}`} type="source" position={pos} style={left ? { ...hidden, left } : hidden} />
          <Handle id={`t${k}`} type="target" position={pos} style={left ? { ...hidden, left } : hidden} />
        </span>
      ))}
      <div style={{ fontSize: 10.5, color: c, textTransform: "uppercase", letterSpacing: 0.4 }}>
        {KIND_LABEL[data.who]}
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", margin: "1px 0 2px" }}>{data.title}</div>
      <div style={{ fontSize: 11.5, color: "var(--text-dim)", lineHeight: 1.3 }}>{data.sub}</div>
    </div>
  );
}

function LaneView({ data }: NodeProps<LaneNode>) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        border: "1px dashed var(--border)",
        borderRadius: 14,
        background: "color-mix(in srgb, var(--text) 2%, transparent)",
        padding: "8px 14px",
        fontFamily: "var(--serif)",
        fontSize: 15,
        color: "var(--text-dim)",
      }}
    >
      {data.label}
    </div>
  );
}

const nodeTypes = { flow: FlowNodeView, lane: LaneView };

const THEME_CSS = `
.agents-flow .react-flow {
  --xy-background-color: var(--bg);
  --xy-controls-button-background-color: var(--bg-panel);
  --xy-controls-button-background-color-hover: var(--accent-soft);
  --xy-controls-button-color: var(--text);
  --xy-controls-button-border-color: var(--border);
  --xy-minimap-background-color: var(--bg-panel);
  --xy-minimap-mask-background-color: color-mix(in srgb, var(--bg) 70%, transparent);
  --xy-attribution-background-color: transparent;
  --xy-edge-label-background-color: var(--bg-panel);
  --xy-edge-label-color: var(--text);
}
.agents-flow { height: 680px; }
@media (max-width: 600px) { .agents-flow { height: 520px; } }
.agents-flow .react-flow__attribution a { color: var(--text-dim); }
.agents-flow .react-flow__controls { box-shadow: none; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.agents-flow .react-flow__minimap { border: 1px solid var(--border); border-radius: 8px; }
@media (max-width: 600px) { .agents-flow .react-flow__minimap { display: none; } }
`;

interface Hover {
  id: string;
  left: number;
  top?: number;
  bottom?: number;
}

/** Canvas do React Flow; carregado só quando o cartão do diagrama abre (next/dynamic em AgentsDiagram). */
export default function AgentsFlow() {
  const wrap = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);

  const show = useCallback((ev: MouseEvent, node: Node) => {
    if (node.type !== "flow" || !wrap.current) return;
    const box = wrap.current.getBoundingClientRect();
    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    const tw = Math.min(380, box.width - 16);
    const left = Math.max(8, Math.min(r.left - box.left, box.width - tw - 8));
    const lower = r.top - box.top > box.height / 2;
    // tela estreita: o balão ocupa a largura toda, no lado oposto ao do bloco
    const narrow = box.width < 600;
    setHover({
      id: node.id,
      left,
      ...(narrow
        ? lower ? { top: 8 } : { bottom: 8 }
        : lower ? { bottom: box.bottom - r.top + 8 } : { top: r.bottom - box.top + 8 }),
    });
  }, []);

  const tip = hover ? (NODES.find((x) => x.id === hover.id) as FlowNode) : null;

  return (
    <div
      ref={wrap}
      className="agents-flow"
      style={{
        position: "relative",
        marginTop: 12,
        border: "1px solid var(--border)",
        borderRadius: "var(--r-md)",
        overflow: "hidden",
      }}
    >
      <style>{THEME_CSS}</style>
      <ReactFlow
        nodes={NODES}
        edges={EDGES}
        nodeTypes={nodeTypes}
        colorMode="dark"
        fitView
        fitViewOptions={{ padding: 0.06 }}
        minZoom={0.15}
        maxZoom={2.5}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        onNodeMouseEnter={show}
        onNodeClick={show}
        onNodeMouseLeave={() => setHover(null)}
        onPaneClick={() => setHover(null)}
        onMoveStart={() => setHover(null)}
      >
        <Background color="var(--border-strong)" gap={22} />
        <Controls showInteractive={false} fitViewOptions={{ padding: 0.06 }} />
        <MiniMap
          pannable
          zoomable
          style={{ width: 150, height: 100 }}
          nodeColor={(nd) => (nd.type === "flow" ? COLOR[(nd.data as FlowData).who] : "transparent")}
        />
      </ReactFlow>
      {tip && hover && (
        <div
          role="tooltip"
          style={{
            position: "absolute",
            left: hover.left,
            top: hover.top,
            bottom: hover.bottom,
            width: Math.min(380, (wrap.current?.clientWidth ?? 400) - 16),
            background: "var(--bg-raise)",
            border: "1px solid var(--border)",
            borderTop: `3px solid ${COLOR[tip.data.who]}`,
            borderRadius: 10,
            padding: "10px 12px",
            boxShadow: "var(--shadow-2)",
            pointerEvents: "none",
            zIndex: 10,
            maxHeight: "calc(100% - 16px)",
            overflow: "hidden",
            fontSize: 12.5,
            lineHeight: 1.45,
            color: "var(--text)",
          }}
        >
          <div style={{ fontFamily: "var(--serif)", fontSize: 15, fontWeight: 600, marginBottom: 6 }}>
            {tip.data.title}
          </div>
          {TIP_LABELS.filter(([k]) => tip.data.tip[k]).map(([k, label]) => (
            <div key={k} style={{ marginBottom: 5 }}>
              <span style={{ color: COLOR[tip.data.who], fontWeight: 600 }}>{label}: </span>
              <span style={{ color: "var(--text-dim)" }}>{tip.data.tip[k]}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
