# @relay/adapter-ollama

Modelos locais via Ollama. Não há assinatura nem login.

| Função | Como |
| --- | --- |
| `detect()` | `which ollama`, `ollama --version`, `GET http://127.0.0.1:11434/api/tags` (lista modelos). |
| `spawnInteractive(cwd)` | `ollama run <modelo>` num PTY (modelo: `RELAY_OLLAMA_MODEL`, ou o primeiro de `/api/tags`). |
| `runHeadless()` | `POST /api/chat` com `stream: false`; histórico por `sessionId` fica em memória do processo. |
| `limits()` | sem cota. |

Não foi possível verificar a CLI localmente (Ollama não está instalado nesta máquina); a API HTTP
usada é a documentada em https://github.com/ollama/ollama/blob/main/docs/api.md. `OLLAMA_HOST`
é respeitado para apontar para outro endereço.
