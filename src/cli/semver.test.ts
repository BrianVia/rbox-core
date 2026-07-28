import { describe, expect, test } from "bun:test";
import { parseSemver, releaseChannelForVersion, semverGt } from "./semver.js";

describe("release channel derivation", () => {
  test.each([
    ["v1.12.0", "latest"],
    ["1.12.0", "latest"],
    ["v2.0.0-beta.1", "next"],
    ["v1.12.0-rc.0", "next"],
  ] as const)("%s -> %s", (version, channel) => {
    expect(releaseChannelForVersion(version)).toBe(channel);
  });

  test.each([
    "not-a-version",
    "v1.2",
    "v01.2.3",
    "v1.2.3-",
    "v1.2.3-beta..1",
    "v1.2.3-rc.01",
    "v9007199254740992.0.0",
  ])("refuses malformed %s", (version) => {
    expect(() => releaseChannelForVersion(version)).toThrow("not a semver");
  });
});

test("general semver parsing retains build metadata", () => {
  expect(parseSemver("1.2.3+build.7").build).toBe("build.7");
});

test.each(["1.7.3", "2.0.0-beta.1"])(
  "official %s outranks the same metadata-only dev build",
  (release) => {
    const dev = `${release}+dev.84c6037`;
    expect(semverGt(release, dev)).toBe(true);
    expect(semverGt(dev, release)).toBe(false);
    expect(semverGt(`${release}+build.1`, `${release}+build.2`)).toBe(false);
  },
);

test("prerelease numeric identifiers compare exactly without Number precision loss", () => {
  expect(semverGt("2.0.0-rc.90071992547409930", "2.0.0-rc.90071992547409929")).toBe(true);
  expect(semverGt("2.0.0-rc.2", "2.0.0-rc.10")).toBe(false);
});
