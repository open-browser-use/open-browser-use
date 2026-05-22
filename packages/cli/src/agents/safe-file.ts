import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export async function readOptionalRegularText(file: string): Promise<string | undefined> {
  const stats = await lstat(file).catch((error) => error as NodeJS.ErrnoException);
  if (stats instanceof Error) {
    if (stats.code === "ENOENT") return undefined;
    throw stats;
  }
  assertRegularFile(stats, file, "read");
  return await readFile(file, "utf8");
}

export async function writeRegularTextFile(file: string, content: string, mode: number): Promise<void> {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  try {
    await writeFile(temp, content, { encoding: "utf8", mode });
    const latest = await lstat(file).catch((error) => error as NodeJS.ErrnoException);
    if (!(latest instanceof Error)) {
      assertRegularFile(latest, file, "replace");
    } else if (latest.code !== "ENOENT") {
      throw latest;
    }
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

function assertRegularFile(stats: Awaited<ReturnType<typeof lstat>>, file: string, operation: string): void {
  if (stats.isSymbolicLink()) {
    const error = new Error(`refusing to ${operation} symlink: ${file}`) as NodeJS.ErrnoException;
    error.code = "ELOOP";
    throw error;
  }
  if (!stats.isFile()) {
    const error = new Error(`refusing to ${operation} non-file path: ${file}`) as NodeJS.ErrnoException;
    error.code = "EINVAL";
    throw error;
  }
}
