import { setTimeout as delay } from "node:timers/promises";

export async function waitForGateway({ url, secret, signal, timeoutMs = 30_000 }: {
  url: string;
  secret: string;
  signal: AbortSignal;
  timeoutMs?: number;
}): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let failure = "not_ready";
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    try {
      const response = await fetch(url, {
        headers: { "X-ScoutNews-Gateway-Secret": secret },
        signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.min(1000, deadline - Date.now())))]),
      });
      if (response.ok) {
        const value: unknown = await response.json();
        if (!value || typeof value !== "object" || !("status" in value) || value.status !== "ok" ||
            !("service" in value) || value.service !== "copilot-gateway") {
          throw new Error("gateway_health_response_invalid");
        }
        return;
      }
      failure = `http_${response.status}`;
      await response.body?.cancel();
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof TypeError && error.message === "fetch failed") failure = "connection_unavailable";
      else if (error instanceof DOMException && error.name === "TimeoutError") failure = "request_timeout";
      else throw error;
    }
    await delay(Math.max(1, Math.min(100, deadline - Date.now())), undefined, { signal });
  }
  throw new Error(`gateway_startup_timeout:${failure}`);
}
