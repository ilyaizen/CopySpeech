import { expect, it, vi } from "vite-plus/test";
import { createLayoutStartup } from "../layout-startup";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  tauriInvoke: vi.fn(),
  startHistoryEventListeners: vi.fn(),
  stopHistoryEventListeners: vi.fn()
}));
vi.mock("#lib/services/tauri", () => ({ invoke: mocks.invoke, isTauri: true }));
vi.mock("#lib/utils/history-events", () => ({
  startHistoryEventListeners: mocks.startHistoryEventListeners,
  stopHistoryEventListeners: mocks.stopHistoryEventListeners
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.tauriInvoke }));

function shell(hasConfig: boolean, hud = false, pathname = "/") {
  vi.resetAllMocks();
  const live = new Map<
    string,
    (event: { payload: { text: string; trigger: unknown } }) => Promise<void>
  >();
  const unlisteners: ReturnType<typeof vi.fn>[] = [];
  const listen = mocks.listen.mockImplementation(
    async (
      name: string,
      callback: (event: { payload: { text: string; trigger: unknown } }) => Promise<void>
    ) => {
      live.set(name, callback);
      const unlisten = vi.fn(() => {
        live.delete(name);
      });
      unlisteners.push(unlisten);
      return unlisten;
    }
  );
  const page = { url: { pathname } };
  const goto = vi.fn(async (path: string) => {
    page.url.pathname = path;
  });
  const invoke = mocks.invoke.mockResolvedValue(hasConfig);
  const syncConfig = vi.fn(async () => {});
  const lifecycle = createLayoutStartup({
    isWeb: false,
    isHudWindow: hud,
    isHud: () => page.url.pathname === "/hud",
    pathname: () => page.url.pathname,
    goto,
    syncConfig
  });
  return {
    ...lifecycle,
    live,
    listen,
    unlisteners,
    goto,
    invoke,
    syncConfig,
    tauriInvoke: mocks.tauriInvoke,
    startHistoryEventListeners: mocks.startHistoryEventListeners,
    stopHistoryEventListeners: mocks.stopHistoryEventListeners
  };
}

it("keeps process-wide listeners after missing-config navigation and onboarding completion", async () => {
  const app = shell(false);
  await app.mount();
  expect(app.goto).toHaveBeenCalledWith("/onboarding");
  expect(app.startHistoryEventListeners).toHaveBeenCalledOnce();
  expect(app.live.has("speak-request")).toBe(true);
  await app.goto("/");
  const trigger = { source: "clipboard" };
  await app.live.get("speak-request")!({ payload: { text: "Read this", trigger } });
  expect(app.tauriInvoke).toHaveBeenCalledWith("speak_queued", { text: "Read this", trigger });
  expect(app.startHistoryEventListeners).toHaveBeenCalledOnce();
  await app.destroy();
  expect(app.stopHistoryEventListeners).toHaveBeenCalledOnce();
  expect(app.live.size).toBe(0);
  for (const unlisten of app.unlisteners) expect(unlisten).toHaveBeenCalledOnce();
});

it("installs listeners on existing-config startup without onboarding navigation", async () => {
  const app = shell(true);
  await app.mount();
  expect(app.goto).not.toHaveBeenCalled();
  expect(app.startHistoryEventListeners).toHaveBeenCalledOnce();
  expect(app.live.has("speak-request")).toBe(true);
  await app.destroy();
});

it.each([
  [true, "/"],
  [false, "/hud"]
] as const)("isolates HUD label %s at %s", async (label, path) => {
  const app = shell(false, label, path);
  await app.mount();
  expect(app.invoke).not.toHaveBeenCalled();
  expect(app.syncConfig).not.toHaveBeenCalled();
  expect(app.listen).not.toHaveBeenCalled();
  expect(app.startHistoryEventListeners).not.toHaveBeenCalled();
  if (label) expect(app.goto).toHaveBeenCalledWith("/hud", { replaceState: true });
  await app.destroy();
});

it.each(["open-settings", "speak-request"])(
  "unlistens a %s registration that resolves after teardown",
  async (eventName) => {
    const app = shell(false);
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const register = app.listen.getMockImplementation()!;
    app.listen.mockImplementation(async (name, callback) => {
      if (name === eventName) {
        await app.destroy();
        await pending;
      }
      return register(name, callback);
    });
    const mounting = app.mount();
    release();
    await mounting;
    expect(app.live.size).toBe(0);
    for (const unlisten of app.unlisteners) expect(unlisten).toHaveBeenCalledOnce();
  }
);
