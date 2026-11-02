<!-- Plano aprovado pelo dono em 2026-11-02 (pt-BR, escrito junto com ele). Medições do spike: docs/DECISIONS.md, 2026-11-02. -->
# Plano: auto-router v0.6, roteamento automático dentro do Claude Code, leve e 100% local

## Contexto
**O que você quer:**
- Nunca escolher modelo. A IA olha o pedido, o projeto, a cota e o saldo, e escolhe o modelo adequado, sem bazuca para matar mosquito.
- Trocar de modelo no meio da tarefa quando a complexidade mudar.
- Controlar tokens e janela de contexto sem você pensar nisso.
- Equilibrar a assinatura Claude Pro (limites de 5h/semana, divididos com o app no celular e no Mac) com o crédito pago do Gemini (pré-pagamento + créditos mensais do Google AI Pro, na mesma conta).
- Usar **só modelos seguros**.
- Ser **leve** (sem Docker) e **100% local**: nada passa por servidores de terceiros além dos provedores de modelo que a própria pessoa escolheu.

**Situação hoje:**
- O projeto foi feito para o Copilot Chat, mas o seu uso real é o **Claude Code direto** no VS Code.
- No plano Pro, o Claude Code usa **Opus 5.5 por padrão**. Ou seja, tudo vai para o modelo mais caro.
- O Gemini só tem teto diário.
- Existe um pool gratuito via OmniRoute, e LiteLLM e OmniRoute rodam em Docker, o que é pesado.

**O que a documentação oficial confirma** (code.claude.com, lido em 2026-11-02):
- Com `ANTHROPIC_BASE_URL` apontando para um gateway local e **sem** credencial de gateway, a assinatura continua sendo usada. O gateway precisa repassar `anthropic-beta`, que carrega o OAuth.
- Com `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1`, chegam cabeçalhos de dica: `x-claude-code-request-class` (main, subagent, compaction, auxiliary), `x-claude-code-agent-type`, `x-claude-code-prompt-id` e `x-claude-code-compaction`.
- Toda resposta traz `anthropic-ratelimit-unified-*`, que é a utilização real de 5h/7d da conta inteira.
- **Não se deve reescrever o corpo** da requisição, porque isso quebra o cache e o thinking. Trocar `model` e esforço em turnos novos é aceitável.
- O seletor de modelos do Claude Code lê `GET /v1/models` do gateway, então `auto` pode aparecer ali.
- A Anthropic **não dá suporte** a mandar o Claude Code para modelos que não são Claude. Funciona por tradução, mas é por nossa conta.
- A extensão instalada (2.1.314) tem o comando `claude-vscode.insertAtMention`. Arrastar arquivo com **Shift** já funciona.

**Suas decisões:**
- **Arquitetura:** gateway dentro do Claude Code, próprio e leve, sem Docker.
- **Modelos:** sem gratuitos na sua configuração; um único perfil `auto`; Opus sem teto.
- **Gemini:**
  - orçamento mensal único;
  - quando a cota do Claude acaba, tarefas simples vão para o Gemini e as complexas **perguntam** (Gemini ou esperar);
  - investigar o uso pela assinatura do Google;
  - OpenRouter fica para depois.
- **Retomada automática:** opcional, em segundo plano, com notificação.
- **Projeto:** detectado automaticamente, com arquivo opcional para corrigir.
- **Publicação:** o projeto público fica **genérico e configurável no instalador**. A sua configuração é um perfil local. O foco agora é a sua configuração, mas a estrutura já nasce preparada para isso.

---

## Princípios de arquitetura
1. **Mecanismo genérico, escolhas em dados.**
   - O código do repositório não sabe quem é você. Assinaturas, provedores, gratuitos sim/não, nível de segurança e cliente (Claude Code ou Copilot Chat) são **perfis de configuração**.
   - A sua máquina usa um perfil local que não vai para o GitHub (`config/local/`, no gitignore).
   - Exemplo de módulos em `config/presets/`:
     - `claude-pro.yaml`, `claude-max.yaml`, `chatgpt-codex.yaml`, `copilot.yaml`;
     - `gemini-paid.yaml`, `gemini-subscription.yaml`;
     - `free-pool.yaml` (desligado por padrão), `openrouter-zdr.yaml`, `ollama-local.yaml`.
   - O instalador pergunta e compõe o perfil local a partir dos módulos.
