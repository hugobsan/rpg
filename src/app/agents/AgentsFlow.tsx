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
  writer: "#3fb8af",
  img: "#66bb6a",
  jev: "#60a5fa",
  db: "#4de08a",
  infra: "#9a95a8",
  char: "#fb7185",
  abil: "#ec5a55",
  items: "#f59e6b",
  adv: "#e879f9",
  scribe: "#a3e635",
  interp: "#f97316",
  voice: "#f9a8d4",
} as const;
type Who = keyof typeof COLOR;

const KIND_LABEL: Record<Who, string> = {
  player: "Jogador",
  code: "Código (sem IA)",
  gm: "Narrador",
  npc: "NPC",
  writer: "Roteirista",
  img: "Ilustrador",
  jev: "Jev",
  db: "Banco de dados",
  infra: "Infraestrutura",
  char: "Criador de personagens",
  abil: "Criador de habilidades",
  items: "Criador de itens",
  adv: "Criador de aventuras",
  scribe: "Anotador",
  interp: "Intérprete",
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
  lane("L4", 870, 480, 1570, "4. Criação em segundo plano: personagens, retratos e biblioteca do mundo"),

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
    oque: "O mesmo modelo do Mestre, com outro prompt: responde curto, sem narrar nem dar spoiler (não vê roteiro nem segredos de NPC). Vê a cena, missões, regras e modos de cena da mesa, a ficha completa, os últimos trechos da história e as diretrizes ativas. Orientação de como conduzir vira diretriz (save_directive), que entra no contexto de todo turno; dificuldade, críticos, ritmo de XP e o texto de cada modo de cena vão em set_table_rules; corrige fichas, relógio e missões com as ferramentas do turno (menos roteiro, get_character e npc_message), corrige a técnica na biblioteca do mundo com edit_ability (vale para todas as campanhas do mundo), tira técnica de uma ficha com remove_ability (a entrada fica na biblioteca) e pede lotes da biblioteca.",
    quando: "A cada mensagem na conversa fora do jogo, e quando o Jev vê no chat do jogo uma pergunta ou reclamação sobre o registro (a tela abre a conversa com a resposta).",
    freq: "1 a 4 chamadas por mensagem (outra rodada só para ler uma busca ou escrever a resposta).",
    custo: "O modelo principal do Mestre, sem Jev e sem busca web; contexto menor que o do turno.",
  }),
  n("s_btn1", X[0], -250, "player", "Criar campanha, Refazer arco", "ou agenda < 4 beats", {
    oque: "O arco é escrito ao criar a campanha, no Refazer arco da aba Roteiro e, em segundo plano, quando a agenda cai abaixo de 4 beats abertos.",
  }),
  n("s_writer", X[1], -250, "writer", "Roteirista", "arco: beats, relógios, ganchos", {
    oque: "Escreve o arco como estado: 8 a 12 beats com o que o mundo faz (gatilho, prazo, fallback fora de cena, foreshadow, pista, recompensa), relógios, ganchos e agenda dos NPCs. Só roda com modelo forte; a saída é validada por código e pelo Jev (beat que exige ato do personagem do jogador sai).",
    quando: "Criar campanha, Refazer arco, agenda abaixo de 4.",
    freq: "Raro: 1 a 2 chamadas por arco.",
    custo: "Médio e pontual: saída de até 6 mil tokens.",
    fallback: "Modelo fraco ou sem plano válido depois de 1 nova tentativa: o código monta o arco das sinopses do cânone (references/) ou um arco genérico da premissa.",
  }),
  n("s_script", X[2], -250, "code", "Arcos, beats, relógios, ganchos", "tabelas + Diretor", {
    oque: "O código avalia gatilhos, enche relógios por dia e por cena e marca beat vencido como perdido (o fallback vira notícia pública; a missão do jogador nunca é tocada). Antes do Narrador, o Diretor (agente, síncrono) monta o cartão da cena quando ela abre, um beat fica pronto ou a cada 8 turnos; o cartão substitui o roteiro no contexto. Beat com recompensa vira missão aberta ao ativar.",
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
    oque: "O jogador digita uma ação, clica numa opção do Narrador (vai tipada, com o índice) ou aperta Continuar, que manda “(continuar a cena)”. Antes de qualquer IA além do Jev, o código tira uma foto do estado e salva a ação. Gerar novamente (com motivo opcional) e o lápis na última ação voltam à foto e rodam o turno de novo; a opção escolhida fica na foto.",
    quando: "A cada turno.",
  }),
  n("t_jev", X[1], 60, "jev", "Jev: decide o turno", "modelo, web, livros, fora do jogo, NPC", {
    oque: "Uma única chamada devolve probabilidades: turno complexo (modelo caro do Narrador, se configurado), busca web (:online), trechos dos livros, fala fora do jogo sobre o registro (vai à conversa fora do jogo, sem turno) e fala só com um NPC em cena (vira conversa particular). Opção escolhida não pergunta fora do jogo nem conversa.",
    quando: "No início de cada turno.",
    freq: "1 request por turno.",
    custo: "Mínimo: cerca de US$ 0,00005 e ≈0,4 s por chamada.",
    fallback: "Timeout de 7 s. Qualquer falha: modelo padrão, web conforme o agente, sem livros, turno normal.",
  }),
  n("t_interp", X[2], 230, "interp", "Intérprete", "texto livre → até 3 passos", {
    oque: "Traduz a ação escrita em até 3 passos tipados (técnica, atributo, item, treino, fala, movimento) com a dificuldade pela ficção; marca se o jogador declarou o desfecho e se a ação depende de um fato incerto (oráculo). Não decide nada. Opção escolhida não passa por ele.",
    quando: "Em todo turno com texto livre.",
    freq: "1 chamada (2 se a 1ª não for JSON válido).",
    custo: "Baixo: modelo barato, raciocínio baixo, entrada pequena.",
    fallback: "Falhou: um passo genérico de dificuldade média com a ação inteira.",
  }),
  n("t_res", X[2], 60, "code", "Resolvedor", "regras por código", {
    oque: "Sem IA: resolve os passos em ordem (uma falha interrompe os seguintes). Técnica da ficha: custo, 1d20 + atributo×mult + domínio contra a tabela única de dificuldade, domínio sobe. Técnica fora da ficha: no máximo parcial. Treino: o train de sempre. Atributo: 1d20 contra a mesma tabela. Oráculo: d100 na tabela fixa do Mythic. Dano no alvo e no jogador pelo resultado. Devolve cada passo em palavras (deu certo, pela metade, falhou; custou pouco ou caro; recurso cheio, firme, baixo, esgotado).",
    quando: "Antes do Narrador, em todo turno com ação.",
    custo: "Sem IA: só SQL.",
  }),
  n("t_ctx", X[3], 60, "code", "Contexto do Narrador", "ficha em palavras, cena, NPCs", {
    oque: "Sem IA, na ordem que aproveita o cache: (1) o fixo da campanha: prompt do Narrador e o cenário; (2) as 6 últimas trocas; (3) o contexto do turno: cena e hora, ficha do jogador em níveis (recursos cheio/firme/baixo/esgotado, técnicas iniciante/praticando/sólido/mestre, itens, dinheiro), NPCs em cena (quem é, o que quer, como fala), missões, arco ativo, diretrizes, o resultado do turno em palavras. Nenhum número de mecânica.",
    quando: "Antes de cada turno do Narrador.",
  }),
  n("t_gm", X[4], 60, "gm", "Narrador", "conta a história + bloco de efeitos", {
    oque: "Escreve a cena a partir do resultado já decidido (em streaming) e termina com o bloco ```efeitos (opções tipadas, tempo, cena e elenco, NPC novo, fatos, itens, compra, descanso, missão). Pode ler com search_history, search_lore e get_character em até 2 rodadas. Prosa com número de regra volta 1 vez com a crítica.",
    quando: "Em cada turno do jogador.",
    freq: "1 a 3 chamadas (+1 se a prosa tiver número de regra).",
    custo: "O principal do turno: system curto, ficha em palavras e 6 trocas.",
  }),
  n("t_tools", X[5], 60, "code", "Leitura", "histórico, livros e biblioteca, ficha", {
    oque: "Só leitura: search_history (chat inteiro da campanha), search_lore (livros indexados e biblioteca do mundo) e get_character (perfil em palavras). Nada grava.",
    custo: "Sem IA: SQL e embeddings da busca.",
  }),
  n("t_fx", X[4], 230, "code", "Efeitos aplicados", "validados campo a campo", {
    oque: "Sem IA: valida o bloco (técnica e item na ficha, alvo e elenco registrados, missão existente, compra até o saldo, fato sem número) e aplica o que passou pelas ferramentas de sempre: NPC novo, cena e elenco, missão (pagamento e XP por código), itens, compra, descanso pela regra da mesa, relógio pela faixa de tempo, fatos como memória. Cada efeito vira uma etiqueta que o jogador desfaz no chat. A narração sai com as opções tipadas (meta.options).",
    quando: "Depois da narração, antes do fim do turno.",
  }),
  n("t_scribe", X[3], 230, "scribe", "Anotador", "só se faltou o bloco", {
    oque: "Lê a narração e devolve só o bloco de efeitos, quando o Narrador não mandou o bloco ou ele não dá para ler.",
    quando: "Raramente: bloco ausente ou ilegível; e no fim de toda conversa particular.",
    freq: "1 chamada (2 se a 1ª não for JSON).",
    custo: "Baixo: modelo barato.",
    fallback: "Falhou: nenhum efeito (nada inventado) e sem opções.",
  }),
  n("pg", X[5], 230, "db", "Postgres + pgvector", "memórias, fichas, mensagens", {
    oque: "Guarda tudo: campanhas, cenas, fichas, mensagens, memórias (com embeddings para busca por similaridade), roteiro, conversas de NPC, imagens e o log de cada chamada de IA (tokens, custo, duração).",
    custo: "Local (Docker). Nenhuma chamada paga; só os embeddings das memórias passam pelo OpenRouter.",
  }),
  n("or", X[5], -250, "infra", "OpenRouter e outras fontes", "toda IA passa por aqui", {
    oque: "Todas as chamadas de IA (Jev, Narrador, Intérprete, Anotador, NPC, Roteirista, Ilustrador, Voz e os criadores) saem pela fonte de modelos do agente: o OpenRouter (padrão) ou outra fonte cadastrada em Fontes de modelos (OpenAI, Anthropic, Gemini, OpenCode, outra API compatível com a da OpenAI ou o Login com ChatGPT). Cada chamada vira uma linha no histórico do agente: fonte, tokens, duração, custo, request e resposta. O Jev usa a Decisions API (probabilidades), a Voz o endpoint de fala (audio/speech) e os demais, chat completions (modelo que só gera imagem vai pelo endpoint de imagens).",
    custo: "Você paga o preço do modelo escolhido em cada agente, direto à fonte. Só o OpenRouter informa o custo de cada chamada; das outras ficam os tokens.",
  }),

  // --- NPC ---
  n("n_player", X[0], 600, "player", "Jogador fala com o NPC", "conversa particular", {
    oque: "Conversa fora da narração do Mestre, aberta pelo jogador na lista de NPCs ou sozinha, quando o Jev vê no chat da campanha uma fala só para um NPC em cena (≈3 mil tokens por fala, contra ≈20 mil de um turno do Mestre). O histórico fica guardado por sessão de conversa. A sessão também pode ser aberta pelo NPC: o Mestre manda npc_message (mensagem curta e um motivo oculto), que chega na caixa de entrada; se o jogador responde, a conversa segue com o agente do NPC, que sabe por que chamou.",
    quando: "A cada mensagem do jogador ao NPC.",
  }),
  n("n_jev", X[1], 600, "jev", "Jev: o NPC topa?", "só no início da conversa", {
    oque: "Decide se o NPC toparia conversar agora, olhando persona, objetivos, relação com o jogador, cena e se o NPC está presente.",
    quando: "Antes da 1ª chamada do NPC da sessão (histórico vazio). Uma troca recusada não é gravada: se o jogador insistir, a checagem roda de novo. No meio de uma conversa aceita não há checagem: o NPC pode cortar sozinho, em personagem. Sessão aberta pelo NPC (npc_message) não passa pela checagem. Na conversa que veio do chat da campanha, a recusa não gera fala: segue o turno do Mestre.",
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
    oque: "Ao encerrar, antes de o modal fechar: o Anotador lê a conversa inteira e os efeitos dela entram como num turno (tempo, item comprado ou recebido, missão oferecida ou aceita, fatos, que viram memórias com o NPC de assunto). Uma linha discreta entra no chat da campanha, e o fim da conversa vai ao histórico do Narrador, que retoma a cena dali.",
  }),

  // --- criação em segundo plano ---
  n("c_gm", X[0], 930, "gm", "Narrador: newNpcs", "nome, sexo e brief", {
    oque: "O bloco de efeitos traz quem entrou na história pela primeira vez: nome, sexo e um brief (quem é, o que já foi narrado). O código registra com create_npc; o Narrador não escreve a ficha.",
    quando: "Depois da narração, quando um personagem com nome aparece pela primeira vez.",
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

  n("b_gm", X[0], 1050, "gm", "Fora do jogo: add_ability", "nome e brief → ref na ficha", {
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
    oque: "Perfis, retratos e lotes da biblioteca rodam fora do turno. O cabeçalho do jogo mostra o que está rodando (com progresso) e, quando termina, a tela recarrega e avisa. Duas tarefas iguais não rodam juntas.",
    fallback: "Se o servidor reinicia no meio, a tarefa vira erro depois de 15 min sem sinal.",
  }),

  n("b_edit", X[0], 1210, "gm", "Fora do jogo: edit_ability", "a pedido do jogador", {
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
  e("t_player", "sr", "t_jev", "tl"),
  e("t_jev", "sr", "t_res", "tl", "turno"),
  e("t_jev", "sb", "t_interp", "tl", "texto livre"),
  e("t_interp", "st", "t_res", "tb", "passos"),
  e("t_jev", "st", "o_gm", "tb", "pergunta sobre o registro", { dashed: true }),
  e("t_res", "sr", "t_ctx", "tl", "resultado em palavras"),
  e("t_ctx", "sr", "t_gm", "tl"),
  e("t_gm", "sr", "t_tools", "tl", "leitura ⇄", { both: true }),
  e("t_gm", "sb", "t_fx", "tt", "prosa + bloco"),
  e("t_fx", "sl", "t_scribe", "tr", "sem bloco"),
  e("t_fx", "sr", "pg", "tl", "grava narração e efeitos"),
  e("t_res", "sb", "pg", "tb", "custo, domínio, dano", { dashed: true }),
  e("t_gm", "st", "or", "tb", "toda IA", { dashed: true }),
  // NPC
  e("n_player", "sr", "n_jev", "tl"),
  e("n_jev", "sr", "n_npc", "tl", "topa"),
  e("n_jev", "sb", "n_no", "tl", "não topa"),
  e("n_npc", "sr", "n_end", "tl", "até encerrar"),
  e("t_jev", "sb", "n_player", "tt", "fala só com um NPC em cena", { dashed: true }),
  e("n_end", "st", "t_scribe", "tb", "Anotador lê a conversa", { dashed: true }),
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
