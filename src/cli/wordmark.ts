import { stderrStyle } from "./style.js";

/** Pixel grids for the wordmark, 6 rows tall — rendered as 3 terminal rows of
 * half-block glyphs. Two-tone like the reference: dim "r", bright "box". */
const LETTERS: Record<string, readonly string[]> = {
  r: ["00000", "00000", "11111", "11000", "11000", "11000"],
  b: ["11000", "11000", "11110", "11011", "11011", "11110"],
  o: ["00000", "00000", "11111", "11011", "11011", "11111"],
  x: ["00000", "00000", "11011", "01110", "01110", "11011"],
};

function renderLetter(grid: readonly string[]): string[] {
  const lines: string[] = [];
  for (let row = 0; row < 6; row += 2) {
    let line = "";
    for (let col = 0; col < grid[row]!.length; col++) {
      const top = grid[row]![col] === "1";
      const bottom = grid[row + 1]![col] === "1";
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(line);
  }
  return lines;
}

function joinLetters(word: string, style: (text: string) => string): string[] {
  const rendered = [...word].map((letter) => renderLetter(LETTERS[letter]!));
  return [0, 1, 2].map((row) => style(rendered.map((letter) => letter[row]).join(" ")));
}

/** The first-run banner: block "rbox" wordmark plus a one-line welcome.
 * Returns lines ready for stderr; color handling follows stderrStyle. */
export function rboxBanner(): string {
  const r = joinLetters("r", stderrStyle.dim);
  const box = joinLetters("box", (text) => stderrStyle.bold(text));
  const mark = [0, 1, 2].map((row) => `  ${r[row]} ${box[row]}`);
  return `\n${mark.join("\n")}\n\n  ${stderrStyle.bold("Welcome to rbox!")} ${stderrStyle.dim("— Dropbox, but for devs.")}\n`;
}
