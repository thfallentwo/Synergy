# Masiva Labs (`synergy-mcp`)

Local-first **multi-agent coding workspace & MCP server**. Connect your IDE agents (Antigravity, Cursor, Claude Code) with runnable CLI/API/local models (Codex CLI, Claude CLI, Gemini CLI, OpenAI, DeepSeek, Perplexity, Ollama) inside one shared project room — with **zero-copy-paste context handoff**, **multi-turn code + review loops**, and **advisory file locks**.

## Why Use Masiva Labs?

- **Limit-Wall Survival (Shared Project Brain):** Decisions, active locks, and git diff summaries live in `.synergy/context.md` and SQLite. When an IDE agent hits its 5-hour quota, another model (Codex, Gemini CLI, or local Ollama) continues immediately with zero manual copy-paste.
- **True Multi-Agent Pipelines:** Run **Direct**, **Istişare (Debate → Synthesis)**, **Code → Review**, or **Relay** loops where Agent A writes code, git diff is captured automatically, and Agent B audits bugs and regressions.
- **File Lock Shield:** Agents acquire `lock_file` before editing and release with `unlock_file` so parallel workers never clobber the same file.
- **Honest Agent Catalog:** Runnable agents (active API key, authenticated CLI, or running Ollama) are clearly separated from pull-based IDE MCP sessions (`antigravity`, `cursor`, `claude-code`).

## Quick Start

```bash
npm install
npm run build
npm link

# Inside any project repository:
masiva init       # or: synergy init
masiva ui         # starts local dashboard + HTTP/SSE server
```

## Connecting Agents via MCP

Run `masiva serve --root /path/to/repo` (or inspect `GET /api/mcp/setup` while the UI is running) for ready-to-paste configs:

| Client | Config Location | `SYNERGY_AGENT` |
| :--- | :--- | :--- |
| **Antigravity** | `~/.gemini/antigravity/mcp_config.json` | `antigravity` |
| **Cursor** | `.cursor/mcp.json` | `cursor` |
| **Claude Code** | `claude mcp add synergy ...` | `claude-code` |
| **Codex CLI** | `~/.codex/config.toml` | `codex` |
| **Gemini CLI** | `~/.gemini/settings.json` | `gemini` |

Example JSON (`mcpServers`):

```json
{
  "mcpServers": {
    "synergy": {
      "command": "npx",
      "args": ["-y", "synergy-mcp", "serve", "--root", "/path/to/your/repo"],
      "env": {
        "SYNERGY_AGENT": "antigravity"
      }
    }
  }
}
```

## Optional Local Model (Zero API Key)

If you have [Ollama](https://ollama.com/download) installed locally, Masiva Labs automatically detects your RAM and suggests a fitting model (for example `qwen2.5-coder:3b` on 8 GB systems, `qwen2.5-coder:7b` on 16+ GB systems):

```bash
ollama pull qwen2.5-coder:3b
```

## Scripts

```bash
npm run lint   # tsc --noEmit
npm run build  # tsup
npm test       # vitest run
```