2. **100% local, zero telemetria.**
   - O único tráfego de saída é para os provedores que a pessoa ativou, mais o `ar.mjs update` sob demanda (GitHub da própria pessoa ou release fixada).
   - Nenhum dado vai para o autor do projeto nem para serviços intermediários. Isso é garantido por um teste que lista todos os hosts de saída permitidos.
   - Sem OmniRoute, LiteLLM, MCP de terceiros ou proxy externo no caminho principal.
3. **Leve.**
   - Um processo Python 3.9+ com stdlib e PyYAML (que já é dependência hoje) e o `claude-bridge` em Node sem dependências.
   - Sem Docker. O Docker vira um módulo opcional, só para quem ativar o pool gratuito.
   - O gateway roda **sempre**, como serviço do usuário (LaunchAgent no macOS, systemd user no Linux, Task Scheduler no Windows): sobe no login, reinicia se cair, ~30 MB. Ninguém precisa rodar comando. `ar.mjs claude-code --off` devolve o Claude Code para a conexão direta se algo der errado. A extensão companion avisa na barra de status se o gateway não responder.

---

## Fase 0: ganhos imediatos
1. **Documentar o Shift+arrastar** para o chat do Claude Code (`docs/VSCODE-SETUP.md`).
2. **Clique direito no Explorer → "Adicionar ao Claude Code"**, na extensão companion (`vscode-extension/extension.js` e `package.json`, menu `explorer/context`, seleção múltipla):
   - Para cada arquivo, abre em preview sem roubar o foco e executa `claude-vscode.insertAtMention`.
   - Para pastas ou em caso de falha, coloca `@caminho` no clipboard, chama `claude-vscode.focus` e mostra um aviso para colar.
3. **Rede de segurança enquanto o gateway não existe:** definir o modelo padrão como `sonnet` em `~/.claude/settings.json`. Só com a sua aprovação explícita.

## Fase 1: spike de viabilidade (go/no-go)
Construir um proxy mínimo em Python stdlib (`ThreadingHTTPServer` + `http.client` com streaming) em `127.0.0.1:4001` e testar:
1. **Passthrough para `api.anthropic.com`:** OAuth, SSE, cabeçalhos unified e cabeçalhos de dica.
2. **Reescrever só o `model`** (opus→haiku): a cobrança continua na assinatura? O cache volta no turno seguinte?
3. **Tradutor Anthropic Messages → OpenAI-compatible** (endpoint OpenAI do Gemini): um loop de 5 passos com tools e streaming funciona? E voltar para o Claude depois?
4. **Retomada:** `claude -p --resume <sessão> "continue"` usa a assinatura, respeita o modo de permissão da sessão e aparece no histórico da extensão ao reabrir?
5. **Consumo:** RAM e CPU do processo em repouso e em carga.
6. **Parâmetros aceitos por modelo:** temperatura com e sem thinking, valores de esforço e `thinking_level` do Gemini. O resultado é registrado em `models.yaml → params:`.
7. **Trocar Opus ↔ Sonnet no meio de um loop com tools** (sem mudar o corpo): funciona sem o erro "bound to a different conversation" do thinking? Quanto do cache se perde?

**Critério:** se 1 e 2 passam, seguir. Se 3 falhar, o Gemini atende só `auxiliary` e pedidos simples sem tools.

## Fase 2: gateway próprio e roteador `auto`
**Novo componente:** `gateway/server.py`. Ele reaproveita `litellm/engine.py`, `safety.py`, `quota.py`, `policy.py` e `context.py`, que são Python puro e já testados. Esses módulos mudam para `core/`.

- **Rotas:**
  - Claude: passthrough puro para a Anthropic, só com `model` e esforço trocados.
  - Não-Claude: `gateway/translate_openai.py`, que traduz mensagens, tools e streaming para o formato OpenAI e atende Gemini, OpenAI, OpenRouter e Ollama local.
  - Mais tarde: o endpoint de Chat Completions para o Copilot Chat entra como módulo, reaproveitando o mesmo tradutor.
