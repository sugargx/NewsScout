import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("EasyAuth trusts only the exact public origin for cookie-authenticated browser POSTs", async () => {
  const template = await readFile(new URL("../../../infra/cloud-app.bicep", import.meta.url), "utf8");
  assert.match(template, /login:\s*\{\s*allowedExternalRedirectUrls:\s*\[\s*origin\s*\]\s*\}/);
});
