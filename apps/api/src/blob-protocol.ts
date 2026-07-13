/** Shared upload-receipts protocol discriminator. Kept neutral so the packed
 * placement helpers and canonical blob handlers do not form an import cycle. */
export const UPLOAD_RECEIPTS_V1 = "upload-receipts-v1";
export const usesReceipts = (req: Request): boolean => req.headers.get("x-rbox-protocol") === UPLOAD_RECEIPTS_V1;