- **Ligação no Claude Code:** `ar.mjs claude-code` (com dry run) grava `ANTHROPIC_BASE_URL` e `CLAUDE_CODE_GATEWAY_HINT_HEADERS=1` no `env` do `~/.claude/settings.json`. `--off` desfaz.
- **Decisão inicial por pedido** (`prompt-id`). A troca **durante** a tarefa está detalhada na Fase 2B, e a fórmula de escolha na Fase 2A.
- **Por classe de requisição:**
  - `auxiliary`: Haiku.
  - `compaction`: Sonnet.
  - Subagente Explore: Haiku.
  - Os demais: classificação normal.
- **Classificação:** o último pedido mais o contexto do projeto (Fase 3), com o classificador mais barato configurado ou heurística local.
- **Seletor do Claude Code:** `/v1/models` lista `auto` e os modelos reais. Escolher um modelo real funciona como pin, e `!opus` etc. continuam valendo.
- **Cota do Claude:** os cabeçalhos unified alimentam `quota.py`. O Opus não tem teto. A escassez só reordena modelos de qualidade parecida.
- **Orçamento mensal por provedor pago** (genérico; na sua configuração vale para o Gemini):
  - `budget: {monthly_usd: 10, start_credit_usd: X, reset_day: N}`.
  - Ritmo: cota diária = saldo restante ÷ dias até o reset. Fica registrado em `data/spend.json`.
  - Documentar também o alerta de orçamento no Google Cloud como trava real.
- **Segurança:**
  - A sua configuração só tem destinos `trusted` (Anthropic e Gemini pago).
  - A DLP detecta em todo pedido. Ela só mascara quando o destino não é `trusted`, porque mascarar reescreve o corpo. Pela regra de segurança, isso nunca acontece no seu perfil.
  - Os modos `SAFETY_MODE` e `SENSITIVE_GUARD` continuam valendo para quem ativar módulos menos seguros.

## Fase 2A: escolha do modelo e dos parâmetros (fórmula multicritério)
A regra é a **mais barata entre as que passam na régua**: o modelo e os parâmetros de menor custo esperado cuja chance de resolver bem a tarefa fica acima de uma meta. A meta sobe com a complexidade e com a criticidade do projeto. É isso que evita a bazuca sem perder qualidade.

**1. Entradas** (`core/features.py`, tudo local exceto o classificador):

| Grupo | Sinais |
|---|---|
| Pedido | tarefa, complexidade 1-5, **incerteza** do classificador, ambiguidade, profundidade de raciocínio necessária, criatividade vs. precisão, tamanho esperado da resposta, risco (apaga, migra, mexe em segurança ou dinheiro) |
| Escopo | arquivos e símbolos citados ou prováveis (pelo índice do projeto), tamanho em tokens desses arquivos, quantos módulos a mudança toca |
| Projeto | criticidade, linguagens e stack, existência de testes (um erro é pego cedo?), áreas sensíveis tocadas (auth, pagamentos, migrations), convenções no `.auto-router/` |
| Sessão | tamanho do contexto atual, modelo que já está com cache "quente", passos já feitos, erros recentes, tempo das ferramentas (`x-claude-code-prev-tool-durations`) |
| Recursos | uso de 5h/7d e ritmo de consumo, saldo mensal do Gemini e ritmo diário, cooldowns |
| Histórico | taxa de sucesso aprendida por (projeto, tarefa, faixa, modelo) |

**2. Classificador mais rico** (`core/classify.py`):
- Prompt estruturado. Entra o texto do pedido, mais o **cartão do projeto** (resumo curto do `.auto-router/project.md`, cerca de 300 tokens), mais o estado da sessão.
- Retorna JSON: `{task, complexity, uncertainty, reasoning_depth, creativity, output_size, scope_files, risk, needs_tools, needs_vision}`.
- Roda no modelo de classificação mais barato configurado (Gemini Flash-Lite pago). Tem fallback para a heurística local.
- Mensagens triviais ("ok", "continua", "1") são classificadas localmente, sem chamar modelo.

**3. Fórmula** (`core/score.py`, pesos e metas em `routing.yaml`, nunca no código):
- `P(sucesso | modelo)` é estimado de:
  - `fit[tarefa]` do `models.yaml`, ajustado pela complexidade;
  - confiabilidade de tools quando a tarefa usa ferramentas;
  - penalidade de contexto longo (perto do limite útil do modelo);
  - correção pelo histórico, com média bayesiana entre o `fit` e o sucesso observado naquele projeto.
