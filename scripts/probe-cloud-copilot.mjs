import { CopilotClient } from "@github/copilot-sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const token = process.env.SCOUTNEWS_PROBE_TOKEN;
if (!token) throw new Error("A privately supplied service credential is required.");
const directory = await mkdtemp(join(tmpdir(), "newsscout-service-probe-"));
const client = new CopilotClient({
  gitHubToken: token, useLoggedInUser: false, mode: "empty",
  baseDirectory: directory, workingDirectory: directory, logLevel: "error",
  env: { ...process.env, SCOUTNEWS_PROBE_TOKEN: undefined, COPILOT_GITHUB_TOKEN: undefined, GH_TOKEN: undefined, GITHUB_TOKEN: undefined },
});
try {
  await client.start();
  const models = (await client.listModels()).filter(model => model.id !== "auto" && model.policy?.state !== "disabled");
  console.log(JSON.stringify({
    credentialAccepted: true,
    availableModelCount: models.length,
    configuredModel: "gpt-5.6-terra",
    configuredModelAvailable: models.some(model => model.id === "gpt-5.6-terra"),
    inferenceRequests: 0,
  }));
} catch {
  console.log(JSON.stringify({ credentialAccepted: false, error: "copilot_service_probe_failed", inferenceRequests: 0 }));
  process.exitCode = 1;
} finally {
  const failures = await client.stop();
  if (failures.length) {
    await client.forceStop();
    console.error("Copilot service probe required forced shutdown.");
    process.exitCode = 1;
  }
  await rm(directory, { recursive: true });
}
