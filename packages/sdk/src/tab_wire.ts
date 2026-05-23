import { Guards } from "./guards.js";
import { Tab, type TabMetadata, type TabRuntimeContext } from "./tab.js";
import type { Transport } from "./wire/transport.js";

export type TabWire = {
  tab_id?: string;
  id?: string;
  target_id?: string;
  url?: string;
  title?: string;
  origin?: "agent" | "user";
  status?: "active" | "handoff" | "deliverable";
  active?: boolean;
  logicalActive?: boolean;
  logical_active?: boolean;
  windowId?: number;
  window_id?: number;
  groupId?: number;
  group_id?: number;
  pinned?: boolean;
  lastAccessed?: number;
  last_accessed?: number;
  lastUsedAt?: number;
  last_used_at?: number;
  tabGroupTitle?: string;
  tab_group_title?: string;
  tabGroup?: string;
  tab_group?: string;
  owned?: boolean;
  claimRequired?: boolean;
  claim_required?: boolean;
  commandable?: boolean;
};

export function tabIdFromWire(row: TabWire, missingIdMessage: string): string {
  const id = row.tab_id ?? row.id;
  if (!id) throw new Error(missingIdMessage);
  return id;
}

export function tabMetadata(row: TabWire): TabMetadata {
  const metadata: TabMetadata = {};
  if (row.target_id !== undefined) metadata.target_id = row.target_id;
  if (row.url !== undefined) metadata.url = row.url;
  if (row.title !== undefined) metadata.title = row.title;
  if (row.origin !== undefined) metadata.origin = row.origin;
  if (row.status !== undefined) metadata.status = row.status;
  if (row.active !== undefined) metadata.active = row.active;
  if (row.logicalActive !== undefined) metadata.logicalActive = row.logicalActive;
  if (row.logical_active !== undefined) metadata.logicalActive = row.logical_active;
  if (row.windowId !== undefined) metadata.windowId = row.windowId;
  if (row.window_id !== undefined) metadata.windowId = row.window_id;
  if (row.groupId !== undefined) metadata.groupId = row.groupId;
  if (row.group_id !== undefined) metadata.groupId = row.group_id;
  if (row.pinned !== undefined) metadata.pinned = row.pinned;
  if (row.lastAccessed !== undefined) metadata.lastAccessed = row.lastAccessed;
  if (row.last_accessed !== undefined) metadata.lastAccessed = row.last_accessed;
  if (row.lastUsedAt !== undefined) metadata.lastUsedAt = row.lastUsedAt;
  if (row.last_used_at !== undefined) metadata.lastUsedAt = row.last_used_at;
  if (row.tabGroupTitle !== undefined) metadata.tabGroupTitle = row.tabGroupTitle;
  if (row.tab_group_title !== undefined) metadata.tabGroupTitle = row.tab_group_title;
  if (row.tabGroup !== undefined) metadata.tabGroup = row.tabGroup;
  if (row.tab_group !== undefined) metadata.tabGroup = row.tab_group;
  if (row.owned !== undefined) metadata.owned = row.owned;
  if (row.claimRequired !== undefined) metadata.claimRequired = row.claimRequired;
  if (row.claim_required !== undefined) metadata.claimRequired = row.claim_required;
  if (row.commandable !== undefined) metadata.commandable = row.commandable;
  return metadata;
}

export function tabFromWire(
  transport: Transport,
  guards: Guards,
  row: TabWire,
  missingIdMessage: string,
  runtimeContext: TabRuntimeContext = {},
): Tab {
  return new Tab(transport, guards, tabIdFromWire(row, missingIdMessage), tabMetadata(row), runtimeContext);
}
