import { BlobServiceClient } from "@azure/storage-blob";
import type { TokenCredential } from "@azure/identity";
import { randomUUID } from "node:crypto";

export interface ExportArchive { save(userId: string, data: Buffer): Promise<void> }

export function createExportArchive(endpoint: string, credential: TokenCredential): ExportArchive {
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || !/^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/.test(url.hostname) || url.pathname !== "/" || url.search || url.username || url.password) {
    throw new Error("A private Azure Blob endpoint is required.");
  }
  const container = new BlobServiceClient(url.href, credential, { retryOptions: { maxTries: 3, tryTimeoutInMs: 10_000 } }).getContainerClient("exports");
  return {
    async save(userId, data) {
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(userId)) throw new Error("Invalid export owner.");
      const blob = container.getBlockBlobClient(`${userId}/${randomUUID()}.json`);
      await blob.uploadData(data, {
        blobHTTPHeaders: { blobContentType: "application/json; charset=utf-8", blobCacheControl: "no-store" },
      });
    },
  };
}
