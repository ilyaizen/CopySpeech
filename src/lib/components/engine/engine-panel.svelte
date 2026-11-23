<script lang="ts">
  // One engine block. Voice and model settings stay in Profiles.

  import { _ } from "svelte-i18n";
  import { Download, Loader2, ExternalLink, Eye, EyeOff } from "@lucide/svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import InfoTooltip from "#lib/components/ui/info-tooltip.svelte";
  import * as Tooltip from "#lib/components/ui/tooltip/index.js";
  import { installStore } from "#lib/stores/install-store.svelte";
  import { openExternal } from "#lib/utils/external-link";
  import type { AppConfig } from "#lib/types";
  import type { EngineSetupEntry, RuntimeStatus, TestState } from "./engine-meta";
  import { engineModels } from "./engine-models";

  // Show this many model chips; the rest expand on demand.
  const MODEL_PREVIEW_COUNT = 3;
  let modelsExpanded = $state(false);

  // Keep each key masked until its own reveal button is used.
  let keyRevealed = $state(false);

  let {
    entry,
    localConfig = $bindable(),
    testState = "idle",
    testMessage = "",
    onTest,
    onInstall,
    onCredentialChange,
    testDisabled = false,
    runtime = null,
    runtimeError = false,
    envKeySources = {}
  }: {
    entry: EngineSetupEntry;
    localConfig: AppConfig;
    testState?: TestState;
    testMessage?: string;
    onTest?: () => void;
    onInstall?: () => void;
    onCredentialChange?: () => void;
    testDisabled?: boolean;
    /** Local engines: probe result from the list. `null` while it loads. */
    runtime?: RuntimeStatus | null;
    runtimeError?: boolean;
    /** engine → winning env var for keys currently provided by .env. */
    envKeySources?: Record<string, string>;
  } = $props();

  const installRunning = $derived(installStore.isRunning(entry.installerId ?? entry.id));
  const models = $derived(engineModels(entry.id));
  const visibleModels = $derived(modelsExpanded ? models : models.slice(0, MODEL_PREVIEW_COUNT));

  function openDocs() {
    openExternal(entry.docsUrl);
  }

  interface CredentialFields {
    api_key?: string;
    endpoint?: string;
  }

  // .env-supplied keys: the backend never sends the raw secret — this map
  // (from get_env_key_sources) says which engine's key currently comes from
  // .env. While the field is untouched we show a sentinel placeholder and no
  // eye toggle (nothing to reveal); a typed key stays editable and the parent
  // warns at save when env precedence would keep shadowing it.
  const envVarName = $derived(
    entry.credentialTarget ? envKeySources[entry.credentialTarget] : undefined
  );
  const showingEnvSentinel = $derived.by(() => {
    if (!envVarName || !entry.credentialTarget) return false;
    return (localConfig.tts[entry.credentialTarget].api_key ?? "") === "";
  });
  const credentialFields: CredentialFields | undefined = $derived(
    entry.credentialTarget ? localConfig.tts[entry.credentialTarget] : undefined
  );
  const configured = $derived(
    entry.credential === "none" ||
      Boolean(
        (envVarName || credentialFields?.api_key?.trim()) &&
        (entry.credential !== "api_key_endpoint" || credentialFields?.endpoint?.trim())
      )
  );
  const canTest = $derived(entry.kind === "local" ? runtime?.installed === true : configured);

  // Status text. Test and install results win over the probe state.
  const statusLabel = $derived.by(() => {
    if (installRunning) return $_("engines.dashboard.installing");
    if (testState === "testing") return $_("engine.testing");
    if (testState === "success") return $_("engine.apiSetup.testPassed");
    if (testState === "fail") return $_("engine.apiSetup.testFailed");
    if (entry.kind === "local") {
      if (runtimeError) return $_("engines.dashboard.statusUnknown");
      if (!runtime) return $_("common.loading");
      return runtime.installed
        ? $_("engines.voiceInstalled")
        : $_("engines.dashboard.notInstalled");
    }
    if (entry.credential === "none") return $_("engines.dashboard.noKey");
    return configured ? $_("engines.dashboard.keySet") : $_("engines.dashboard.keyRequired");
  });
  const statusPositive = $derived(
    testState === "success" || (entry.kind === "local" ? runtime?.installed === true : configured)
  );
  // One status dot per block. Emerald reads as ready, red as failed, muted as
  // pending or needs-attention; the full text lives in the info tooltip.
  const statusDotTone = $derived(
    testState === "fail"
      ? "bg-destructive"
      : statusPositive
        ? "bg-emerald-500"
        : "bg-muted-foreground"
  );
  // A running test or install pulses so in-flight work stays visible.
  const statusBusy = $derived(installRunning || testState === "testing");
  // Tooltip detail: the status text, plus the compute provider once installed.
  const statusDetail = $derived.by(() => {
    if (runtime?.installed && runtime.provider) {
      const provider = runtime.provider === "cuda" ? "GPU (CUDA)" : runtime.provider.toUpperCase();
      return `${statusLabel} · ${provider}`;
    }
    return statusLabel;
  });
</script>

