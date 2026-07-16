import { expect, test } from "bun:test";
import { GITIGNORE_CHOICES } from "./init-cmd.js";

test("interactive init gitignore prompt defaults to skipping and matches setup's honest choices", () => {
  expect(GITIGNORE_CHOICES).toEqual([
    {
      name: "Skip gitignored untracked files (recommended)",
      value: "true",
      description: "re-include specific files with ! lines in .rboxignore (e.g. !.env), or switch later with `rbox ignore --respect-gitignore off`",
    },
    {
      name: "Sync gitignored files too (end-to-end encrypted)",
      value: "false",
      description: "rbox can never read them; great for notes/local state (and .env via !.env), but large builds/datasets sync too",
    },
  ]);
});
