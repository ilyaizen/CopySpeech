import { invoke, isTauri } from "#lib/services/tauri";
import { startHistoryEventListeners, stopHistoryEventListeners } from "#lib/utils/history-events";

interface StartupOptions {
  isWeb: boolean;
  isHudWindow: boolean;
  isHud: () => boolean;
  pathname: () => string;
  goto: (path: string, options?: { replaceState: boolean }) => Promise<void>;
  syncConfig: () => Promise<void>;
}

// Each layout owns its registrations, including registrations that finish after teardown.
export function createLayoutStartup(options: StartupOptions) {
  let unlistenSpeak: (() => void) | null = null;
  let unlistenSettings: (() => void) | null = null;
  let destroyed = false;

  async function mount() {
    if (options.isWeb) return;
    if (options.isHudWindow && options.pathname() !== "/hud") {
      await options.goto("/hud", { replaceState: true });
      return;
    }
    if (options.isHud()) return;

    if (isTauri) {
      const { listen } = await import("@tauri-apps/api/event");
      unlistenSettings = await listen("open-settings", () => {
        void options.goto("/settings");
      });
      if (destroyed) unlistenSettings();
    }

    await options.syncConfig();

    // Navigation keeps the layout mounted. First-run setup still needs shell listeners.
    try {
      const hasConfig = await invoke<boolean>("config_exists");
      if (!hasConfig && !destroyed) void options.goto("/onboarding");
    } catch (e) {
      console.error("Failed to check config:", e);
    }

    // HMR can destroy the layout while startup awaits.
    if (destroyed) return;
    await startHistoryEventListeners();

    if (isTauri) {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
        unlistenSpeak = await listen<{ text: string; trigger: unknown }>(
          "speak-request",
          async (e) => {
            console.log("[LAYOUT] speak-request received, text length:", e.payload.text.length);
            try {
              // Queue large texts as fragments and preserve the browser companion trigger.
              await tauriInvoke("speak_queued", {
                text: e.payload.text,
                trigger: e.payload.trigger
              });
              console.log("[LAYOUT] speak_queued completed successfully");
            } catch (err) {
              console.error("[LAYOUT] speak_queued failed:", err);
            }
          }
        );
        if (destroyed) unlistenSpeak();
        console.log("[LAYOUT] speak-request listener registered");
      } catch (e) {
        console.error("Failed to set up listeners:", e);
      }
    }
  }

  async function destroy() {
    destroyed = true;
    if (options.isWeb) return;
    await stopHistoryEventListeners();
    if (unlistenSpeak) unlistenSpeak();
    if (unlistenSettings) unlistenSettings();
  }

  return { mount, destroy };
}
