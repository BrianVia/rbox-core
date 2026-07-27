export function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Quote only when the shell would otherwise mis-read the word. A remedy the user
 * is meant to copy should look like the command they would have typed. */
export function shQuoteIfNeeded(s: string): string {
  return /^[A-Za-z0-9/][A-Za-z0-9._/@:+-]*$/.test(s) ? s : shQuote(s);
}
