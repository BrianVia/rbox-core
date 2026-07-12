const baseUrl = process.env.RBOX_API_URL ?? "https://rbox-dev-api.brian-via.workers.dev";
const secret = process.env.RBOX_PLATFORM_SECRET;

if (!secret) {
  console.error("usage: set RBOX_PLATFORM_SECRET (optional: RBOX_API_URL) and rerun");
  process.exit(1);
}

const response = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/admin/multipart-inventory`, {
  headers: { "x-rbox-platform": secret },
});
if (!response.ok) {
  console.error(`multipart inventory request failed (${response.status})`);
  process.exit(1);
}

type Inventory = {
  nowMs: number;
  incompleteUploads: {
    buckets: Array<{ label: string; count: number; declaredBytes: number; stagedBytes: number }>;
    total: { count: number; declaredBytes: number; stagedBytes: number };
  };
  stagingObjects: {
    buckets: Array<{ label: string; count: number; bytes: number }>;
    total: { count: number; bytes: number };
    truncated: boolean;
  };
};
const inventory = (await response.json()) as Inventory;

console.log("incomplete uploads");
console.table([...inventory.incompleteUploads.buckets, { label: "total", ...inventory.incompleteUploads.total }]);
console.log("staging objects");
console.table([...inventory.stagingObjects.buckets, { label: "total", ...inventory.stagingObjects.total }]);
console.log(`truncated=${inventory.stagingObjects.truncated}`);
