type MetaRecord = Record<string, unknown>;

let cachedSessionId: string | undefined;

export function getSessionMeta(): { session_id?: string; turn_id?: string } {
  const meta = (globalThis as { obuRepl?: { requestMeta?: unknown } }).obuRepl?.requestMeta;
  if (meta && typeof meta === "object") {
    const turn = (meta as MetaRecord)["x-obu-turn-metadata"];
    if (turn && typeof turn === "object") {
      const next: { session_id?: string; turn_id?: string } = {};
      const sessionId = (turn as MetaRecord).session_id;
      const turnId = (turn as MetaRecord).turn_id;
      if (typeof sessionId === "string") next.session_id = sessionId;
      if (typeof turnId === "string") next.turn_id = turnId;
      if (next.session_id) cachedSessionId = next.session_id;
      if (next.session_id || next.turn_id) return next;
    }
  }
  return cachedSessionId ? { session_id: cachedSessionId } : {};
}

export function withSessionMeta<P extends Record<string, unknown>>(
  params: P,
): P & { session_id?: string; turn_id?: string } {
  return { ...params, ...getSessionMeta() };
}

export function getSessionLifecycleContext(): { sessionId?: string; turnId?: string } {
  const meta = getSessionMeta();
  return {
    ...(meta.session_id !== undefined ? { sessionId: meta.session_id } : {}),
    ...(meta.turn_id !== undefined ? { turnId: meta.turn_id } : {}),
  };
}

export function clearSessionMetaCacheForTests(): void {
  cachedSessionId = undefined;
}
