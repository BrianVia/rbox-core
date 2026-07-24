import { expect, test } from "bun:test";
import * as gitCmd from "./git-cmd.js";
import type {
  GitDeferralsCmdDeps,
  GitDeferralsCmdOptions,
  GitResolveShow,
  ResolveRefusalCode,
} from "./git-cmd.js";

export type GitCmdFacadeTypes = [
  GitDeferralsCmdDeps,
  GitDeferralsCmdOptions,
  GitResolveShow,
  ResolveRefusalCode,
];

test("git-cmd preserves its exact runtime compatibility surface", () => {
  expect(Object.keys(gitCmd).sort()).toEqual([
    "gitDeferralsCmd",
    "gitResolveCmd",
    "safeResolveText",
  ]);
});
