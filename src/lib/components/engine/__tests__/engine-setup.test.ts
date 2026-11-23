// @vitest-environment jsdom

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { waitForI18nReady } from "#lib/i18n";
import { testConfig } from "#lib/test-fixtures/app-config";
import { ALL_SETUP_ENTRIES, CLOUD_ENGINES, LOCAL_ENGINES } from "../engine-meta";
import EngineSetup from "../engine-setup.svelte";
import UvNotice from "../uv-notice.svelte";
import { installStore } from "#lib/stores/install-store.svelte";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("svelte-sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeAll(async () => {
  await waitForI18nReady();
});

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "engine_runtime_status") return { installed: false, provider: null };
    if (command === "engine_status") return { installed: true, voices: [] };
    if (command === "test_tts_engine_config") return { success: true, message: "ok" };
    if (command === "install_engine") return undefined;
    throw new Error(`Unexpected command: ${command}`);
  });
});

afterEach(() => {
  cleanup();
  for (const run of Object.values(installStore.runs)) run.running = false;
  Reflect.deleteProperty(installStore.runs, "uv");
  Reflect.deleteProperty(installStore.runs, "kokoro");
});

describe("engine configuration dashboard", () => {
  it("filters rows, masks keys, uses unique field ids, and shows environment sentinels", async () => {
    const config = testConfig();
    config.tts.openai.api_key = "test-key";
    const view = render(EngineSetup, {
      localConfig: config,
      isDirty: false,
      onSave: vi.fn(),
      envKeySources: { fish: "FISH_API_KEY" }
    });

    expect(view.getAllByRole("row")).toHaveLength(ALL_SETUP_ENTRIES.length + 1);
    const input = view.getByLabelText("OpenAI API Key");
    if (!(input instanceof HTMLInputElement)) throw new Error("Expected an API key input");
    expect(input.type).toBe("password");
    await fireEvent.click(view.getByRole("button", { name: "OpenAI: Show API key" }));
    expect(input.type).toBe("text");
    const fields = [...view.container.querySelectorAll("input")];
    expect(new Set(fields.map((field) => field.id)).size).toBe(fields.length);
    expect(view.getByText("FISH_API_KEY", { exact: false })).toBeTruthy();
    expect(view.queryByRole("button", { name: /Fish.*Show API key/ })).toBeNull();
    expect(view.getByRole("button", { name: /Test Fish/ }).hasAttribute("disabled")).toBe(false);
    expect(
      view.getByRole("button", { name: "Test Microsoft Foundry" }).hasAttribute("disabled")
    ).toBe(true);

    await fireEvent.click(view.getByRole("button", { name: "Local" }));
    expect(view.getAllByRole("row")).toHaveLength(LOCAL_ENGINES.length + 1);
    await fireEvent.click(view.getByRole("button", { name: "Cloud" }));
    expect(view.getAllByRole("row")).toHaveLength(CLOUD_ENGINES.length + 1);
    expect(
      invokeMock.mock.calls.every(
        ([cmd, args]) =>
          cmd === "engine_runtime_status" || (cmd === "engine_status" && args?.engine === "uv")
      )
    ).toBe(true);
  });

  it("waits for saving before testing and blocks other tests during that wait", async () => {
    const config = testConfig();
    config.tts.openai.api_key = "test-key";
    let finishSave!: () => void;
    const onSave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        })
    );
    const view = render(EngineSetup, { localConfig: config, isDirty: true, onSave });
    await fireEvent.click(view.getByRole("button", { name: "Test OpenAI" }));
    expect(onSave).toHaveBeenCalledOnce();
    expect(invokeMock).not.toHaveBeenCalledWith("test_tts_engine_config", expect.anything());
    expect(view.getByRole("button", { name: "Test OpenAI" }).hasAttribute("disabled")).toBe(true);
    finishSave();
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("test_tts_engine_config", { engine: "openai" })
    );
    await waitFor(() =>
      expect(view.getByRole("status", { name: "Engine Test Passed" })).toBeTruthy()
    );
    await fireEvent.input(view.getByLabelText("OpenAI API Key"), {
      target: { value: "replacement" }
    });
    expect(view.queryByRole("status", { name: "Engine Test Passed" })).toBeNull();
  });

  it("does not test when saving fails or awaits an environment warning", async () => {
    const config = testConfig();
    config.tts.openai.api_key = "test-key";
    const onSave = vi.fn().mockRejectedValue(new Error("Save deferred"));
    const view = render(EngineSetup, { localConfig: config, isDirty: true, onSave });
    await fireEvent.click(view.getByRole("button", { name: "Test OpenAI" }));
    await waitFor(() =>
      expect(view.getByRole("button", { name: "Test OpenAI" }).hasAttribute("disabled")).toBe(false)
    );
    expect(invokeMock).not.toHaveBeenCalledWith("test_tts_engine_config", expect.anything());
  });

  it("reports failed runtime probes without claiming an engine is uninstalled", async () => {
    invokeMock.mockRejectedValue(new Error("Probe unavailable"));
    const view = render(EngineSetup, {
      localConfig: testConfig(),
      isDirty: false,
      onSave: vi.fn()
    });
    await waitFor(() =>
      expect(view.getAllByRole("status", { name: "Status unavailable" })).toHaveLength(
        LOCAL_ENGINES.length
      )
    );
    expect(view.queryByRole("status", { name: "Not installed" })).toBeNull();
    expect(view.getByRole("button", { name: "Test Kokoro TTS" }).hasAttribute("disabled")).toBe(
      true
    );
  });

  it("keeps the test lock when an installer starts and settles during a request", async () => {
    const config = testConfig();
    config.tts.openai.api_key = "test-key";
    let finishTest!: (result: { success: boolean; message: string }) => void;
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "engine_runtime_status") return { installed: true, provider: "cpu" };
      if (command === "test_tts_engine_config") {
        return new Promise<{ success: boolean; message: string }>((resolve) => {
          finishTest = resolve;
        });
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const view = render(EngineSetup, { localConfig: config, isDirty: false, onSave: vi.fn() });
    await fireEvent.click(view.getByRole("button", { name: "Test OpenAI" }));
    await installStore.start("kokoro", []);
    await waitFor(() =>
      expect(view.getByRole("status", { name: "Install in progress" })).toBeTruthy()
    );
    const run = installStore.run("kokoro");
    if (!run) throw new Error("Expected an installer run");
    run.running = false;
    await waitFor(() =>
      expect(view.queryByRole("status", { name: "Install in progress" })).toBeNull()
    );
    expect(view.getByRole("button", { name: "Test Edge TTS" }).hasAttribute("disabled")).toBe(true);
    finishTest({ success: true, message: "ok" });
    await waitFor(() =>
      expect(view.getByRole("button", { name: "Test OpenAI" }).hasAttribute("disabled")).toBe(false)
    );
  });

  it("clears completed results and discards pending ones when config replacement runs", async () => {
    const config = testConfig();
    config.tts.openai.api_key = "test-key";
    const view = render(EngineSetup, { localConfig: config, isDirty: false, onSave: vi.fn() });
    await fireEvent.click(view.getByRole("button", { name: "Test OpenAI" }));
    await waitFor(() =>
      expect(view.getByRole("status", { name: "Engine Test Passed" })).toBeTruthy()
    );
    await view.rerender({ localConfig: testConfig() });
    expect(view.queryByRole("status", { name: "Engine Test Passed" })).toBeNull();

    let finishTest!: (result: { success: boolean; message: string }) => void;
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "engine_runtime_status") return { installed: false, provider: null };
      if (command === "test_tts_engine_config") {
        return new Promise<{ success: boolean; message: string }>((resolve) => {
          finishTest = resolve;
        });
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const config2 = testConfig();
    config2.tts.openai.api_key = "test-key";
    await view.rerender({ localConfig: config2 });
    await fireEvent.click(view.getByRole("button", { name: "Test OpenAI" }));
    await view.rerender({ localConfig: testConfig() });
    expect(view.getByRole("button", { name: "Test Edge TTS" }).hasAttribute("disabled")).toBe(true);
    finishTest({ success: false, message: "Stale provider error" });
    await waitFor(() =>
      expect(view.getByRole("button", { name: "Test Edge TTS" }).hasAttribute("disabled")).toBe(
        false
      )
    );
    expect(view.queryByText("Stale provider error")).toBeNull();
    expect(view.queryByRole("status", { name: "Engine Test Failed" })).toBeNull();
  });

  it("uses one-shot synthesis for installed local engines without saving cloud keys", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "engine_runtime_status") return { installed: true, provider: "cpu" };
      if (command === "test_local_engine") return { success: false, message: "Missing model" };
      throw new Error(`Unexpected command: ${command}`);
    });
    const onSave = vi.fn();
    const view = render(EngineSetup, { localConfig: testConfig(), isDirty: true, onSave });
    const button = view.getByRole("button", { name: "Test Kokoro TTS" });
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    await fireEvent.click(button);
    await waitFor(() => expect(view.getByText("Missing model")).toBeTruthy());
    expect(onSave).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith("test_local_engine", { engine: "kokoro" });
  });
});

