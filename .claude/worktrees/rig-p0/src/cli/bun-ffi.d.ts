/** Minimal typing for the bun:ffi surface used by io-priority.ts (design 49).
 * The repo typechecks with types:["node"] only — same approach as
 * parcel-watcher.d.ts rather than pulling in all of bun-types. */
declare module "bun:ffi" {
  export type FFITypeTag = number & { readonly __ffiType: unique symbol };
  export const FFIType: Record<"i32" | "i64", FFITypeTag>;
  export function dlopen(
    path: string,
    symbols: Record<string, { args: FFITypeTag[]; returns: FFITypeTag }>
  ): {
    symbols: Record<string, (...args: Array<number | bigint>) => number | bigint>;
    close(): void;
  };
}
