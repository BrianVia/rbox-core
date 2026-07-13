// Ambient declarations for @parcel/watcher's untyped internals + per-platform
// native binding packages (design §41). The public `@parcel/watcher` entry ships
// types, but its `./wrapper` subpath and the `@parcel/watcher-<platform>` prebuilt
// packages do not — and the non-host platform packages aren't even installed on a
// given build machine. These ambient modules let us load the binding lazily,
// per-host, without a `// @ts-expect-error` that flips to "unused" depending on
// which platform package happens to be present.

declare module "@parcel/watcher/wrapper" {
  /** Build the JS wrapper (subscribe/writeSnapshot/getEventsSince) around a native binding. */
  export function createWrapper(binding: unknown): unknown;
}

declare module "@parcel/watcher-darwin-arm64" {
  const binding: unknown;
  export default binding;
}
declare module "@parcel/watcher-linux-x64-glibc" {
  const binding: unknown;
  export default binding;
}
declare module "@parcel/watcher-linux-arm64-glibc" {
  const binding: unknown;
  export default binding;
}
