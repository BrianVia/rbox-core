export const ACCOUNT_ID_PATTERN = /^acct_[0-9a-f]{16}$/;

export function isAccountId(value: unknown): value is string {
  return typeof value === "string" && ACCOUNT_ID_PATTERN.test(value);
}

export function assertAccountId(value: string, context = "account id"): string {
  if (!isAccountId(value)) throw new Error(`malformed ${context}`);
  return value;
}