- `meta = base[complexidade] + Δcriticidade + Δrisco + k·incerteza`. Quando há dúvida, sobe um degrau.
- `custo_esperado` soma:
  - (contexto + overhead) × preço de entrada × fator de cache, com o desconto de cache só para o modelo que já está quente;
  - saída esperada × verbosidade × preço de saída;
  - **custo de troca**, que é reler o contexto sem cache;
  - pressão de recurso: escassez da assinatura pelo uso e pelo ritmo, e pacing do orçamento mensal.
- **Escolha:** o candidato válido de menor custo com `P ≥ meta`. Se nenhum passa, o de maior P dentro do orçamento, marcado como "abaixo da meta".
- Os filtros de segurança e disponibilidade continuam rodando **antes** de tudo, como hoje em `engine.reject_reason`.
- As tabelas do `routing.yaml` continuam como lista de candidatos permitidos por célula. A fórmula ordena dentro delas. `engine.py` já faz piso, custo e reordenação e só ganha esses termos.

**3b. Custo efetivo por fonte de pagamento (equilíbrio entre cotas e dinheiro).** O "mais barato" não é o preço de tabela. É **o quanto aquele uso realmente pesa para você**, conforme de onde ele sai. Isso é genérico, vale para qualquer pessoa, e é declarado em `config/local/funding.yaml`.

| Tipo de fonte | Exemplos | Comportamento |
|---|---|---|
| `window_quota`: cota que **renova** | Claude Pro (5h + semana), Codex/ChatGPT, Copilot (premium requests/mês) | o que sobrar no reset **é perdido**: preço-sombra próximo de 0 enquanto há folga |
| `expiring_credit`: créditos com **validade por lote** | US$ 10/mês do Google AI Pro: **cada lote tem sua própria data de término** (lida da exportação do console; o FAQ fala em 1 ano) | registro em fila por lote, com o mais antigo consumido primeiro. λ só cai perto de 0 quando um lote vai vencer com saldo. Fora isso, comporta-se como saldo pré-pago |
| `prepaid_balance`: saldo pré-pago que **não expira** | pré-pagamento no Cloud Billing, créditos no OpenRouter | é dinheiro já gasto, mas preservá-lo tem valor: custo médio |
| `payg`: cobrança real no cartão | API sem crédito, estouro de orçamento | custo cheio; só se a pessoa permitir |

- **Fórmula:** `custo_efetivo = Σ tokens × preço × λ(fonte)`.
- **Preço-sombra `λ`:** é calculado continuamente para cada fonte comparando o consumo **real** com o consumo **ideal** até o próximo reset (uma curva linear):
  - **Sobra prevista no reset** (vai desperdiçar): λ → 0, e essa fonte vira a mais "barata".
  - **No ritmo:** λ ≈ valor-base do tipo (window 0,2 · expiring 0,4 · prepaid 0,8 · payg 1,0; ajustável).
  - **Esgotamento previsto antes do reset:** λ sobe acima de 1. A fonte fica reservada para tarefas que só ela resolve bem, para não faltar Opus amanhã para algo complexo.
  - Os dados vêm dos cabeçalhos unified do Claude (5h e 7d, incluindo o uso no app do celular), dos nossos contadores para o Gemini e de valores informados para quem não expõe saldo.
- **Ordem natural de consumo:**
  1. cota que vai se perder (Claude com folga);
  2. crédito que expira (US$ 10 do mês);
  3. saldo pré-pago;
  4. dinheiro real.

  Exemplo: um modelo pago muito bom que funcionaria, mas sairia dos créditos, perde para o Sonnet da assinatura quando os dois passam na régua.
