const SHELL_SAFE_WORD = /^[A-Za-z0-9_./:@%+=,~-]+$/;

export function formatShellCommand(command: string, args: string[] = []): string {
  return formatShellWords([command, ...args]);
}

export function appendShellArgs(commandPrefix: string, args: string[]): string {
  const suffix = formatShellWords(args);
  return suffix.length > 0 ? `${commandPrefix} ${suffix}` : commandPrefix;
}

export function formatShellWords(words: string[]): string {
  return words.map(shellWord).join(" ");
}

function shellWord(value: string): string {
  if (value.length > 0 && SHELL_SAFE_WORD.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}
