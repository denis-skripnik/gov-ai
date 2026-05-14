import fs from 'fs';
import path from 'path';

function nowIso() {
  return new Date().toISOString();
}

function ensureObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

export class JsonMemoryStore {
  constructor(filePath) {
    if (!filePath) throw new Error('JsonMemoryStore requires a file path');
    this.filePath = filePath;
  }

  load() {
    if (!fs.existsSync(this.filePath)) {
      return { version: 1, sessions: {} };
    }

    const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
    return {
      version: Number(parsed.version || 1),
      sessions: ensureObject(parsed.sessions),
    };
  }

  save(db) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, `${JSON.stringify(db, null, 2)}\n`, 'utf-8');
  }

  getSession(sessionId) {
    const db = this.load();
    return db.sessions[sessionId] || null;
  }

  upsertSession(sessionId, patch = {}) {
    if (!sessionId) throw new Error('sessionId is required');

    const db = this.load();
    const existing = db.sessions[sessionId] || {
      id: sessionId,
      created_at: nowIso(),
      updated_at: null,
      summary: '',
      facts: {},
      turns: [],
    };

    db.sessions[sessionId] = {
      ...existing,
      ...patch,
      facts: { ...ensureObject(existing.facts), ...ensureObject(patch.facts) },
      turns: Array.isArray(patch.turns) ? patch.turns : existing.turns,
      updated_at: nowIso(),
    };

    this.save(db);
    return db.sessions[sessionId];
  }

  appendTurn(sessionId, turn) {
    if (!turn || typeof turn !== 'object') throw new Error('turn object is required');

    const session = this.upsertSession(sessionId);
    const turns = Array.isArray(session.turns) ? session.turns : [];
    const nextTurn = {
      at: turn.at || nowIso(),
      role: turn.role || 'user',
      content: String(turn.content || ''),
      meta: ensureObject(turn.meta),
    };

    return this.upsertSession(sessionId, { turns: [...turns, nextTurn] });
  }

  getPromptState(sessionId, { maxTurns = 6, maxChars = 4000 } = {}) {
    const session = this.getSession(sessionId);
    if (!session) {
      return { session_id: sessionId, summary: '', facts: {}, turns: [] };
    }

    const recentTurns = (Array.isArray(session.turns) ? session.turns : []).slice(-maxTurns);
    const state = {
      session_id: sessionId,
      summary: String(session.summary || ''),
      facts: ensureObject(session.facts),
      turns: recentTurns,
    };

    const serialized = JSON.stringify(state);
    if (serialized.length <= maxChars) return state;

    const compact = { ...state, turns: [] };
    for (const turn of [...recentTurns].reverse()) {
      const candidate = { ...compact, turns: [turn, ...compact.turns] };
      if (JSON.stringify(candidate).length > maxChars) break;
      compact.turns = candidate.turns;
    }

    return compact;
  }
}
