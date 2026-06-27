import { test, expect } from "bun:test";
import { menuActionFor } from "./menu-cmd.js";

test("menu maps numbers, words, and shortcuts to actions", () => {
  expect(menuActionFor("1")).toBe("setup");
  expect(menuActionFor("setup")).toBe("setup");
  expect(menuActionFor("S")).toBe("setup");
  expect(menuActionFor("2")).toBe("connect");
  expect(menuActionFor(" connect ")).toBe("connect");
  expect(menuActionFor("3")).toBe("login");
  expect(menuActionFor("l")).toBe("login");
});

test("blank or q cancels", () => {
  expect(menuActionFor("")).toBe("quit");
  expect(menuActionFor("  ")).toBe("quit");
  expect(menuActionFor("q")).toBe("quit");
  expect(menuActionFor("quit")).toBe("quit");
});

test("anything else is invalid (caller reprompts)", () => {
  expect(menuActionFor("5")).toBeNull();
  expect(menuActionFor("yes")).toBeNull();
  expect(menuActionFor("0")).toBeNull();
});
