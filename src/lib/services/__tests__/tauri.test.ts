import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const tauriInvoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauriInvoke }));

beforeEach(() => {
  vi.resetModules();
  tauriInvoke.mockReset();
  vi.spyOn(console, "debug").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function expectCommandOnlyLogs(debug: string[], errors: string[] = [], warnings: string[] = []) {
  expect(console.debug).toHaveBeenCalledTimes(debug.length);
  debug.forEach((message, index) => {
    expect(console.debug).toHaveBeenNthCalledWith(index + 1, message);
  });
  expect(console.error).toHaveBeenCalledTimes(errors.length);
  errors.forEach((message, index) => {
    expect(console.error).toHaveBeenNthCalledWith(index + 1, message);
  });
  expect(console.warn).toHaveBeenCalledTimes(warnings.length);
  warnings.forEach((message, index) => {
    expect(console.warn).toHaveBeenNthCalledWith(index + 1, message);
  });
}

it("returns the original result without logging credential arguments or results", async () => {
  const args = { config: { api_key: "synthetic-argument-secret" } };
  const result = { api_key: "synthetic-result-secret" };
  tauriInvoke.mockResolvedValue(result);
  const { invoke, isTauri } = await import("../tauri");

  expect(isTauri).toBe(true);
  await expect(invoke("set_config", args)).resolves.toBe(result);
  expect(tauriInvoke).toHaveBeenCalledExactlyOnceWith("set_config", args);
  expectCommandOnlyLogs([
    "[TauriService] Invoking: set_config",
    "[TauriService] Completed: set_config"
  ]);
});

it.each([
  new Error("synthetic-error-message-secret"),
  "synthetic-rejection-string-secret",
  { message: "synthetic-error-object-secret", config: { api_key: "synthetic-nested-secret" } }
])("rethrows the original rejection without logging its payload (%#)", async (error) => {
  const args = { api_key: "synthetic-rejected-argument-secret" };
  tauriInvoke.mockRejectedValue(error);
  const { tauriService } = await import("../tauri");

  await expect(tauriService.invoke("set_config", args)).rejects.toBe(error);
  expect(tauriInvoke).toHaveBeenCalledExactlyOnceWith("set_config", args);
  expectCommandOnlyLogs(
    ["[TauriService] Invoking: set_config"],
    ["[TauriService] Error invoking: set_config"]
  );
});

it("rejects in browser mode without logging credentials or calling the backend", async () => {
  vi.stubGlobal("window", {});
  const { invoke, isTauri } = await import("../tauri");

  expect(isTauri).toBe(false);
  await expect(invoke("set_config", { api_key: "synthetic-browser-secret" })).rejects.toThrow(
    "Tauri API not available. Cannot invoke command: set_config"
  );
  expect(tauriInvoke).not.toHaveBeenCalled();
  expectCommandOnlyLogs(
    [],
    [],
    ["[TauriService] Tauri API not available (browser mode). Cannot invoke: set_config"]
  );
});
