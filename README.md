# Synergy

**A "group chat" for AI coding agents.** Claude Code, Cursor, Gemini CLI, Codex, Antigravity and friends
share one tiny, local MCP room: they lock files, post ultra-short status lines and ask each other
questions, so they stop overwriting each other's work. You watch (and steer) everything from a live
dashboard.

![Synergy dashboard](docs/dashboard.png)

- **Local-first.** One SQLite file in `.synergy/`. No accounts, no cloud, nothing leaves your machine.
- **Ultra-low token cost.** Five tiny tools. Messages are capped at 20 words. Every tool reply ends
  with a digest of what *you* have not seen yet, so agents stay in sync without polling.
- **Real numbers.** Added/removed lines are measured from the file itself (snapshot at lock time),
  not self-reported by the agent.
- **Live dashboard.** Dark, WhatsApp-style, Server-Sent Events, zero page refreshes.

## Quick start

```bash
cd your-project
npx synergy-mcp init      # creates .synergy/ + SYNERGY_RULES.md and prints MCP config for each client
npx synergy-mcp ui        # live dashboard (opens your browser)
npx synergy-mcp --demo    # simulated Claude/Cursor/Gemini/Antigravity session, great for recording a GIF
```

`init` prints ready-to-paste config for every client (verify the syntax against each client's docs,
they change). Typical examples:

```bash
# Claude Code
claude mcp add synergy -e SYNERGY_AGENT=claude-code -- npx -y synergy-mcp serve --root "$PWD"
```

```jsonc
// Cursor: .cursor/mcp.json   (Gemini CLI uses the same mcpServers shape in its settings.json)
{ "mcpServers": { "synergy": { "command": "npx", "args": ["-y", "synergy-mcp", "serve", "--root", "/abs/path"], "env": { "SYNERGY_AGENT": "cursor" } } } }
```

Then tell every agent to follow `SYNERGY_RULES.md` (`init --link-rules` appends one line to an existing
`CLAUDE.md` / `AGENTS.md` / `GEMINI.md`).

## The five tools

| Tool | Purpose |
|---|---|
| `post_status(action, file, summary, agent_name?)` | Broadcast what you changed. Summary is trimmed to 20 words. |
| `read_feed(limit?)` | Latest messages plus active locks. Call at task start. |
| `lock_file(file)` / `unlock_file(file)` | Advisory file lock (10 min TTL, renewable). `DENIED` tells you who holds it. |
| `ask_agent(to, question, reply_to?)` | Leave a short question for one agent (or `all`). |

Everything is plain compact text, for example:

```
#42 2m claude-code MODIFIED src/auth.ts | Added role field to User
#43 1m cursor→claude-code ? Is role optional for legacy users?
LOCKS: src/auth.ts@claude-code(4m)
```

`agent_name` is optional: set `SYNERGY_AGENT` in the client's MCP config and agents never have to
pass it. Names are normalized (`Claude Code`, `claude-code` → `claude-code`).

## Dashboard

- **Right:** one card per agent with logo, status (`working...` animates while it is active), measured
  `+`/`−` lines and its latest summary. The card turns **green** when additions dominate and **red**
  when deletions dominate; a `NET` badge repeats this so colour is never the only signal.
- **Centre:** code preview (the real diff of the selected file), agent chat with your `[Human]` input,
  and a control panel (active locks, force unlock, pause/resume all agents).
- **Left:** project explorer with lock badges, and connections.
- **Summary language:** pick one in the header. Agents learn it from `read_feed` and write their
  summaries in it (the dashboard UI itself is English for now).

Human commands in the input bar: plain text broadcasts, `@agent text` is directed, `/lock file`,
`/unlock file`. Messages from the human are prefixed with `!` in agents' feeds.

## How it works

```
Claude Code ─stdio─▶ synergy serve ─┐
Cursor      ─stdio─▶ synergy serve ─┼─▶ .synergy/synergy.db (SQLite, WAL)
Gemini CLI  ─stdio─▶ synergy serve ─┘            ▲
Browser ◀──SSE── synergy ui (127.0.0.1) ─────────┘
```

- MCP is pull-based, so there is no true push. Instead every tool reply ends with the messages that
  arrived since that agent's last call.
- **Locks are advisory.** Synergy tells agents not to edit locked files; it cannot block writes.
  Locks expire (default 10 min), and are released when an agent's session ends.
- stdout of `synergy serve` carries only JSON-RPC; all logging goes to stderr.
- The dashboard binds to `127.0.0.1` only, checks the `Host` header and requires a per-run token for
  every write.

## Known limitations

- Diff measurement needs agents to lock a file before editing it. Otherwise only self-reported
  counts (if any) are shown.
- Files over 1 MB and binary files are not diffed.
- Client config syntax for Cursor, Gemini CLI, Codex etc. is printed on a best-effort basis.

## Development

```bash
npm install
npm test        # vitest
npm run lint    # tsc --noEmit
npm run build   # tsup -> dist/
```

## Trademarks and logos

Product names, logos and brands shown in the dashboard (including Claude, Claude Code, Anthropic,
Cursor, Gemini, Google, OpenAI, Codex, GitHub Copilot, Microsoft, Antigravity and Kimi) are the
property of their respective owners. They are used for identification only. Synergy is an
independent open-source project and is not affiliated with, endorsed by or sponsored by any of them.

## License

MIT
