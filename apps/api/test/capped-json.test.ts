import { describe, expect, test } from "vitest";
import { cappedJson, exactObject, readBodyCapped, readBytesCapped } from "../src/util.js";

const url = "https://api.rbox.to/test";
const encoder = new TextEncoder();

function streamed(chunks: Uint8Array[], headers: Record<string, string> = {}, onCancel?: () => void): Request {
  let index = 0;
  return new Request(url, {
    method: "POST",
    headers,
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index++];
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
      cancel() {
        onCancel?.();
      },
    }),
  });
}

describe("readBytesCapped", () => {
  test("declared oversize rejects without reading and reports count zero", async () => {
    let pulls = 0;
    let cancelled = false;
    const req = new Request(url, {
      method: "POST",
      headers: { "content-length": "11" },
      body: new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls++;
            controller.enqueue(encoder.encode("ignored"));
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      ),
    });
    expect(await readBytesCapped(req, 10)).toEqual({ kind: "overflow", bytesCounted: 0 });
    expect(pulls).toBe(0);
    expect(cancelled).toBe(true);
  });

  test("accepts an absent-length chunked body exactly at the inclusive boundary", async () => {
    const result = await readBytesCapped(streamed([encoder.encode("1234"), encoder.encode("567890")]), 10);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(new TextDecoder().decode(result.bytes)).toBe("1234567890");
  });

  test("an understated claim still overflows by observed bytes, cancels, and stops pulling", async () => {
    let cancelled = false;
    let pulls = 0;
    const chunks = [encoder.encode("1234"), encoder.encode("5678"), encoder.encode("never")];
    const req = new Request(url, {
      method: "POST",
      headers: { "content-length": "2" },
      body: new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls++;
            const chunk = chunks.shift();
            if (chunk) controller.enqueue(chunk);
            else controller.close();
          },
          cancel() {
            cancelled = true;
          },
        },
        { highWaterMark: 0 },
      ),
    });
    expect(await readBytesCapped(req, 6)).toEqual({ kind: "overflow", bytesCounted: 8 });
    expect(cancelled).toBe(true);
    expect(pulls).toBe(2);
    expect(chunks).toHaveLength(1);
  });

  test("reader failures retain the exact count and are not relabeled overflow", async () => {
    const failure = new TypeError("stream failed");
    let pull = 0;
    const req = new Request(url, {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pull++ === 0) controller.enqueue(encoder.encode("four"));
          else controller.error(failure);
        },
      }),
    });
    const result = await readBytesCapped(req, 10);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.bytesCounted).toBe(4);
      expect(result.error).toBe(failure);
    }
  });
});

describe("cappedJson", () => {
  const validate = (value: unknown): { ok: string } | null =>
    exactObject(value, ["ok"]) && typeof value.ok === "string" ? { ok: value.ok } : null;

  test("maps overflow to the exact 413 response", async () => {
    const result = await cappedJson(new Request(url, { method: "POST", headers: { "content-length": "9" }, body: "{}" }), { maxBytes: 8 }, validate);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(413);
      expect(await result.response.json()).toEqual({ error: "body_too_large" });
    }
  });

  test.each([
    ["malformed UTF-8", new Uint8Array([0x7b, 0x22, 0x6f, 0x6b, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])],
    ["malformed JSON", encoder.encode('{"ok":')],
    ["array instead of object", encoder.encode('["ok"]')],
    ["unknown object key", encoder.encode('{"ok":"yes","extra":1}')],
    ["missing object key", encoder.encode("{}")],
  ])("maps %s to bad_request_shape", async (_name, bytes) => {
    const result = await cappedJson(streamed([bytes]), { maxBytes: 100 }, validate);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      expect(await result.response.json()).toEqual({ error: "bad_request_shape" });
    }
  });

  test("accepts valid JSON exactly at the byte boundary", async () => {
    const bytes = encoder.encode('{"ok":"yes"}');
    const result = await cappedJson(streamed([bytes]), { maxBytes: bytes.byteLength }, validate);
    expect(result).toEqual({ ok: true, value: { ok: "yes" } });
  });

  test("reader errors rethrow while the legacy text wrapper stays nonfatal", async () => {
    const failure = new Error("read failed");
    const broken = () => new Request(url, { method: "POST", body: new ReadableStream({ pull(controller) { controller.error(failure); } }) });
    await expect(cappedJson(broken(), { maxBytes: 100 }, validate)).rejects.toBe(failure);
    const replacement = await readBodyCapped(streamed([new Uint8Array([0xff])]), 1);
    expect(replacement).toBe("�");
  });
});
