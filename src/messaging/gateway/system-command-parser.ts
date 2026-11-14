export interface SystemCommandMatch {
  readonly command: string;
  readonly start: number;
  readonly end: number;
}

export function extractSystemCommand(
  text: string,
  addressedToBot: boolean,
): string | undefined {
  return extractSystemCommandMatch(text, addressedToBot)?.command;
}

export function extractSystemCommandMatch(
  text: string,
  addressedToBot: boolean,
): SystemCommandMatch | undefined {
  const leadingCommand = text.match(/^#\S+/);
  if (leadingCommand !== null) {
    const command = leadingCommand[0];
    return {
      command: command.toLowerCase(),
      start: 0,
      end: command.length,
    };
  }
  if (!addressedToBot) {
    return undefined;
  }
  const match = text.match(/(?:^|\s)(#[A-Za-z0-9_-]+)/);
  const command = match?.[1];
  if (command === undefined || match?.index === undefined) {
    return undefined;
  }
  const start = match.index + match[0].indexOf(command);
  return {
    command: command.toLowerCase(),
    start,
    end: start + command.length,
  };
}
