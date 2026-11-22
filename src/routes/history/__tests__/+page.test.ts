// @vitest-environment jsdom

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { cleanup, render, waitFor } from "@testing-library/svelte";
import { waitForI18nReady } from "#lib/i18n";
import HistoryRoute from "../+page.svelte";
import { goto } from "$app/navigation";
import { invoke } from "#lib/services/tauri";

vi.mock("#lib/services/tauri", () => ({
  isTauri: true,
  invoke: vi.fn()
}));

vi.mock("#lib/stores/history-store.svelte.js", () => ({
  historyStore: {
    items: [
      {
        id: "secret-1",
        timestamp: Date.now(),
        text: "Confidential User Reading",
        tts_engine: "cartesia",
        voice: "saved",
        speed: 1,
        success: true,
        output_path: "/audio/1.wav"
      }
    ],
    loadHistory: vi.fn()
  }
}));

function makeConfig(experimental: boolean, history: boolean) {
  return {
    general: { experimental_enabled: experimental },
    history: { enabled: history }
  };
}

beforeAll(async () => {
  await waitForI18nReady();
});

describe("history route experimental gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows private history only when effective and otherwise redirects home without leaking data", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(makeConfig(false, true));
    const gatedView = render(HistoryRoute);
    await waitFor(() => {
      expect(goto).toHaveBeenCalledWith("/", { replaceState: true });
    });
    expect(gatedView.queryByText(/Confidential User Reading/)).toBeNull();
    expect(gatedView.queryByTestId("history-inactive")).not.toBeNull();
    gatedView.unmount();

    vi.clearAllMocks();
    vi.mocked(invoke).mockResolvedValueOnce(makeConfig(true, true));
    const allowedView = render(HistoryRoute);
    await waitFor(() => {
      expect(allowedView.queryByText(/Confidential User Reading/)).not.toBeNull();
    });
    expect(goto).not.toHaveBeenCalled();
    expect(allowedView.queryByTestId("history-inactive")).toBeNull();
  });
});