- **As duas janelas do Claude ao mesmo tempo:** λ do Claude = o **maior** entre a pressão da janela de 5h e a da semanal. Com a 5h quase cheia e a semana sobrando, a conta é "espere 40 min ou use Gemini para o que é simples". Com a semana apertada, o Claude fica reservado para o complexo mesmo com a 5h livre.
- **A verificar no Google Cloud Console (Billing → Credits), passo da Fase 1:**
  - as datas de cada lote;
  - se os créditos do AI Pro cobrem os SKUs da Gemini API usada pela sua chave (o FAQ cita "todos os produtos Google Cloud, incluindo Vertex AI", mas não menciona o AI Studio);
  - (verificado em 2026-11-02: os créditos cobrem a Gemini API e cada lote tem sua própria data de término; os valores ficam só na configuração local.)

  Se não cobrirem a Gemini API, a rota Gemini passa a usar a Vertex AI com a mesma conta, o que exige verificar ids e privacidade antes.
- **Aproveitar folga sem virar bazuca (ligado na sua configuração, `use_slack_upgrade: true`):** quando λ≈0 e a cota vai se perder no reset, a meta pode subir **um** degrau (ex.: Sonnet → Opus na mesma tarefa) sem custo real. Nunca em tarefas triviais (c1).
- **Substitui** o fator fixo `scarcity` atual do `routing.yaml` (0,25/0,6/1,5) e o reordenamento por "plano com folga" em `engine.py`. Os dois viram casos particulares de λ.
- **Visível:** a status line mostra a fonte usada ("Sonnet · cota Claude · semana 42% / ideal 55%"), e `ar.mjs usage --month` mostra quanto saiu de cada fonte e quanto de cota foi desperdiçado no reset.

**4. Parâmetros modulados por decisão** (declarados por modelo em `models.yaml → params:`, porque cada provedor aceita coisas diferentes):

| Parâmetro | Como é escolhido | Restrição conhecida |
|---|---|---|
| esforço / raciocínio (`effort`, `thinking.budget_tokens`, `thinking_level` do Gemini) | `reasoning_depth` + complexidade + incerteza | é a alavanca principal |
| `max_tokens` | `output_size` previsto × margem | evita respostas longas sem necessidade |
| `temperature` / `top_p` | baixa para código, debug e dados; média para escrita e brainstorm (`creativity`) | **nos Claude com thinking ligado a temperatura é fixa**: só se aplica onde o modelo aceita, o que a Fase 1 verifica e registra em `models.yaml` |
| contexto enviado | compactar ou podar resultados de ferramentas antigos se custo > benefício (`context.py`) | no Claude Code o corpo não é reescrito: aqui só se dispara a compactação do próprio Claude Code |
| `tool_choice` / ferramentas | sem mudança no Claude Code (o corpo não é reescrito) | só para clientes que não são Claude Code |

**5. Aprendizado contínuo:**
- Cada decisão e o desfecho vão para `.auto-router/decisions.jsonl` no projeto e para `data/router.jsonl`.
- Desfechos considerados: sucesso, escalou, erro de ferramenta, você trocou na mão logo depois, testes passaram ou falharam (pelos resultados de Bash).
- `ar.mjs tune` passa a atualizar a correção bayesiana por projeto, não só a ordem das tabelas.

## Fase 2B: troca de modelo durante a tarefa (checkpoints)
**Já existe** em `litellm/policy.py` e no hook:
- reavaliação a cada `checkpoint_every` passos (4);
- subida imediata com 2 erros seguidos de ferramenta ou loop de chamadas;
- descida só com `downgrade_confirmations` (2) e `min_steps_between_switches` (3);
- `engine.switch_saving_ok` para passos mecânicos.

**Hoje isso só funciona no formato OpenAI do Copilot Chat.** O plano leva para o Claude Code:
1. **Adaptador Anthropic** em `policy.signals`. Ele lê os blocos `tool_use` e `tool_result`, usa o campo `is_error` (sinal mais confiável que a regex de hoje) e o tempo das ferramentas no cabeçalho, e conta passos dentro do mesmo `prompt-id`.
2. **Checkpoint mais esperto.** O texto vai para o classificador com `CHECKPOINT_PROMPT`: pedido original, plano atual do modelo, últimas ações e erros. Ele responde se o que **falta** ficou mais difícil, igual ou mais simples. Exemplos:
   - o plano está decidido e falta só aplicar edições repetitivas → `mechanical`, desce;
   - surgiu um bug estranho ou um teste falhando sem causa clara → sobe, e para `debug` pode ir a outro fornecedor como segunda opinião.
