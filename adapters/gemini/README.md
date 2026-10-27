# @relay/adapter-gemini

Controla a CLI oficial `gemini` (Gemini CLI) logada com conta Google.

| Função | Como |
| --- | --- |
| `detect()` | `which gemini`, `gemini --version`. Login: existe `~/.gemini/oauth_creds.json`? (apenas `stat`, o arquivo nunca é lido) ou `GEMINI_API_KEY` definida. |
| `spawnInteractive(cwd)` | `gemini` num PTY, no `cwd` escolhido. |
| `runHeadless()` | `gemini --prompt=<texto> --output-format json [-m <model>]`. |
| `limits()` | `unknown`. |

Verificado contra Gemini CLI **0.65.0** (`npx @google/gemini-cli@0.65.0 --help`).

## Limitações

- **Retomar sessão em headless não é suportado.** `--resume` aceita apenas `latest` ou um índice
  numérico, não um id de sessão, e não há garantia de que "latest" seja a sessão do Relay.
  `runHeadless` sempre devolve `resumed: false`; o executor do Relay inclui a saída do turno
  anterior no prompt como fallback.
- Não há `gemini auth status`; a detecção de login é heurística.
