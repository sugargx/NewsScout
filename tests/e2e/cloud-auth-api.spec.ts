import { expect, test } from "@playwright/test";
import { QueryClient, onlineManager } from "@tanstack/react-query";
import { api, SessionChangedError, setSessionCsrfToken, suspendSessionRequests } from "../../apps/web/src/api";

test("queued mutations cannot adopt a second identity and verification blocks dispatch", async () => {
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalFetch = globalThis.fetch;
  const requests: { path: string; csrf: string | null }[] = [];
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: { dataset: { deployment: "azure" } } } });
  globalThis.fetch = async (input, init) => {
    requests.push({ path: String(input), csrf: new Headers(init?.headers).get("X-CSRF-Token") });
    return Response.json({ items: [] });
  };
  try {
    setSessionCsrfToken("reader-a-token", "reader-a");
    onlineManager.setOnline(false);
    const mutation = client.getMutationCache().build(client, { mutationFn: api.saveTopics });
    const result = mutation.execute([]).catch(error => error);
    await expect.poll(() => mutation.state.isPaused).toBe(true);
    expect(() => setSessionCsrfToken("reader-b-token", "reader-b")).toThrow(SessionChangedError);
    onlineManager.setOnline(true);
    await client.resumePausedMutations();
    expect((await result).name).toBe("AbortError");
    expect(requests).toHaveLength(0);

    setSessionCsrfToken("reader-a-token", "reader-a");
    suspendSessionRequests();
    const pending = api.saveTopics([]);
    await Promise.resolve();
    expect(requests).toHaveLength(0);
    setSessionCsrfToken("reader-a-renewed", "reader-a");
    await pending;
    expect(requests).toEqual([{ path: "/api/v1/me/interests", csrf: "reader-a-renewed" }]);

    let deliver: ((response: Response) => void) | undefined;
    let exported = false;
    globalThis.fetch = () => new Promise<Response>(resolve => { deliver = resolve; });
    const oldExport = api.exportData().then(() => { exported = true; }, error => error);
    await expect.poll(() => !!deliver).toBe(true);
    suspendSessionRequests();
    deliver!(Response.json({ userId: "reader-a", privateSentinel: "must-not-download-as-b" }));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(exported).toBe(false);
    expect(() => setSessionCsrfToken("reader-b-token", "reader-b")).toThrow(SessionChangedError);
    expect((await oldExport).name).toBe("AbortError");
    expect(exported).toBe(false);
  } finally {
    setSessionCsrfToken(null);
    client.clear();
    onlineManager.setOnline(true);
    globalThis.fetch = originalFetch;
    if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
