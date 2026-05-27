import {
  createBrowserSession,
  isActionableTurnLifecycle,
  parsePersistedBrowserSessionState,
  serializeBrowserSessions,
  type BrowserSession,
  type PersistedBrowserSession,
  type PersistedBrowserSessionState,
  type PersistedSessionTab,
} from "./session_store.js";
import { firstDefinedGroupId, shouldPruneBrowserSession } from "./lifecycle/browser_session_machine.js";
import type { ActiveTabResolutionPlan } from "./lifecycle/browser_session_machine.js";

export type BrowserSessionOwner = {
  sessionId: string;
  session: BrowserSession;
};

export type BrowserSessionRepositoryDeps = {
  persistState(state: PersistedBrowserSessionState): Promise<void>;
  groupIdForTab(tabId: number): number | undefined;
};

export type BrowserSessionRestoreDeps = {
  getTab(tabId: number): Promise<ChromeTab>;
  restoreDurableTab(
    sessionId: string,
    session: BrowserSession,
    tab: ChromeTab,
    durableTab: PersistedSessionTab,
  ): Promise<void>;
  repairSessionActiveTab(session: BrowserSession): Promise<ActiveTabResolutionPlan>;
};

export class BrowserSessionRepository {
  private readonly sessions = new Map<string, BrowserSession>();

  constructor(private readonly deps: BrowserSessionRepositoryDeps) {}

  sessionFor(sessionId: string): BrowserSession {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = createBrowserSession();
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  get(sessionId: string): BrowserSession | undefined {
    return this.sessions.get(sessionId);
  }

  values(): IterableIterator<BrowserSession> {
    return this.sessions.values();
  }

  entries(): IterableIterator<[string, BrowserSession]> {
    return this.sessions.entries();
  }

  findSessionForTab(tabId: number): BrowserSessionOwner | undefined {
    for (const [sessionId, session] of this.sessions) {
      if (session.tabs.has(tabId)) return { sessionId, session };
    }
    return undefined;
  }

  isOwnedByAnotherSession(sessionId: string, tabId: number): boolean {
    for (const [id, session] of this.sessions) {
      if (id !== sessionId && session.tabs.has(tabId)) return true;
    }
    return false;
  }

  removeFinalizedTabFromAllSessions(tabId: number): void {
    for (const session of this.sessions.values()) {
      session.finalizedTabs.delete(tabId);
    }
  }

  countDeliverableTabs(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      for (const row of session.finalizedTabs.values()) {
        if (row.status === "deliverable") count += 1;
      }
    }
    return count;
  }

  lifecycleDiagnostics(): unknown[] {
    return [...this.sessions]
      .map(([sessionId, session]) => ({
        session_id: sessionId,
        lifecycle: session.lifecycle,
        turn_lifecycle: session.turnLifecycle,
        ...(session.lastFinalize ? { last_finalize: session.lastFinalize } : {}),
      }))
      .filter((row) =>
        row.lifecycle.kind !== "active" ||
        isActionableTurnLifecycle(row.turn_lifecycle) ||
        row.last_finalize !== undefined
      );
  }

  syncGroupMirrors(session: BrowserSession): void {
    session.groupId = firstDefinedGroupId(session.tabs.keys(), (tabId) => this.deps.groupIdForTab(tabId));
    session.deliverableGroupId = firstDefinedGroupId(session.finalizedTabs.keys(), (tabId) => this.deps.groupIdForTab(tabId));
  }

  syncAllGroupMirrors(): void {
    for (const session of this.sessions.values()) this.syncGroupMirrors(session);
  }

  pruneEmptySessions(): void {
    for (const [sessionId, session] of this.sessions) {
      if (shouldPruneBrowserSession(session)) {
        this.sessions.delete(sessionId);
      }
    }
  }

  async persist(): Promise<void> {
    await this.deps.persistState(serializeBrowserSessions(this.sessions));
  }

  async restoreFromStorageValue(value: unknown, restoreDeps: BrowserSessionRestoreDeps): Promise<void> {
    const state = parsePersistedBrowserSessionState(value);
    if (!state) return;

    let changed = false;
    for (const row of state.sessions) {
      let session: BrowserSession | undefined = row.tabs.length === 0 ? this.sessionFor(row.session_id) : undefined;
      if (session) applyPersistedSessionMetadata(session, row);
      for (const durableTab of row.tabs) {
        let tab: ChromeTab;
        try {
          tab = await restoreDeps.getTab(durableTab.tabId);
        } catch {
          changed = true;
          continue;
        }
        session ??= this.sessionFor(row.session_id);
        applyPersistedSessionMetadata(session, row);
        if (durableTab.status === "deliverable") {
          session.finalizedTabs.set(durableTab.tabId, durableTab);
        } else {
          session.tabs.set(durableTab.tabId, durableTab);
        }
        await restoreDeps.restoreDurableTab(row.session_id, session, tab, durableTab);
      }
      if (session && session.activeTabId !== undefined && !session.tabs.has(session.activeTabId)) {
        const resolution = await restoreDeps.repairSessionActiveTab(session);
        if (resolution.changed) {
          this.syncGroupMirrors(session);
          changed = true;
        }
      }
    }
    if (changed) await this.persist();
  }
}

function applyPersistedSessionMetadata(session: BrowserSession, row: PersistedBrowserSession): void {
  session.label = typeof row.label === "string" ? row.label : undefined;
  if (row.controlState === "human_takeover") session.controlState = "human_takeover";
  if (Number.isInteger(row.activeTabId)) session.activeTabId = row.activeTabId;
  if (row.lifecycle) session.lifecycle = row.lifecycle;
  if (row.turnLifecycle) session.turnLifecycle = row.turnLifecycle;
  if (row.lastFinalize) session.lastFinalize = row.lastFinalize;
}
