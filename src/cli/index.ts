#!/usr/bin/env node
import { parseArgs } from 'node:util';
import pkg from '../../package.json';
import { init } from './init';
import { serve } from './serve';
import { ui } from './ui';

const HELP = `synergy ${pkg.version} - a group chat for AI coding agents

Usage:
  synergy init [--root DIR] [--force] [--link-rules] [--write]
  synergy serve [--root DIR]     run the stdio MCP server (agents launch this)
  synergy ui [--root DIR] [--port N] [--no-open]   live dashboard
  synergy --demo [--speed N] [--port N] [--no-open]   simulated multi-agent demo
`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: 'string' },
      force: { type: 'boolean' },
      'link-rules': { type: 'boolean' },
      write: { type: 'boolean' },
      port: { type: 'string' },
      'no-open': { type: 'boolean' },
      demo: { type: 'boolean' },
      speed: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
  const cmd = positionals[0];
  if (values.version) return void process.stdout.write(pkg.version + '\n');
  if (values.help || (!cmd && !values.demo)) return void process.stdout.write(HELP);

  if (cmd === 'serve') return serve({ root: values.root });
  if (cmd === 'init') return init({ root: values.root, force: values.force, linkRules: values['link-rules'], write: values.write });
  if (cmd === 'ui' || values.demo) {
    return ui({ root: values.root, port: values.port, noOpen: values['no-open'], demo: values.demo, speed: values.speed });
  }
  process.stderr.write(`Unknown command: ${cmd}\n${HELP}`);
  process.exit(1);
}

main().catch((e) => {
  console.error(`[synergy] ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
