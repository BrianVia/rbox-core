// Bun 1.3.14: Readable.fromWeb() fails to propagate an errored constructed
// ReadableStream. The direct Web reader catches ECONNRESET, while the adapter
// leaks two unhandled rejections and its pipeline promise stays pending.
// Node 24 catches ECONNRESET through both paths.
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

function failingBody() {
  let sent = false;
  return new ReadableStream({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(new Uint8Array([1, 2, 3]));
      } else {
        controller.error(Object.assign(new Error("synthetic mid-body reset"), { code: "ECONNRESET" }));
      }
    },
  });
}

async function viaReader() {
  const reader = failingBody().getReader();
  try {
    while (!(await reader.read()).done) {}
    return "resolved";
  } catch (error) {
    return `caught:${error.code ?? error.name}`;
  }
}

async function viaFromWeb() {
  const escaped = [];
  const onUnhandled = error => escaped.push(`unhandledRejection:${error.code ?? error.name}`);
  process.on("unhandledRejection", onUnhandled);
  const settlement = await Promise.race([
    pipeline(
      Readable.fromWeb(failingBody()),
      new Writable({ write(_chunk, _encoding, callback) { callback(); } })
    ).then(
      () => "resolved",
      error => `rejected:${error.code ?? error.name}`
    ),
    new Promise(resolve => setTimeout(() => resolve("HUNG-after-100ms"), 100)),
  ]);
  process.off("unhandledRejection", onUnhandled);
  return { settlement, escaped };
}

const reader = await viaReader();
const adapter = await viaFromWeb();
console.log("runtime", globalThis.Bun ? `Bun ${Bun.version}` : `Node ${process.version}`);
console.log("getReader", reader);
console.log("fromWeb+pipeline", adapter.settlement);
console.log("escaped", adapter.escaped.length ? adapter.escaped.join(",") : "none");

const defect = reader === "caught:ECONNRESET" && adapter.settlement === "HUNG-after-100ms";
process.exit(defect ? 1 : 0);
