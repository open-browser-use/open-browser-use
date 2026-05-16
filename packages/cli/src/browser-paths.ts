import path from "node:path";

export type BrowserKind = "chrome" | "chrome-for-testing" | "edge" | "brave" | "arc" | "chromium";

export function browserInstallPath(browser: BrowserKind, platform: NodeJS.Platform): string | undefined {
  if (platform === "darwin") {
    return {
      chrome: "/Applications/Google Chrome.app",
      "chrome-for-testing": "/Applications/Google Chrome for Testing.app",
      edge: "/Applications/Microsoft Edge.app",
      brave: "/Applications/Brave Browser.app",
      arc: "/Applications/Arc.app",
      chromium: "/Applications/Chromium.app",
    }[browser];
  }
  return undefined;
}

export function browserProfileRoot(browser: BrowserKind, platform: NodeJS.Platform, homeDir: string): string {
  if (platform === "darwin") {
    const appSupport = path.join(homeDir, "Library", "Application Support");
    return {
      chrome: path.join(appSupport, "Google", "Chrome"),
      "chrome-for-testing": path.join(appSupport, "Google", "Chrome for Testing"),
      edge: path.join(appSupport, "Microsoft Edge"),
      brave: path.join(appSupport, "BraveSoftware", "Brave-Browser"),
      arc: path.join(appSupport, "Arc", "User Data"),
      chromium: path.join(appSupport, "Chromium"),
    }[browser];
  }
  const configRoot = process.env.XDG_CONFIG_HOME || path.join(homeDir, ".config");
  return {
    chrome: path.join(configRoot, "google-chrome"),
    "chrome-for-testing": path.join(configRoot, "google-chrome-for-testing"),
    edge: path.join(configRoot, "microsoft-edge"),
    brave: path.join(configRoot, "BraveSoftware", "Brave-Browser"),
    arc: path.join(configRoot, "arc"),
    chromium: path.join(configRoot, "chromium"),
  }[browser];
}

export function nativeMessagingHostDir(browser: BrowserKind, platform: NodeJS.Platform, homeDir: string): string {
  if (platform === "darwin") {
    const appSupport = path.join(homeDir, "Library", "Application Support");
    return {
      chrome: path.join(appSupport, "Google", "Chrome", "NativeMessagingHosts"),
      "chrome-for-testing": path.join(appSupport, "Google", "Chrome for Testing", "NativeMessagingHosts"),
      edge: path.join(appSupport, "Microsoft Edge", "NativeMessagingHosts"),
      brave: path.join(appSupport, "BraveSoftware", "Brave-Browser", "NativeMessagingHosts"),
      arc: path.join(appSupport, "Arc", "User Data", "NativeMessagingHosts"),
      chromium: path.join(appSupport, "Chromium", "NativeMessagingHosts"),
    }[browser];
  }
  const configRoot = process.env.XDG_CONFIG_HOME || path.join(homeDir, ".config");
  return {
    chrome: path.join(configRoot, "google-chrome", "NativeMessagingHosts"),
    "chrome-for-testing": path.join(configRoot, "google-chrome-for-testing", "NativeMessagingHosts"),
    edge: path.join(configRoot, "microsoft-edge", "NativeMessagingHosts"),
    brave: path.join(configRoot, "BraveSoftware", "Brave-Browser", "NativeMessagingHosts"),
    arc: path.join(configRoot, "arc", "NativeMessagingHosts"),
    chromium: path.join(configRoot, "chromium", "NativeMessagingHosts"),
  }[browser];
}
