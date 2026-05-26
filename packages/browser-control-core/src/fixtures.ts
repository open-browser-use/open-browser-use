import { activeSessionLifecycle } from "./session.js";
import { planFinalizeTabs, parseFinalizeKeep } from "./finalize.js";

export const browserControlCoreFixtures = {
  protocolVersion: 1,
  activeCommandAccepted: {
    input: activeSessionLifecycle(1),
    operation: "tab_goto",
    result: "accepted",
  },
  finalizeTwoTabs: {
    input: {
      tabs: [
        [1, { tabId: 1, origin: "agent", status: "active" }],
        [2, { tabId: 2, origin: "user", status: "active" }],
      ],
      keep: [{ tab_id: 2, status: "handoff" }],
    },
    output: planFinalizeTabs(
      new Map([
        [1, { tabId: 1, origin: "agent", status: "active" }],
        [2, { tabId: 2, origin: "user", status: "active" }],
      ]),
      parseFinalizeKeep({ keep: [{ tab_id: 2, status: "handoff" }] }),
    ),
  },
} as const;
