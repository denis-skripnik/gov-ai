export function buildMemoryContext(promptState) {
  const state = promptState || {};
  const lines = [
    'PRIOR_STATE:',
    `session_id: ${state.session_id || 'unknown'}`,
    `summary: ${state.summary || 'none'}`,
  ];

  const facts = state.facts && typeof state.facts === 'object' ? state.facts : {};
  const factEntries = Object.entries(facts);
  if (factEntries.length) {
    lines.push('facts:');
    for (const [key, value] of factEntries) {
      lines.push(`- ${key}: ${JSON.stringify(value)}`);
    }
  } else {
    lines.push('facts: none');
  }

  const turns = Array.isArray(state.turns) ? state.turns : [];
  if (turns.length) {
    lines.push('recent_turns:');
    for (const turn of turns) {
      lines.push(`- ${turn.role || 'unknown'}: ${String(turn.content || '').replace(/\s+/g, ' ').trim()}`);
    }
  } else {
    lines.push('recent_turns: none');
  }

  lines.push('END_PRIOR_STATE');
  return lines.join('\n');
}

export function buildStatefulMessages({ systemPrompt, userPrompt, promptState }) {
  const memoryContext = buildMemoryContext(promptState);
  return [
    {
      role: 'system',
      content:
        systemPrompt ||
        'You are a governance analysis assistant. Use prior state only when it is relevant and do not invent missing facts.',
    },
    {
      role: 'user',
      content: `${memoryContext}\n\nCURRENT_TASK:\n${userPrompt}`,
    },
  ];
}
