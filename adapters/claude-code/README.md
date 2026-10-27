# @relay/adapter-claude-code

Controla a CLI oficial `claude` (Claude Code) já logada na máquina.

| Função | Como |
| --- | --- |
| `detect()` | `which claude`, `claude --version`, `claude auth status --json` (campos `loggedIn`, `subscriptionType`, `email`). |
| `spawnInteractive(cwd)` | `claude` num PTY, no `cwd` escolhido. |
| `runHeadless()` | `claude -p --output-format json --session-id <uuid>` (prompt via stdin). Retomar: `--resume <id>`. |
| `limits()` | `unknown` — a CLI só mostra cota no `/usage` interativo. |

Verificado contra Claude Code **2.1.306**. Nenhum arquivo de `~/.claude` é lido pelo Relay.