describe("uv notice", () => {
  const TITLE = "uv is needed for local engines";
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  function mockProbe(installed: boolean) {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "engine_status") return { installed, voices: [] };
      if (command === "install_engine") return undefined;
      throw new Error("Unexpected command: " + command);
    });
  }

  it("shows Install when uv is missing and disables it while another engine installs", async () => {
    mockProbe(false);
    const view = render(UvNotice, {});
    expect(await view.findByText(TITLE)).toBeTruthy();
    const button = view.getByRole("button", { name: "Install uv" });
    expect(button.hasAttribute("disabled")).toBe(false);

    await installStore.start("kokoro", []);
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(true));
  });

  it("renders nothing when uv is found or the probe fails", async () => {
    mockProbe(true);
    const foundView = render(UvNotice, {});
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("engine_status", { engine: "uv" }));
    await settle();
    expect(foundView.queryByRole("status")).toBeNull();
    foundView.unmount();

    invokeMock.mockRejectedValue(new Error("probe unavailable"));
    const failedView = render(UvNotice, {});
    await settle();
    expect(failedView.queryByRole("status")).toBeNull();
  });

  it("hides Install during an active uv run, re-checks on failure, and offers Retry", async () => {
    mockProbe(false);
    await installStore.start("uv", []);
    const view = render(UvNotice, {});
    expect(await view.findByText("Installing uv…")).toBeTruthy();
    expect(view.queryByRole("button")).toBeNull();

    installStore.fail("uv", "[ERROR] install did not start: boom");
    await waitFor(() =>
      expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "engine_status")).toHaveLength(2)
    );
    expect(await view.findByText("Install failed.")).toBeTruthy();
    expect(view.getByText("The uv installer did not start. Check the install log.")).toBeTruthy();
    expect(view.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
