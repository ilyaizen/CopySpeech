<script lang="ts">
  // Save credentials before cloud tests, which read persisted configuration.

  import { onDestroy, untrack } from "svelte";
  import { toast } from "svelte-sonner";
  import { _ } from "svelte-i18n";
  import { invoke } from "@tauri-apps/api/core";
  import EnginePanel from "./engine-panel.svelte";
  import InstallDialog from "./install-dialog.svelte";
  import UvNotice from "./uv-notice.svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import { installStore } from "#lib/stores/install-store.svelte";
  import {
    ALL_SETUP_ENTRIES,
    LOCAL_ENGINES,
    type EngineSetupEntry,
    type RuntimeStatus,
    type TestState
  } from "./engine-meta";
  import type { AppConfig } from "#lib/types";

  let {
    localConfig = $bindable(),
    isDirty = false,
    onSave,
    envKeySources = {}
  }: {
    localConfig: AppConfig;
    isDirty: boolean;
    onSave: () => Promise<void>;
    /** engine → winning env var for keys currently provided by .env. */
    envKeySources?: Record<string, string>;
  } = $props();

  // "Installed" lists local engines with a verified install. Cloud engines never count.
  type Filter = "all" | "installed" | "local" | "cloud";
  const filters = ["all", "installed", "local", "cloud"] as const satisfies readonly Filter[];
  let filter = $state<Filter>("all");

  // Local-engine probe results, keyed by engine id. `null` while a probe runs.
  let runtimeStatuses = $state<Record<string, RuntimeStatus | null>>({});
  let runtimeErrors = $state<Record<string, boolean>>({});
  const probeRevisions: Record<string, number> = {};

  const visibleEntries = $derived(
    ALL_SETUP_ENTRIES.filter((entry) => {
      if (filter === "all") return true;
      if (filter === "installed") {
        return entry.kind === "local" && runtimeStatuses[entry.id]?.installed === true;
      }
      return entry.kind === filter;
    })
  );
  let activeTest = $state<string | null>(null);
  const testing = $derived(activeTest !== null);
  const installing = $derived(Object.values(installStore.runs).some((run) => run.running));

  let testStates = $state<Record<string, TestState>>({});
  let testMessages = $state<Record<string, string>>({});
  const testRevisions: Record<string, number> = {};
  let destroyed = false;
  onDestroy(() => {
    destroyed = true;
  });

  function clearTest(id: string) {
    testRevisions[id] = (testRevisions[id] ?? 0) + 1;
    testStates = { ...testStates, [id]: "idle" };
    testMessages = { ...testMessages, [id]: "" };
  }

  // Observe replacements too, including Cancel from the shared save bar.
  for (const entry of ALL_SETUP_ENTRIES) {
    const target = entry.credentialTarget;
    if (!target) continue;
    $effect(() => {
      void localConfig.tts[target].api_key;
      if (target === "microsoft") void localConfig.tts.microsoft.endpoint;
      void envKeySources[target];
      untrack(() => clearTest(entry.id));
    });
  }
  // Bumped whenever an install/uninstall settles so the runtime probe re-runs.
  let runtimeProbeKey = $state(0);
  // Non-null opens the streamed install/uninstall drawer for that engine.
  let installDialogEntry = $state<EngineSetupEntry | null>(null);

  async function probeRuntime(entry: EngineSetupEntry) {
    const revision = (probeRevisions[entry.id] ?? 0) + 1;
    probeRevisions[entry.id] = revision;
    const isCurrent = () => !destroyed && probeRevisions[entry.id] === revision;
    runtimeStatuses = { ...runtimeStatuses, [entry.id]: null };
    runtimeErrors = { ...runtimeErrors, [entry.id]: false };
    try {
      const status = await invoke<RuntimeStatus>("engine_runtime_status", { engine: entry.id });
      if (isCurrent()) runtimeStatuses = { ...runtimeStatuses, [entry.id]: status };
    } catch {
      if (isCurrent()) runtimeErrors = { ...runtimeErrors, [entry.id]: true };
    }
  }

  for (const entry of LOCAL_ENGINES) {
    $effect(() => {
      void installStore.isRunning(entry.installerId ?? entry.id);
      void runtimeProbeKey;
      untrack(() => {
        clearTest(entry.id);
        void probeRuntime(entry);
      });
    });
  }

  function testState(id: string): TestState {
    return activeTest === id ? "testing" : (testStates[id] ?? "idle");
  }

  async function runTest(entry: EngineSetupEntry) {
    if (testing || installing || installDialogEntry) return;
    activeTest = entry.id;
    clearTest(entry.id);
    const revision = testRevisions[entry.id];
    const isCurrent = () => !destroyed && testRevisions[entry.id] === revision;
    try {
      if (entry.kind === "cloud" && isDirty) {
        try {
          await onSave();
        } catch {
          if (isCurrent()) {
            clearTest(entry.id);
            toast.error($_("engines.saveBeforeTestFailed"));
          }
          return;
        }
      }
      if (!isCurrent()) return;
      const result = await invoke<{ success: boolean; message: string }>(
        entry.kind === "local" ? "test_local_engine" : "test_tts_engine_config",
        { engine: entry.installerId ?? entry.id }
      );
      if (!isCurrent()) return;
      testStates = { ...testStates, [entry.id]: result.success ? "success" : "fail" };
      testMessages = { ...testMessages, [entry.id]: result.message };
    } catch (e) {
      if (!isCurrent()) return;
      testStates = { ...testStates, [entry.id]: "fail" };
      testMessages = { ...testMessages, [entry.id]: String(e) };
    } finally {
      activeTest = null;
    }
  }

  // Every installable engine goes through the drawer: it owns the streamed
  // log, the voice picker, and uninstall. Nothing installs fire-and-forget,
  // so a failure can no longer look like a success.
  function runInstall(entry: EngineSetupEntry) {
    if (!entry.installerId || testing || (installing && !installStore.isRunning(entry.installerId)))
      return;
    installDialogEntry = entry;
  }
