import { execFile } from "child_process";
import * as path from "path";
import { promisify } from "util";
import { MAC_DATA_VOLUME_ROOT } from "./indexingPathPolicy";

const execFileAsync = promisify(execFile);

type TimeMachineCommandRunner = (executable: string, args: string[]) => Promise<unknown>;

export async function startConfiguredTimeMachineBackup(
  sourcePath: string,
  sourceRegistered: boolean,
  options: { platform?: string; runCommand?: TimeMachineCommandRunner } = {},
): Promise<void> {
  if ((options.platform ?? process.platform) !== "darwin")
    throw new Error("Time Machine backups are only available for This Mac.");
  if (path.resolve(sourcePath) !== MAC_DATA_VOLUME_ROOT || !sourceRegistered)
    throw new Error("Time Machine backups can only be requested for the registered This Mac source.");

  const runCommand = options.runCommand ?? (async (executable, args) => {
    await execFileAsync(executable, args, { timeout: 15_000 });
  });
  await runCommand("/usr/bin/tmutil", ["startbackup", "--auto"]);
}
