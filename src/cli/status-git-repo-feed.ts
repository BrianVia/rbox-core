/**
 * Bridge the manifest scan's repo CALLBACK to the async-iterable the git
 * divergence evaluator consumes, so divergence is evaluated while the walk is
 * still finding repositories instead of after it finishes.
 *
 * A callback and an async iterable are the two shapes those neighbours were
 * already built with; this owns the one adapter between them so the status
 * projection stays about projecting status. `push` after `close` is dropped
 * rather than throwing — the scan's callback can outlive an aborted walk.
 */
import { PassThrough } from "node:stream";
import type { DiscoveredGitRepo } from "../engine/index.js";

export interface GitRepoFeed {
  push: (repo: DiscoveredGitRepo) => void;
  close: () => void;
  iterable: AsyncIterable<DiscoveredGitRepo>;
}

export function createGitRepoFeed(): GitRepoFeed {
  const feed = new PassThrough({ objectMode: true });
  let closed = false;
  return {
    push(repo) {
      if (closed) return;
      feed.write(repo);
    },
    close() {
      if (closed) return;
      closed = true;
      feed.end();
    },
    iterable: feed.iterator({ destroyOnReturn: false }) as AsyncIterable<DiscoveredGitRepo>,
  };
}
