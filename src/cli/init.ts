import fs from 'node:fs';
import path from 'node:path';
import { SYNERGY_DIR, resolveRoot } from '../core/paths';
import { openDb } from '../core/store';
import { dbPath } from '../core/paths';
import { rulesMarkdown } from '../templates/rules';

const say = (s = '') => process.stdout.write(s + '\n');

export interface InitOptions {
  root?: string;
  force?: boolean;
  linkRules?: boolean;
  write?: boolean;
}

const LINK_TARGETS = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md'];
const LINK_LINE = 'Coordinate with other agents: follow SYNERGY_RULES.md (synergy MCP tools).';

export function mcpEntry(root: string, agent: string) {
  return {
    command: 'npx',
    args: ['-y', 'synergy-mcp', 'serve', '--root', root],
    env: { SYNERGY_AGENT: agent },
  };
}

export function init(opts: InitOptions = {}): void {
  const root = opts.root ? path.resolve(opts.root) : resolveRoot({ cwd: process.cwd() });
  const dir = path.join(root, SYNERGY_DIR);
  fs.mkdirSync(dir, { recursive: true });

  const cfg = path.join(dir, 'config.json');
  if (!fs.existsSync(cfg)) {
    fs.writeFileSync(cfg, JSON.stringify({ version: 1, lockTtlMinutes: 10, summaryWords: 20 }, null, 2) + '\n');
  }
  fs.writeFileSync(path.join(dir, '.gitignore'), '*\n');
  openDb(dbPath(root)).close();
  say(`\u2713 ${SYNERGY_DIR}/ ready in ${root}`);

  const rules = path.join(root, 'SYNERGY_RULES.md');
  if (!fs.existsSync(rules) || opts.force) {
    fs.writeFileSync(rules, rulesMarkdown(10));
    say('\u2713 SYNERGY_RULES.md written');
  } else {
    say('\u2022 SYNERGY_RULES.md already exists (use --force to overwrite)');
  }

  if (opts.linkRules) {
    for (const t of LINK_TARGETS) {
      const p = path.join(root, t);
      if (fs.existsSync(p) && !fs.readFileSync(p, 'utf8').includes('SYNERGY_RULES.md')) {
        fs.appendFileSync(p, `\n${LINK_LINE}\n`);
        say(`\u2713 linked rules in ${t}`);
      }
    }
  }

  if (opts.write) {
    const cursorDir = path.join(root, '.cursor');
    fs.mkdirSync(cursorDir, { recursive: true });
    const p = path.join(cursorDir, 'mcp.json');
    const cur = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
    cur.mcpServers = { ...(cur.mcpServers ?? {}), synergy: mcpEntry(root, 'cursor') };
    fs.writeFileSync(p, JSON.stringify(cur, null, 2) + '\n');
    say('\u2713 .cursor/mcp.json updated');
  }

  const j = (a: string) => JSON.stringify({ mcpServers: { synergy: mcpEntry(root, a) } }, null, 2);
  say('\nConnect your agents (verify syntax against each client\u2019s docs):\n');
  say('Claude Code:');
  say(`  claude mcp add synergy -e SYNERGY_AGENT=claude -- npx -y synergy-mcp serve --root "${root}"\n`);
  say('Cursor (.cursor/mcp.json):');
  say(j('cursor') + '\n');
  say('Gemini CLI (~/.gemini/settings.json or .gemini/settings.json):');
  say(j('gemini') + '\n');
  say('Codex (~/.codex/config.toml):');
  say('  [mcp_servers.synergy]');
  say('  command = "npx"');
  say(`  args = ["-y", "synergy-mcp", "serve", "--root", "${root.replace(/\\/g, '\\\\')}"]`);
  say('  env = { SYNERGY_AGENT = "codex" }\n');
  say('Then tell each agent to read SYNERGY_RULES.md. Dashboard: npx synergy-mcp ui');
}