</script>

<section class="min-w-0 space-y-5 pb-20" aria-label={$_("engines.dashboard.title")}>
  <header>
    <div class="space-y-1.5">
      <h1 class="text-2xl font-semibold tracking-tight">{$_("engines.dashboard.title")}</h1>
      <p class="text-muted-foreground max-w-2xl text-sm">{$_("engines.dashboard.description")}</p>
    </div>
  </header>

  <UvNotice />

  <div class="settings-card bg-card rounded-lg border">
    <div
      class="inline-flex flex-wrap gap-1 pb-3"
      role="group"
      aria-label={$_("engines.dashboard.filter")}
    >
      {#each filters as kind (kind)}
        <Button
          variant={filter === kind ? "default" : "ghost"}
          size="sm"
          aria-pressed={filter === kind}
          onclick={() => (filter = kind)}
        >
          {#if kind === "installed"}
            {$_("engines.voiceInstalled")}
          {:else if kind === "all"}
            {$_("engines.dashboard.all")}
          {:else}
            {$_(`engine.kind.${kind}`)}
          {/if}
        </Button>
      {/each}
    </div>
    <ul class="border-border rounded-md border" aria-label={$_("engines.dashboard.title")}>
      {#each visibleEntries as entry (entry.id)}
        <EnginePanel
          bind:localConfig
          {entry}
          testState={testState(entry.id)}
          testMessage={testMessages[entry.id] ?? ""}
          testDisabled={testing || installing || installDialogEntry !== null}
          onTest={() => runTest(entry)}
          onInstall={() => runInstall(entry)}
          onCredentialChange={() => clearTest(entry.id)}
          runtime={runtimeStatuses[entry.id] ?? null}
          runtimeError={runtimeErrors[entry.id] ?? false}
          {envKeySources}
        />
      {/each}
    </ul>
  </div>

  {#if installDialogEntry}
    <InstallDialog
      entry={installDialogEntry}
      onclose={() => (installDialogEntry = null)}
      onchange={() => {
        // A settled install flips the runtime chip and stale test verdicts
        // would be misleading after the change.
        for (const entry of LOCAL_ENGINES) clearTest(entry.id);
        runtimeProbeKey += 1;
      }}
    />
  {/if}
</section>
