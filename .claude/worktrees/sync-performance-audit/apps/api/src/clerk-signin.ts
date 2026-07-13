export function signinMethodsOf(u: {
  external_accounts?: Array<{ provider?: string; verification?: { status?: string } }>;
  password_enabled?: boolean;
}): string | null {
  const methods = new Set<string>();
  for (const a of u.external_accounts ?? []) {
    if (a.verification?.status !== "verified") continue;
    if (typeof a.provider === "string" && a.provider.length) {
      methods.add(a.provider.replace(/^oauth_/, ""));
    }
  }
  if (u.password_enabled === true) methods.add("password");
  return methods.size ? [...methods].sort().join("+") : null;
}
