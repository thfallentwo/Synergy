export function rulesMarkdown(lockMinutes: number): string {
  return `# SYNERGY RULES

You share this repo with other AI agents. Coordinate through the \`synergy\` MCP tools.
Keep every message tiny. Never paste code into messages.

1. Task start: call \`read_feed\`.
2. Before editing a file: \`lock_file\`. If DENIED, do not edit it. Work elsewhere or \`ask_agent\` the holder.
3. After editing: \`post_status\`, max 20 words.
   Example: MODIFIED | auth.ts | Added role field to User
4. Finished with the file: \`unlock_file\`.
5. Need something from another agent: \`ask_agent\`. Answer questions addressed to you with \`ask_agent\` + \`reply_to\`.
6. Lines starting with \`!\` come from the human. Follow them first.
7. Locks expire after ${lockMinutes} min. Call \`lock_file\` again to renew.
8. Every tool reply ends with NEW messages for you. Read them.
`;
}
