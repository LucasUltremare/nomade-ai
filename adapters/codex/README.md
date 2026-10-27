# @relay/adapter-codex

Controla a CLI oficial `codex` (OpenAI Codex CLI) logada com conta ChatGPT.

| Função | Como |
| --- | --- |
| `detect()` | `which codex`, `codex --version`, `codex login status` (exit 0 = logado; texto diz se é ChatGPT ou API key). |
| `spawnInteractive(cwd)` | `codex` num PTY, no `cwd` escolhido. |
| `runHeadless()` | `codex exec --json --skip-git-repo-check -C <cwd> -o <tmp> -` (prompt via stdin). Retomar: `codex exec ... resume <thread_id> -`. |
| `limits()` | `unknown` — só a TUI mostra (`/status`). |

Verificado contra Codex CLI **0.164.0** (`npx @openai/codex@0.164.0 --help`). O id de sessão vem do evento
`thread.started` (`thread_id`). Sandbox/approval não são alterados pelo Relay: valem os padrões do
`~/.codex/config.toml` do usuário (o Relay não lê esse arquivo).