3. **A troca só acontece se compensar.** O custo de troca entra na fórmula da 2A: descer de Opus para Sonnet com 150 mil tokens de contexto só vale se os passos restantes economizarem mais do que reler esse contexto sem cache. Subir não espera por isso quando há falha.
4. **Momentos naturais de troca, sem custo de cache:** logo após uma compactação (`x-claude-code-context-compacted`), em mensagem nova sua, e na passagem do plan mode para a execução (o mesmo princípio do `opusplan`, mas decidido pela tarefa).
5. **Visível:** a status line mostra "Opus → Sonnet (passos mecânicos)" e o log registra o motivo.

## Fase 2C: pasta `.auto-router/` em cada projeto (análise uma vez, reuso sempre)
Na primeira vez que um projeto é usado (o `cwd` é detectado), o roteador gera uma análise curta e depois só a **atualiza incrementalmente**:

```
<projeto>/.auto-router/
  project.md          cartão do projeto (≤ 300 tokens): o que é, stack, módulos-chave, comandos de teste e build, áreas sensíveis, criticidade
  index.json          índice local leve: árvore de arquivos com tamanho em tokens, linguagem, símbolos exportados (regex por linguagem), hash
  policy.yaml         suas correções opcionais (criticality, confidential, modelos proibidos neste projeto)
  decisions.jsonl     decisões de roteamento + desfechos neste projeto (aprendizado)
  recommendations.md  sugestões para o projeto gastar menos tokens e ser roteado melhor
  memory/             memória das sessões (Fase 5)
```

- **Como é gerado (leve e local):**
  - Varredura de arquivos sem dependências: `git ls-files`, manifestos (`package.json`, `pyproject` etc.), CI, tamanhos e símbolos por regex.
  - Só o resumo final usa **uma** chamada ao modelo barato.
  - É refeito só quando muda o hash dos manifestos ou da árvore, ou quando o índice tem mais de N dias.
  - Sem embeddings nem banco vetorial nesta versão. Fica como módulo futuro opcional, com modelo local.
- **Uso:**
  - O cartão entra no classificador.
  - O índice estima o **escopo** (arquivos e tokens que a tarefa vai ler) para prever o custo e o contexto.
  - O histórico corrige as estimativas.
- **`recommendations.md`** é gerado e atualizado, **nunca aplicado sozinho**. Exemplos:
  - um `CLAUDE.md` curto com mapa do projeto e comandos, que reduz exploração;
  - `permissions.deny` / ignore para pastas geradas (`dist/`, `node_modules/`, dados), para o Claude Code não lê-las;
  - dividir arquivos gigantes que estouram contexto;
  - adicionar um comando de teste rápido;
  - em cada item, a economia estimada.

  O `ar.mjs project apply` mostra o diff e aplica só o que você aprovar.
- **Privacidade:** a pasta não vai para o git do projeto. O roteador adiciona `.auto-router/` em `.git/info/exclude`, local e sem alterar o `.gitignore`, a menos que você escolha versioná-la.

## Fase 3: cota do Claude esgotada (pergunta, Gemini ou esperar)
O recurso é **opcional**. O instalador pergunta: "Ativar a pergunta Gemini/esperar e a retomada automática?". Na sua configuração fica ligado.

- **Gatilhos:**
  - os cabeçalhos unified indicam 5h ou 7d esgotado (ou um 429 de limite do plano);
  - você digita `!esperar` ou `!gemini` a qualquer momento;
  - comandos manuais `ar.mjs wait` e `ar.mjs gemini-now`.
- **Tarefas simples** (c1-2 depois do ajuste, `auxiliary`, Explore) vão direto para o Gemini Flash-Lite ou Flash, com um aviso na barra de status.
- **Tarefas complexas:** o gateway responde sozinho, sem chamar modelo, com uma mensagem no formato de resposta da Anthropic:
  > Cota do Claude esgotada até 14:30 (janela de 5h). Para esta tarefa (refactor, complexidade 4) o Gemini mais adequado é o **Gemini Pro** (custo estimado US$ 0,12; saldo do mês US$ 7,40).
  > Responda **1** para continuar agora com o Gemini Pro ou **2** para esperar; eu retomo sozinho às 14:30.

  O modelo sugerido vem do engine: o melhor Gemini permitido pelo `fit` da tarefa, dentro do orçamento.
