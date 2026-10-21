export function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export function printLines(lines: Array<string | undefined>): void {
  for (const line of lines) {
    if (line) console.log(line);
  }
}
