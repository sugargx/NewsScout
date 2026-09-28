import { CopilotClient } from "@github/copilot-sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAzureGitHubAppCredentialManager } from "../services/copilot-gateway/dist/github-credential.js";

const credential = createAzureGitHubAppCredentialManager();
if (!credential) throw new Error("The managed GitHub App credential is not configured.");
const directory = await mkdtemp(join(tmpdir(), "newsscout-service-probe-"));
let client;
try {
  await credential.start();
  await credential.verifyPersistence();
  client = new CopilotClient({
    gitHubToken: await credential.accessToken(), useLoggedInUser: false, mode: "empty",
    baseDirectory: directory, workingDirectory: directory, logLevel: "error",
    env: { ...process.env, COPILOT_GITHUB_TOKEN: undefined, GH_TOKEN: undefined, GITHUB_TOKEN: undefined },
  });
  await client.start();
  const models = (await client.listModels()).filter(model => model.id !== "auto" && model.policy?.state !== "disabled");
  const status = credential.status();
  console.log(JSON.stringify({
    credentialAccepted: true,
    accountVerified: status.accountVerified,
    credentialDurable: status.durable,
    persistenceWriteVerified: status.durable,
    refreshTokenNearExpiry: status.refreshTokenNearExpiry,
    availableModelCount: models.length,
    configuredModel: "gpt-5.6-terra",
    configuredModelAvailable: models.some(model => model.id === "gpt-5.6-terra"),
    inferenceRequests: 0,
  }));
} catch {
  console.log(JSON.stringify({ credentialAccepted: false, error: "copilot_service_probe_failed", inferenceRequests: 0 }));
  process.exitCode = 1;
} finally {
  if (client) {
    const failures = await client.stop();
    if (failures.length) {
      await client.forceStop();
      console.error("Copilot service probe required forced shutdown.");
      process.exitCode = 1;
    }
  }
  credential.stop();
  await rm(directory, { recursive: true });
}