- **Resposta "1":** pin temporário no Gemini escolhido até a cota voltar ou a tarefa terminar.
- **Resposta "2":**
  - O gateway registra em `data/resume-queue.json`: sessão, diretório, horário de reset e o pedido pendente.
  - Um agendador no processo do gateway, na hora do reset mais uma margem, confirma pelos cabeçalhos que a cota voltou.
  - Então ele executa `claude -p --resume <sessão> "Continue a tarefa interrompida pela cota."` no diretório do projeto, com o mesmo modo de permissão. Isso usa a assinatura, e o bridge remove `ANTHROPIC_*` como já faz hoje.
  - Uma notificação local do sistema (macOS via `osascript`, Linux `notify-send`, Windows toast) avisa quando retomou, quando terminou ou quando precisa de você, por exemplo se uma ferramenta pedir permissão em background.
- **O ID da sessão:** vem de um hook `SessionStart`/`UserPromptSubmit` do Claude Code, que grava `session_id` + `cwd` + `prompt-id` em `data/`. O gateway só precisa juntar esses dados.

## Fase 4: criticidade do projeto
- O `cwd` vem do hook da Fase 3 ou do bloco de ambiente do system prompt (só leitura).
- A criticidade (`rascunho | normal | crítico`) é calculada na análise da Fase 2C a partir de git remote, testes, CI, deploy, `.env`, migrations e tamanho. Ela entra na meta de qualidade da 2A.
- O `.auto-router/policy.yaml` pode corrigi-la. `confidential: true` força só `trusted`.

## Fase 5: contexto e memória sem você pensar
Hooks do Claude Code instalados por `ar.mjs claude-code`, a partir de `scripts/hook-session-start.mjs`:
- **`PreCompact`:** grava `.auto-router/memory/<sessão>.md` (objetivo, decisões, arquivos tocados, pendências).
- **`SessionStart`** (startup, resume ou compact): injeta a memória mais recente do projeto.
- **Compactar mais cedo**, se o override existir na versão instalada (verificar no spike).

## Fase 6: visibilidade de tokens
- **`statusLine` do Claude Code** (script Node local), mostrando: modelo escolhido pelo `auto` e esforço, 5h/7d em %, saldo do Gemini no mês, % de contexto e "⏸ retomando às 14:30" quando houver fila.
- **`ar.mjs usage --month`:** custo e tokens por modelo, projeto e tarefa, e a economia em relação a "tudo em Opus".

## Fase 7: modularização e limpeza (preparando a publicação genérica)
- **Reorganizar:**
  - `core/` com engine, safety, quota, policy, context e o detector de projeto;
  - `gateway/` com o servidor e os tradutores;
  - `claude-bridge/` como já está;
  - `config/presets/*.yaml`, que são os módulos;
  - `config/local/`, a configuração da pessoa, no gitignore;
  - `optional/docker/` com LiteLLM, OmniRoute e `pool.py`, desligado por padrão.
- **Perfis de roteamento:**
  - `auto` (único) é o padrão;
  - `free`, `balanced` e `smart` continuam como **módulo opcional** para quem quiser escolher;
  - `free` continua exigindo o módulo de gratuitos.
- **Instalador** (`ar.mjs init`): pergunta pelas assinaturas (Claude Pro/Max, ChatGPT/Codex, Copilot, Google), APIs pagas e orçamento, gratuitos sim/não, nível de segurança, cliente (Claude Code e/ou Copilot Chat) e a retomada automática. Com isso compõe `config/local/`. **Nesta versão só é implementado o caminho da sua configuração.** As perguntas dos outros módulos ficam listadas como próximo passo.
- **Atualizar** `AGENTS.md` (as invariantes 1, 1c, 6 e 12 viram regras do módulo de gratuitos e do módulo Docker, e entra a regra "100% local"), o README (com o perfil de cada módulo), a documentação e os testes.

## Fase 8: Gemini pela assinatura do Google (investigação)
- Ler os termos do Gemini CLI para conta pessoal com assinatura: treino, opt-out e limites.
- Se forem aceitáveis, criar o módulo `gemini-subscription` com uma rota `gemini-*-cli` no `claude-bridge`, no mesmo padrão do Codex.
- Se não forem, registrar em `DECISIONS.md` e não incluir.

