function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export function emitJsonTo(stream: NodeJS.WritableStream, value: unknown): void {
  stream.write(jsonLine(value));
}

export function emitJson(value: unknown): void {
  emitJsonTo(process.stdout, value);
}
