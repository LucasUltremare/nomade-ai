# Relay

Canvas open source, local, para orquestrar as IAs que você **já assina** — Claude Pro/Max, ChatGPT Plus/Pro,
Google AI Pro — e modelos locais via Ollama. O Relay não usa API keys: ele controla as CLIs oficiais já
logadas na sua máquina (**Claude Code**, **Codex CLI**, **Gemini CLI**, **Ollama**) dentro de um canvas de nós.

> O Relay nunca lê, armazena ou transmite tokens de login. Quem guarda a sessão é a própria CLI
> (`~/.claude`, `~/.codex`, `~/.gemini`), e o Relay não abre esses diretórios.

## Por que assinaturas em vez de API?

- **Custo previsível.** Você já paga a assinatura; usá-la num canvas não gera cobrança por token.
- **Mesmo contexto das CLIs.** Permissões, MCPs, memória de projeto e sessões continuam sendo das CLIs.
- **Sem chaves espalhadas.** Nenhuma API key no Relay, em arquivos de config ou em variáveis de ambiente.

**Aviso:** cada usuário é responsável por respeitar os termos de uso do próprio provedor (Anthropic,
OpenAI, Google). O Relay apenas automatiza o que você já faria manualmente nas CLIs, com a sua conta.

## Três modos no mesmo canvas

1. **Fluxo** — nós headless conectados (prompt → modelos em paralelo → juiz → saída). *(fase 4)*
2. **Híbrido** — nós que são terminais interativos reais, com handoff manual entre eles. *(fases 2–3, prontas)*
3. **Workspace** — cada IA cria itens no canvas (notas, diagramas, cards) via MCP `relay-canvas`. *(fase 6)*

## Instalação

Requisitos: Node ≥ 22, pnpm ≥ 10 (`npm i -g pnpm`), e pelo menos uma CLI instalada e logada:

| CLI | instalar | logar |
| --- | --- | --- |
| Claude Code | `npm i -g @anthropic-ai/claude-code` | `claude auth login` |
| Codex CLI | `npm i -g @openai/codex` | `codex login` |
| Gemini CLI | `npm i -g @google/gemini-cli` | `gemini` → *Login with Google* |
| Ollama | https://ollama.com/download | `ollama pull llama3.2` (sem login) |

```bash
git clone <este repo> relay && cd relay
pnpm install
pnpm dev
```

`pnpm dev` sobe o server (porta 7357, só em `127.0.0.1`) e o Vite (porta 5173). O server imprime uma linha como:

```
Relay pronto. Abra: http://127.0.0.1:5173/?token=XXXXXXXX
```

Abra essa URL (o token é obrigatório e muda a cada start; use `RELAY_TOKEN=...` para fixar em dev).

Build de produção (server servindo o front estático):

```bash
pnpm build
pnpm start      # http://127.0.0.1:7357/?token=...
```

Checagens: `pnpm check` (typecheck + lint + testes).

### Variáveis de ambiente

| Variável | Padrão | Para quê |
| --- | --- | --- |
| `RELAY_TOKEN` | gerado no start | fixar o token de sessão |
| `RELAY_PORT` / `RELAY_HOST` | `7357` / `127.0.0.1` | porta/host do server |
| `RELAY_ROOTS` | `$HOME` | diretórios (separados por `:`) dentro dos quais um nó pode rodar |
| `RELAY_DEFAULT_CWD` | cwd do server | diretório sugerido ao abrir um terminal |
| `RELAY_OLLAMA_MODEL` | primeiro de `/api/tags` | modelo do nó Ollama interativo |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | endereço do Ollama |

## Como usar (fases 1–3)

1. **Assinaturas** — a tela inicial mostra cada CLI: instalada / logada / não encontrada, com o comando
   para instalar ou logar. "Verificar de novo" refaz a detecção.
2. **Canvas** — `+ Terminal` abre uma CLI (ou um shell) num nó com xterm.js ligado a um PTY real no server.
   Vários nós ao mesmo tempo; minimizar (`–`), maximizar (`⤢`, `Esc` volta), redimensionar pelo canto;
   presets de layout **grade / foco / dividido**. Recarregar a página não mata nada: os PTYs vivem no server
   e o scrollback é reenviado.
