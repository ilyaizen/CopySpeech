import { invoke as tauriInvoke } from "@tauri-apps/api/core";

// Invoke argument payloads derive from @tauri-apps/api's own invoke contract
// (arbitrary per-command JSON), so the type is owned by the API, not us.
type InvokeArgs = Parameters<typeof tauriInvoke>[1];

export const isTauri = "window" in globalThis && "__TAURI_INTERNALS__" in window;

/**
 * Service to handle Tauri API interactions.
 * Centralizes invoke calls for better error handling and debugging.
 */
export class TauriService {
  private static instance: TauriService;

  private constructor() {}

  public static getInstance(): TauriService {
    if (!TauriService.instance) {
      TauriService.instance = new TauriService();
    }
    return TauriService.instance;
  }

  /**
   * Wrapper for Tauri's invoke function with error handling and logging.
   * safely handles instances where Tauri API might not be available (e.g. browser dev)
   */
  public async invoke<T>(cmd: string, args?: InvokeArgs): Promise<T> {
    if (isTauri) {
      try {
        // IPC payloads and errors can contain credentials. Log command names only.
        console.debug(`[TauriService] Invoking: ${cmd}`);
        const result = await tauriInvoke<T>(cmd, args);
        console.debug(`[TauriService] Completed: ${cmd}`);
        return result;
      } catch (error) {
        console.error(`[TauriService] Error invoking: ${cmd}`);
        throw error;
      }
    } else {
      console.warn(`[TauriService] Tauri API not available (browser mode). Cannot invoke: ${cmd}`);
      throw new Error(`Tauri API not available. Cannot invoke command: ${cmd}`);
    }
  }
}

export const tauriService = TauriService.getInstance();

// Export a direct invoke function for convenience, maintaining the signature
export const invoke = <T>(cmd: string, args?: InvokeArgs) => tauriService.invoke<T>(cmd, args);