## Depois
- O módulo OpenRouter com ZDR obrigatório, avaliado com 2 a 4 semanas de `ar.mjs usage`.
- As perguntas do instalador para os outros perfis de usuário.
- Calibrar o `fit`.

---

## Arquivos principais
- **Novos:**
  - `gateway/server.py`, `gateway/translate_openai.py`, `gateway/resume.py`;
  - `core/project_context.py` (análise, índice e recomendações), `core/features.py`, `core/classify.py`, `core/score.py`, `core/funding.py` (fontes, ritmo e preço-sombra λ); `config/local/funding.yaml`;
  - `config/presets/*.yaml`;
  - `templates/claude-code/` (hooks e status line);
  - `tests/test_gateway*.py`, `tests/test_resume.py` e um teste de hosts de saída permitidos.
- **Alterados:**
  - `litellm/{engine,quota,safety,policy,context}.py`, que mudam para `core/`;
  - `routing.yaml` e `models.yaml` (perfil `auto`, `budget`, `on_claude_exhausted`);
  - `ar.mjs` (`up`/`down` sem Docker, `claude-code`, `wait`, `gemini-now`, `init` por módulos);
  - `claude-bridge/server.mjs` (comando de retomada);
  - `vscode-extension/`, `docker-compose.yml` (vai para `optional/`) e a documentação.

## Verificação
1. Testes: `python3 -m unittest discover -s tests -v` e `node --test tests/*.test.mjs`. Devem cobrir:
   - decisão por `prompt-id` e classe de requisição;
   - orçamento mensal;
   - leitura dos cabeçalhos unified;
   - detector de projeto;
   - o fluxo de cota esgotada (simples vai para o Gemini; complexa gera a mensagem; "1" fixa no Gemini; "2" enfileira);
   - o agendador de retomada com relógio falso;
   - nenhum modelo não `trusted` no perfil local;
   - nenhum host de saída fora da lista.
2. Medições do spike da Fase 1 registradas em `docs/DECISIONS.md`, com RAM e CPU do gateway.
3. **Ponta a ponta no Claude Code com `auto`:**
   - pergunta simples → Haiku;
   - refatoração média → Sonnet;
   - arquitetura → Opus;
   - conferir em `ar.mjs logs` e na barra de status, sem cobrança de API.
4. **Simular a cota esgotada:**
   - uma tarefa simples vai para o Gemini;
   - uma complexa mostra a pergunta;
   - "2" gera retomada no horário (relógio adiantado), com notificação e o histórico visível ao reabrir a sessão.
5. `/compact` grava a memória e ela é reinjetada.
5b. **Troca durante a tarefa:** uma tarefa real que começa como arquitetura (Opus) e cai em edições repetitivas deve descer para Sonnet ou Haiku depois das confirmações, quando a economia supera o custo de troca. Uma que começa simples e acumula erros de teste deve subir na hora. Ambas aparecem na status line e em `ar.mjs logs`, com o motivo.
5c. **Pasta `.auto-router/`:** é gerada na primeira sessão de um projeto real, não é refeita sem mudança, aparece em `.git/info/exclude`, e o `recommendations.md` traz economia estimada.
5e. **Testes do preço-sombra:**
   - Semana Claude com 20% usado e reset amanhã: λ≈0 e o Sonnet vence um Gemini Pro de qualidade parecida.
   - Semana com 90% usado e reset em 4 dias: o Claude fica reservado para c4-5, e tarefas c2-3 vão para o crédito do Gemini.
   - Crédito mensal do Gemini sobrando no fim do mês: ele é consumido antes do saldo pré-pago.
   - `payg` nunca é usado sem permissão.
5d. **Testes unitários da fórmula:** com recursos sobrando e tarefa trivial, vence o modelo barato; com projeto crítico e incerteza alta, sobe um degrau; quando o custo de troca supera a economia, não troca.
6. O clique direito no Explorer funciona com 1 arquivo, vários arquivos e uma pasta.
7. Com Docker desligado, `node ar.mjs up` sobe tudo, e `lsof -i` mostra só conexões para `api.anthropic.com` e `generativelanguage.googleapis.com`.