3. **Handoff manual**
   - Selecione texto num terminal → aparece o menu **Enviar seleção →** com os outros terminais.
   - Arraste da bolinha direita de um nó até a esquerda de outro para criar uma conexão (aresta
     **tracejada** = ainda não disparada). O botão **Enviar →** no header manda a *última resposta* desse
     terminal para o conectado; a aresta vira **contínua**.
   - "enviar Enter junto" decide se o texto é só colado (bracketed paste) ou colado e submetido.
   - O rodapé lista todos os handoffs (hora, origem → destino, prévia, tamanho).

## Segurança

- Processos sempre via `spawn(binário, [args])`; o prompt vai por argv ou stdin. Nunca passa por shell.
- Cada nó roda no diretório escolhido pelo usuário, obrigatoriamente dentro de `RELAY_ROOTS`.
- Timeout configurável em execuções headless, com kill da árvore de processos (process group).
- O server escuta só em `127.0.0.1` e exige o token (header `Authorization: Bearer` ou `?token=`)
  em todas as rotas `/api` e `/ws`. O token nunca é passado aos processos filhos.
- `~/.claude`, `~/.codex`, `~/.gemini` não são lidos (a detecção de login do Gemini faz apenas um
  `stat` em `~/.gemini/oauth_creds.json`).
- Nó de prévia (fase 5): iframe com `sandbox`, só URLs `localhost`/`127.0.0.1`.

## Arquitetura

```
packages/core          tipos do grafo, interface Adapter, executor (topológico, paralelismo limitado)
packages/server        Fastify + WebSocket em 127.0.0.1, node-pty, /api/providers, /api/sessions, /api/handoffs
packages/web           React + Vite, React Flow (canvas), xterm.js (terminais)
adapters/shared        runProcess seguro (sem shell, timeout, kill de árvore), which
adapters/claude-code   claude -p --output-format json, --resume; claude auth status --json
adapters/codex         codex exec --json, exec resume <thread_id>; codex login status
adapters/gemini        gemini --prompt --output-format json (sem resume por id; ver README do adapter)
adapters/ollama        API HTTP local (/api/tags, /api/chat); ollama run <modelo> no interativo
```

Cada adapter tem um README com as flags verificadas na versão testada e as limitações.

## Limitações conhecidas (fases 1–3)

- **"Última resposta" é heurística.** É a saída do terminal desde o último Enter, com ANSI removido. Em
  TUIs que redesenham a tela (Claude Code, Codex), pode vir com restos da interface; a seleção manual é
  mais precisa.
- **Gemini CLI**: não há `auth status`, então o login é inferido pela existência do arquivo de credenciais;
  e não há `--resume <id>` em modo headless.
- **Codex e Gemini não foram testados logados** nesta máquina (flags verificadas por `--help`).
- **Ollama** não está instalado aqui; o adapter usa a API HTTP documentada.
- O layout do canvas (posições, arestas) fica no `localStorage` do navegador; as sessões ficam no server.
  Fechar o server encerra todos os PTYs.
- Sem Windows por enquanto (PTY e kill de árvore testados só em macOS/Linux).

## Roadmap

- [x] **Fase 1** — scaffold, `detect()` dos 4 adapters, `/api/providers`, tela de assinaturas
- [x] **Fase 2** — nó Terminal (xterm.js ↔ PTY via WebSocket), vários terminais, minimizar/maximizar, presets, sessões sobrevivem a reload
- [x] **Fase 3** — handoff manual: seleção → terminal, "Enviar →", arestas contínua/tracejada, log no rodapé
- [ ] **Fase 4** — fluxo headless: nós Prompt / Modelo / Juiz / Roteador / Saída, executor com paralelismo 2, status por nó, salvar/carregar JSON
- [ ] **Fase 5** — nó Prévia: detectar URL de dev server na saída, iframe sandbox, Desktop/Tablet/Celular
- [ ] **Fase 6** — MCP `relay-canvas` (`add_note`, `draw_diagram`, `add_card`, `show_preview`, `update_item`), área por IA

## Licença

AGPL-3.0 — veja [LICENSE](./LICENSE).
