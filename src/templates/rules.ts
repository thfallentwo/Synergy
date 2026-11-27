export function rulesMarkdown(lockMinutes: number): string {
  return `# SYNERGY RULES (Masiva Labs)

You share this repository with other AI agents. Coordinate through the \`synergy\` MCP tools.
Keep status updates concise. Never overwrite a file locked by another agent.

1. Task start: call \`get_project_memory\` (for project goal, decisions, and diffs) and \`read_feed\`.
2. Before editing a file: \`lock_file\`. If DENIED, do not edit it; work elsewhere or \`ask_agent\` the holder.
3. After editing: \`post_status\` (max 20 words), then \`unlock_file\` when finished.
   Example: MODIFIED | auth.ts | Added JWT expiry check
4. Collaborate or delegate: use \`ask_agent\` for quick questions, or \`handoff_task\` to pass goals, files, and context cleanly to another agent.
5. Messages starting with \`!\` or \`[HANDOFF]\` carry top priority from the user or orchestrator.
6. Locks expire after ${lockMinutes} min. Call \`lock_file\` again to renew.
7. Every tool reply ends with NEW unread messages for you. Always read them.
8. If \`read_feed\` starts with \`LANG xx\`, write your summaries in that language.
`;
}
