<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { playbackStore } from "#lib/stores/playback-store.svelte";
  import { isTauri } from "#lib/services/tauri.js";
  import { invoke } from "@tauri-apps/api/core";

  let audioEl = $state<HTMLAudioElement | null>(null);

  // Rodio is only a safety net; the tray follows the audible webview pipeline.
  $effect(() => {
    const playing = playbackStore.isPlaying;
    const paused = playbackStore.isPaused;
    if (!isTauri) return;
    void invoke("set_tray_playback_state", { playing, paused }).catch((error) => {
      console.error("Failed to sync tray playback state:", error);
    });
  });

  onMount(() => {
    playbackStore.setAudioElement(audioEl);
    void playbackStore.setupListeners().catch((error) => {
      console.error("Failed to set up playback listeners:", error);
    });
  });

  onDestroy(() => {
    playbackStore.teardownListeners();
    playbackStore.setAudioElement(null);
  });
</script>

<!-- svelte-ignore a11y_media_has_caption -->
<audio bind:this={audioEl} style="display:none"></audio>
