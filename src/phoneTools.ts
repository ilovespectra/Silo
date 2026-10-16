import * as path from "path";
import * as net from "net";
import * as fsPromises from "fs/promises";
import { constants as fsConstants } from "fs";

const isWindows = process.platform === "win32";
const home = process.env.HOME || process.env.USERPROFILE || "";

/** Folder holding the tools scripts/build-phone-tools.sh bundles with this build. */
export function bundledPhoneToolsDirectories(): string[] {
  const platformArch = `${process.platform}-${process.arch}`;
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath;
  return [
    resourcesPath ? path.join(resourcesPath, "phone-tools") : "",
    process.env.SILO_PHONE_TOOLS_DIR || "",
    path.join(__dirname, "..", "vendor", "phone-tools", platformArch),
  ].filter(Boolean);
}

function systemDirectories(): string[] {
  const fromPath = (process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean);
  if (isWindows) {
    const localAppData = process.env.LOCALAPPDATA || "";
    return [
      localAppData && path.join(localAppData, "Android", "Sdk", "platform-tools"),
      process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, "platform-tools"),
      process.env.ANDROID_SDK_ROOT && path.join(process.env.ANDROID_SDK_ROOT, "platform-tools"),
      ...fromPath,
    ].filter(Boolean) as string[];
  }
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    path.join(home, "Library/Android/sdk/platform-tools"),
    path.join(home, "Android/Sdk/platform-tools"),
    process.env.ANDROID_HOME ? path.join(process.env.ANDROID_HOME, "platform-tools") : "",
    ...fromPath,
  ].filter(Boolean);
}

/**
 * Search order for a phone tool. adb prefers an existing system install so Silo
 * shares the user's adb server instead of restarting it with another version;
 * the iOS tools prefer the bundled build, which always includes afcclient.
 */
export function phoneToolSearchDirectories(name: string): string[] {
  const bundled = bundledPhoneToolsDirectories();
  const system = systemDirectories();
  const ordered = name === "adb" ? [...system, ...bundled] : [...bundled, ...system];
  return [...new Set(ordered)];
}

export async function resolvePhoneTool(
  name: string,
  onCandidate?: (candidate: string, found: boolean) => void,
): Promise<string | null> {
  const fileName = isWindows ? `${name}.exe` : name;
  for (const directory of phoneToolSearchDirectories(name)) {
    const candidate = path.join(directory, fileName);
    try {
      await fsPromises.access(candidate, isWindows ? fsConstants.F_OK : fsConstants.X_OK);
      onCandidate?.(candidate, true);
      return candidate;
    } catch {
      onCandidate?.(candidate, false);
    }
  }
  return null;
}

/**
 * libimobiledevice reaches iPhones through Apple's usbmuxd. macOS always has it;
 * on Windows it comes from Apple Devices (Microsoft Store) or iTunes and listens
 * on 127.0.0.1:27015.
 */
export function appleDeviceServiceAvailable(timeoutMs = 1500): Promise<boolean> {
  if (!isWindows) return Promise.resolve(true);
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: 27015 });
    const finish = (available: boolean) => {
      socket.destroy();
      resolve(available);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export const IOS_INSTALL_HINT = isWindows
  ? "Install Apple Devices from the Microsoft Store (or iTunes), then reconnect the iPhone."
  : "Reinstall Silo, or install libimobiledevice with Homebrew.";
export const ANDROID_INSTALL_HINT = isWindows
  ? "Reinstall Silo, or install Android SDK platform-tools."
  : "Reinstall Silo, or install android-platform-tools with Homebrew.";