<Tooltip.Provider delayDuration={100}>
  <li class="border-border border-b px-4 py-3 last:border-b-0">
    <div class="space-y-2.5">
      <div class="flex items-center gap-2">
        <span class="font-medium">{entry.menuLabel ?? $_(`engine.${entry.id}.title`)}</span>
        <span
          role="status"
          aria-label={statusLabel}
          class="size-2 shrink-0 rounded-full {statusDotTone} {statusBusy ? 'animate-pulse' : ''}"
        ></span>
        <InfoTooltip text={$_(`engine.${entry.id}.description`)} detail={statusDetail} />
      </div>

      {#if models.length > 0}
        <div class="flex flex-wrap items-center gap-1">
          <span class="text-muted-foreground me-1.5 text-xs">
            {$_("engines.dashboard.availableModels")}
          </span>
          {#each visibleModels as model (model.id)}
            <Tooltip.Root>
              <Tooltip.Trigger
                class="focus-visible:ring-ring bg-muted/60 hover:bg-muted text-muted-foreground hover:text-foreground inline-flex max-w-full items-center rounded-sm px-1.5 py-0.5 transition-colors focus-visible:ring-2 focus-visible:outline-none"
                aria-label={model.id}
                onclick={() => openExternal(model.sourceUrl)}
              >
                <span class="truncate text-xs">{model.label}</span>
              </Tooltip.Trigger>
              <Tooltip.Content>
                <code class="text-xs">{model.id}</code>
              </Tooltip.Content>
            </Tooltip.Root>
          {/each}
          {#if models.length > MODEL_PREVIEW_COUNT}
            <button
              type="button"
              class="text-muted-foreground hover:text-foreground rounded px-1.5 py-0.5 text-xs"
              aria-expanded={modelsExpanded}
              onclick={() => (modelsExpanded = !modelsExpanded)}
            >
              {modelsExpanded ? "−" : `+${models.length - MODEL_PREVIEW_COUNT}`}
            </button>
          {/if}
        </div>
      {/if}

      <div class="flex flex-wrap items-center gap-1.5">
        {#if entry.credentialTarget && credentialFields}
          <div class="relative min-w-0 flex-1 basis-52">
            <Input
              id={`api-key-${entry.id}`}
              aria-label={`${$_(`engine.${entry.id}.title`)} ${$_("engine.apiSetup.apiKey")}`}
              type={keyRevealed ? "text" : "password"}
              autocomplete="off"
              spellcheck={false}
              disabled={testDisabled}
              class="h-8 min-w-0 pe-10 text-sm"
              placeholder={showingEnvSentinel
                ? $_("engine.apiSetup.envSentinel")
                : entry.placeholderKey
                  ? $_(`engine.apiSetup.${entry.placeholderKey}`)
                  : ""}
              value={credentialFields.api_key ?? ""}
              oninput={(e) => {
                if (credentialFields) credentialFields.api_key = e.currentTarget.value;
                onCredentialChange?.();
              }}
            />
            {#if !showingEnvSentinel}
              <button
                type="button"
                class="text-muted-foreground hover:text-foreground focus-visible:ring-ring absolute inset-y-0 end-0 flex w-10 cursor-pointer items-center justify-center rounded focus-visible:ring-2 focus-visible:outline-none"
                onclick={() => (keyRevealed = !keyRevealed)}
                aria-label={`${$_(`engine.${entry.id}.title`)}: ${keyRevealed ? $_("engines.dashboard.hideKey") : $_("engines.dashboard.showKey")}`}
                aria-pressed={keyRevealed}
              >
                {#if keyRevealed}<EyeOff size={14} />{:else}<Eye size={14} />{/if}
              </button>
            {/if}
          </div>
        {:else if entry.installerId}
          <Button
            variant="outline"
            size="sm"
            disabled={testDisabled && !installRunning}
            onclick={() => onInstall?.()}
          >
            {#if installRunning}<Loader2 size={14} class="me-2 animate-spin" />{:else}<Download
                size={14}
                class="me-2"
              />{/if}
            {runtime?.installed === false && !installRunning
              ? $_("engine.setup.install")
              : $_("engine.setup.installManage")}
          </Button>
        {:else}
          <p class="text-muted-foreground text-xs">{$_("engines.noCredentialNeeded")}</p>
        {/if}
        <div class="ms-auto flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            disabled={testDisabled || !canTest}
            onclick={() => onTest?.()}
            aria-label={`${$_("common.test")} ${$_(`engine.${entry.id}.title`)}`}
          >
            {$_("common.test")}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onclick={openDocs}
            aria-label={`${$_(`engine.${entry.id}.title`)}: ${$_("engines.docs")}`}
          >
            <ExternalLink size={14} />
          </Button>
        </div>
      </div>

      {#if envVarName}
        <p class="text-muted-foreground text-xs break-all">
          {envVarName} <span class="font-mono">(.env)</span>
        </p>
      {/if}
      {#if entry.credential === "api_key_endpoint" && credentialFields}
        <Input
          id={`endpoint-${entry.id}`}
          type="url"
          disabled={testDisabled}
          aria-label={`${$_(`engine.${entry.id}.title`)} ${$_("engine.apiSetup.endpointLabel")}`}
          class="h-8 text-sm"
          placeholder={$_("engine.apiSetup.endpointPlaceholder")}
          value={credentialFields.endpoint ?? ""}
          oninput={(e) => {
            if (credentialFields) credentialFields.endpoint = e.currentTarget.value;
            onCredentialChange?.();
          }}
        />
      {/if}
      {#if testState === "fail" && testMessage}
        <p class="text-destructive text-xs [overflow-wrap:anywhere] whitespace-pre-wrap">
          {testMessage}
        </p>
      {/if}
    </div>
  </li>
</Tooltip.Provider>
