// @vitest-environment jsdom

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { cleanup, render, waitFor } from "@testing-library/svelte";
import { waitForI18nReady } from "#lib/i18n";
import { page } from "$app/state";
import AppHeader from "../app-header.svelte";

// Declared before the hoisted mock block below; types are erased, so the hoist is safe.
type ConfigResponse = ReturnType<typeof makeConfig>;

const { listeners, unlistened, ipc, mockInvoke } = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => Promise<void> | void>(),
  unlistened: new Set<() => void>(),
  ipc: {
    listenGate: Promise.resolve()
  },
  mockInvoke: vi.fn()
}));

vi.mock("#lib/services/tauri.js", () => ({ isTauri: true }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (name: string, callback: (event: { payload: unknown }) => Promise<void> | void) => {
      await ipc.listenGate;
      listeners.set(name, callback);
      const unlistenFn = () => {
        listeners.delete(name);
        unlistened.add(unlistenFn);
      };
      return unlistenFn;
    }
  )
}));

function makeConfig(experimental: boolean, history: boolean) {
  return {
    general: { experimental_enabled: experimental },
    history: { enabled: history },
    playback: { duck: { enabled: false, level_percent: 20 }, streaming_enabled: true }
  };
}

beforeAll(async () => {
  await waitForI18nReady();
});

describe("app-header", () => {
  beforeEach(() => {
    listeners.clear();
    unlistened.clear();
    ipc.listenGate = Promise.resolve();
    mockInvoke.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("tracks active route state and links the brand home on sub-pages", async () => {
    mockInvoke.mockResolvedValueOnce(makeConfig(true, true));
    const homeView = render(AppHeader);
    await waitFor(() => {
      expect(homeView.queryByTestId("nav-history")).not.toBeNull();
    });
    const home = homeView.getByTestId("nav-generate");
    expect(home.getAttribute("aria-current")).toBe("page");
    expect(home.hasAttribute("href")).toBe(false);
    expect(
      homeView.getByRole("heading", { name: "CopySpeech" }).closest("a")?.hasAttribute("href")
    ).toBe(false);
    expect(homeView.getByTestId("nav-voices").getAttribute("href")).toBe("/voices");
    homeView.unmount();

    vi.spyOn(page, "url", "get").mockReturnValue(new URL("http://localhost/voices"));
    mockInvoke.mockResolvedValueOnce(makeConfig(false, false));
    const voicesView = render(AppHeader);
    expect(
      voicesView.getByRole("heading", { name: "CopySpeech" }).closest("a")?.getAttribute("href")
    ).toBe("/");
  });

  it("updates history link visibility when config-changed event fires", async () => {
    mockInvoke.mockResolvedValueOnce(makeConfig(false, true));
    const view = render(AppHeader);

    await waitFor(() => {
      expect(view.queryByTestId("nav-generate")).not.toBeNull();
    });
    expect(view.queryByTestId("nav-history")).toBeNull();

    mockInvoke.mockResolvedValueOnce(makeConfig(true, true));
    const configChangedListener = listeners.get("config-changed");
    expect(configChangedListener).toBeDefined();
    await configChangedListener!({ payload: null });

    await waitFor(() => {
      expect(view.queryByTestId("nav-history")).not.toBeNull();
    });
  });

  it("discards stale config fetch responses when a newer fetch resolves first", async () => {
    let resolveFirst!: (val: ConfigResponse) => void;
    const firstFetchPromise = new Promise<ConfigResponse>((resolve) => {
      resolveFirst = resolve;
    });

    mockInvoke.mockImplementationOnce(() => firstFetchPromise);
    const view = render(AppHeader);

    await waitFor(() => {
      expect(listeners.get("config-changed")).toBeDefined();
    });

    mockInvoke.mockResolvedValueOnce(makeConfig(true, true));
    const onConfigChanged = listeners.get("config-changed");
    await onConfigChanged!({ payload: null });

    await waitFor(() => {
      expect(view.queryByTestId("nav-history")).not.toBeNull();
    });

    resolveFirst(makeConfig(false, false));
    await Promise.resolve();
    expect(view.queryByTestId("nav-history")).not.toBeNull();
  });

  it("cleans up late-resolving config-changed listener if component is destroyed mid-onMount", async () => {
    let resolveListenGate!: () => void;
    ipc.listenGate = new Promise((resolve) => {
      resolveListenGate = resolve;
    });
    mockInvoke.mockResolvedValue(makeConfig(true, true));

    const view = render(AppHeader);
    view.unmount();

    resolveListenGate();
    await waitFor(() => {
      expect(unlistened.size).toBe(1);
    });
  });
});
