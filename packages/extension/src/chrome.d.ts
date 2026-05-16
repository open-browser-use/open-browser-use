type NativePort = {
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
  postMessage(message: unknown): void;
  disconnect(): void;
};

type RuntimeMessageSender = { tab?: { id?: number } };

declare const chrome: {
  runtime: {
    id?: string;
    lastError?: { message?: string };
    getManifest(): { version: string };
    connectNative(name: string): NativePort;
    sendMessage(message: unknown): Promise<unknown>;
    onMessage: {
      addListener(
        listener: (
          message: unknown,
          sender: RuntimeMessageSender,
          sendResponse: (response?: unknown) => void,
        ) => boolean | void,
      ): void;
    };
  };
  alarms: {
    create(name: string, alarmInfo: { delayInMinutes?: number; periodInMinutes?: number; when?: number }): Promise<void>;
    clear(name: string): Promise<boolean>;
    onAlarm: {
      addListener(listener: (alarm: { name: string }) => void): void;
    };
  };
  storage: {
    local: {
      get<T extends Record<string, unknown>>(keys: string[] | string): Promise<T>;
      set(items: Record<string, unknown>): Promise<void>;
    };
    onChanged: {
      addListener(
        listener: (changes: Record<string, { newValue?: unknown }>, areaName: string) => void,
      ): void;
    };
  };
  tabs: {
    create(createProperties: { url?: string; active?: boolean }): Promise<ChromeTab>;
    get(tabId: number): Promise<ChromeTab>;
    query(queryInfo: Record<string, unknown>): Promise<ChromeTab[]>;
    remove(tabIds: number | number[]): Promise<void>;
    group(options: { tabIds: number | number[]; groupId?: number }): Promise<number>;
    ungroup(tabIds: number | number[]): Promise<void>;
    sendMessage(tabId: number, message: unknown): Promise<unknown>;
  };
  windows: {
    get(windowId: number): Promise<ChromeWindow>;
  };
  scripting: {
    executeScript(injection: {
      files?: string[];
      // Chrome executes this function with JSON-serializable args from `args`.
      func?: (...args: any[]) => unknown;
      args?: unknown[];
      injectImmediately?: boolean;
      target: { tabId: number; frameIds?: number[]; allFrames?: boolean };
    }): Promise<unknown>;
  };
  tabGroups: {
    update(groupId: number, updateProperties: { title?: string; color?: string }): Promise<unknown>;
  };
  history: {
    search(query: {
      text: string;
      maxResults?: number;
      startTime?: number;
      endTime?: number;
    }): Promise<ChromeHistoryItem[]>;
  };
  debugger: {
    attach(target: { tabId: number }, requiredVersion: string): Promise<void>;
    detach(target: { tabId: number }): Promise<void>;
    sendCommand(target: { tabId: number }, method: string, commandParams?: unknown): Promise<unknown>;
    onEvent: {
      addListener(
        listener: (source: ChromeDebuggerSource, method: string, params?: unknown) => void,
      ): void;
    };
    onDetach: {
      addListener(listener: (source: ChromeDebuggerSource, reason?: string) => void): void;
    };
  };
  downloads: {
    search(query: { id?: number }): Promise<ChromeDownloadItem[]>;
    onCreated: {
      addListener(listener: (item: ChromeDownloadItem) => void): void;
    };
    onChanged: {
      addListener(listener: (delta: ChromeDownloadDelta) => void): void;
    };
  };
};

type ChromeDebuggerSource = {
  tabId?: number;
  extensionId?: string;
  targetId?: string;
};

type ChromeTab = {
  id?: number;
  windowId?: number;
  groupId?: number;
  url?: string;
  title?: string;
  active?: boolean;
  pinned?: boolean;
  status?: string;
};

type ChromeWindow = {
  id?: number;
  focused?: boolean;
  state?: "normal" | "minimized" | "maximized" | "fullscreen" | "locked-fullscreen";
  type?: "normal" | "popup" | "panel" | "app" | "devtools";
};

type ChromeHistoryItem = {
  id?: string;
  url?: string;
  title?: string;
  lastVisitTime?: number;
  visitCount?: number;
  typedCount?: number;
};

type ChromeDownloadItem = {
  id: number;
  url?: string;
  filename?: string;
  state?: "in_progress" | "interrupted" | "complete";
  error?: string;
};

type ChromeDownloadDeltaValue<T> = {
  previous?: T;
  current?: T;
};

type ChromeDownloadDelta = {
  id: number;
  url?: ChromeDownloadDeltaValue<string>;
  filename?: ChromeDownloadDeltaValue<string>;
  state?: ChromeDownloadDeltaValue<"in_progress" | "interrupted" | "complete">;
  error?: ChromeDownloadDeltaValue<string>;
};
