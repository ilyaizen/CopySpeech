# Failure log by area

Area gotchas from shipped work, one imperative line each. `AGENTS.md` keeps the lines every session needs and points here by area. Read an area's section before editing it. Add a line only for a mistake that can recur. Skip dates, commit hashes, and incident stories.

## Playback

- Double-copy and browser readings run `speak_queued`. The Play page, hotkey, and control server run `speak_now`. Change both paths together.
- Wire playback controls through `playbackStore` (webview audio). Rust `toggle_pause`/`skip_forward`/`skip_backward` drive only the Rodio safety-net player, which you never hear.
- `speak_now`'s return is neither playback start nor completion. Only the webview store's `finishPlayback`/`handleStop` → `playback-finished` → `playback_signal` chain means completion. Every terminal path must emit it, or blocking `/speak --wait` callers hang until the 600 s cap. Answer a non-wait `/speak` when `speak_requests::is_audible` reports its reading audible.
- A fragment queue that waits across synthesis gaps needs a terminal release on every early exit (`reading-failed`, `playback-stream-failed`, `browser-reading {active:false}`), and on `pagination:complete` (`markReadingComplete`). Otherwise `playback-finished` never fires and `/speak --wait` hangs.
- Route speed and pitch through `TimeStretcher` (SoundTouch `pitch`, then `stretch.tempo = speed / pitch`). Keep `playbackRate` at 1 on PCM sources. On a rate change, re-stretch only unstarted PCM sources.
- Give `TimeStretcher`'s first output after every reset a ~5 ms fade-in, and hold the last ~5 ms of input out of the WSOLA flush. Otherwise fragment seams click.
- Anchor PCM skip targets to `_stallPosition` in `pcm-stream.ts`. `_mediaNow()` collapses to 0 when no scheduled source covers the playhead, so `mediaNow - n` alone jumps to the timeline start.
- Re-sync `playbackStore` from its own `config-changed` listener. Pages that only `set_config` never update it.
- Gate streaming playback off when the active profile has an effect: the PCM scheduler has no effect chain. Only the `audio-fragment-ready` path applies effects.
- Emit the streaming `is_final` marker on the last fragment only. An intermediate one arms the completion timer mid-passage.
- Signal a failed streamed reading with `playback-stream-failed` and its `session_id`, never `playback-stop` (which cuts every reading).
- Reset a completed reading's retained replay fragments when the next reading starts. A streamed reading queues none and would inherit them.
- Give each reading `AbortScope::begin_reading()` or `begin_reading_for_request(request)` and check `scope.aborted()`. `begin()` and `begin_for_request()` are helper scopes with reading id 0. Never clear the global abort state at a reading's start: it un-aborts a stream still draining.
- Attribute every playback event to one reading. Carry `reading_id` on `audio-stream-chunk`, `pagination:complete`, `playback-stream-failed`, `reading-failed`, and `audio-fragment-ready`. Match by `reading_id` first, then `session_id` for id-less events. Only the reading that owns a scheduler can feed it.
- Never let two readings play at once. Streamed audio runs through `PcmStreamScheduler` and batch fragments through `<audio>`. Both start paths check the other engine first, and `_drainHeldAudio` hands the speakers over when the active reading finishes. Hold another reading's chunks per reading id in `_heldStreamRuns`. Bound them at 4 runs and 32 MiB of base64: drop the oldest waiting reading, refuse one that cannot fit, and ignore late chunks of dropped, refused, or failed readings.
- `playback-started` covers a playback run, not a reading. `_startedEmitted` clears only on `playback-finished`, so a queued reading that joins the active queue emits no second one.
- Claim speaker ownership (`PlaybackOwner`) when a reading becomes audible (`playback-started` with its `reading_id`), not while it synthesizes. `playback-finished` releases it. A scoped stop then cuts only the owning reading. Do not reintroduce `StreamRearm` or a per-chunk streamed claim.
- A scoped stop of a waiting reading emits `playback-reading-dropped`; the store drops only that reading's held run.
- Stop a failed audible reading alone. Never call `handleStop` from the owner-failure branch.
- Drain held stream runs by lowest reading id, streamed before queued batch fragments (streamed PCM cannot be regenerated). Signal each batch reading at its final audible fragment. Keep completion signals per reading until its wait consumes them.
- Drive HUD captions from the audible fragment's audio clock. Incoming PCM must not resume a user-paused stream.
- `hud:*` events fire only while the HUD is enabled. Main-window UI reads `playbackStore.caption` and `reading-started`, never HUD events. Gate the `hud:caption` emit on `_hudEnabled`.
- Duck other apps per session and skip our whole process tree, not our PID: the audio session belongs to a `msedgewebview2` child. Persist originals to `duck-state.json`, since per-app mixer volumes survive a crash.
- "Beeps" in generated audio: suspect unpronounceable glyphs in the text before the playback code. Keep `remove_unpronounceable`'s symbol ranges ahead of what vendors confound.
- Measure a provider WAV's duration from its parsed header clamped to the real byte count, never by iterating the container (Fish writes `0xFFFFFF00` into the data size and rodio spins past EOF).
- Offline effect graphs:
  - Clamp the final mix with an identity WaveShaper over `[-1, 1]`; a per-layer clamp does not cap layers summed after it. Allow `createWaveShaper` only as a directly-called member.
  - Size a layer's peak after the crush gain, not before.
  - Gate only noise layers. A whole-tail on/off chop silences designed clicks.
  - Fade speech before `effect.process` in `buildPlaybackUrl`, never after.
  - Keep a start beep at 40 ms or longer; a 6 ms burst is inaudible.
  - Tune onset and glitch levers on real TTS output (`engines/*/output/test.wav`), not synthetic bursts.
  - Glitch mid-speech onsets in place. Inserting grain copies sounds like slap-back and shifts captions.

## Captions

- Captions dying on every surface at once mean the active engine stopped emitting timing metadata. Check the logs for "Disabling ... captions", verify other engines still write `.captions.json`, and run the `#[ignore]`d `live_caption_probe` before releases.
- Preserve native caption intervals with their audio through stream framing, cache/history replay, and sample-count-based fragment concatenation. Never scale word timings by text weights.
- Emit daemon caption frames as cumulative request snapshots (text and ms covering every sentence so far). Sentence-local frames validate but kill highlights after the first chunk.
- Reject unusable caption metadata without rejecting valid PCM. Propagate caption clears to live, cache, and history consumers. Keep audio and protocol errors fatal.
- Round estimated caption milliseconds once, after accumulating sentence offsets. Per-sentence rounding breaks `start_ms < audio_end` and clears the whole reading's captions.
- ElevenLabs with-timestamps streams carry alignment on the leading records only. Hard-degrade only when no aligned record ever arrives. Accept a record with audio and an empty `characters` array as audio-only (`eleven_v4_turbo` leads with them).
- Accumulate caption timings that start inside a word's span, not only contiguous ones. Per-token streams (xAI, estimation) split "don't" around the apostrophe.
- External clients (DSH plugin) read live captions from `GET /status`. The webview reports each `publishCaption` snapshot through `report_playback_caption` (throttled ~100 ms) and Rust serves it while younger than 1 s. Keep `/status` the only CORS-open route.
- A control-server speak holds the queued gate like `speak_queued`. A `speak_now` that skips `queued_gate` splices its first fragment between a queued reading's fragments.
- Wire interrupt mode (`on_retrigger`) at the audible paths (`do_abort_synthesis` in `handle_speak`, and `speak_queued`), not only the Rodio `AudioPlayer`.
- DSH captions highlight inside the assistant message, not in a strip. `/status` word offsets index the sanitized spoken fragment, not the rendered Markdown, so align the fragment words to the rendered text nodes before painting with the CSS Custom Highlight API.
- DSH caption timings follow provider granularity. ElevenLabs entries are per character: group them under the whitespace-run word they overlap before aligning.
- Never name a DSH plugin variable after a browser global (`CSS`, `Highlight`, `window`). Use `window.CSS.highlights` and `window.Highlight` explicitly.
- When resolving the spoken reply from a Chat row, skip `[data-text-interaction-source]` bodies inside `[data-variant="think"]`.
- Parse `oklch()` as well as `rgb()` when blending caption colors from theme tokens. Chromium serializes computed oklch space-preserving, so an `rgba?()`-only regex silently degrades every glide to an instant swap. Verify serialization on the app's own WebView2 version.
- Treat `activeIndex -1` caption ticks as hold, not clear. The 25 ms clock lands between word timings on every gap, and tearing down there makes every following word settle instantly. Clear only on a reading boundary via a reset key. The companion has the same failure shape (see Browser companion).

## Engines

- Point `scripts/bench/bench.py` at `%LOCALAPPDATA%\CopySpeech\engines`, the root the installers and app use.
- Catch only dizione's `ValueError` with "nothing to pronounce" as a skip. Other `ValueError`s are real failures.
- Split engine text on CJK sentence marks (。！？) too. ASCII-only splitting merges a Japanese sentence into the next English one.
- Keep Cartesia's stream request on `pcm_s16le`: the player decodes only signed 16-bit PCM. The Encoding select applies to saved (batch) audio only.
- Read Google's `output_format` in `google.rs` before trusting its select; the backend never reads it.
- Stop or idle a running `tauri dev` before `cargo check`: its cargo process holds the build-directory lock.
- Keep the engine-test lock separate from displayed results. Invalidate results after credential replacement or installer changes. Stop cloud engine tests when the environment-key warning defers saving.
- The app loads secrets from `<exe-dir>/.env` (`src-tauri/target/debug/.env` in dev), not the repo-root `.env`.
- A "called from X" comment is not the call site. Grep the named call site before trusting it.
- Local engine wrappers speak daemon protocol v2 (`READY 2`) and emit 16-bit signed LE PCM. `pcm-stream.ts` drops any other `bits_per_sample`.
- Gate every streaming branch on `supports_streaming()` AND `runtime_ready()`. The static claim alone sends a cold daemon's one-shot command down the stream branch.
- Add every new first-class local engine to `DAEMON_ENGINES` in `tts/local_daemon.rs`. `engine_kind()` matches the wrapper filename against it, and prewarm, daemon streaming, `runtime_ready`, and `supports_streaming` hang off it. Without it the engine runs one-shot forever.
- Adding a `TtsEngine` variant: update `every_engine_has_exactly_one_catalog_entry` in `tts/catalog.rs`. Pin its serde id to the frontend union and presets with `#[serde(rename)]` (plain lowercase turned `TinyVoca` into `tinyvoca`).
- Seed a bundled profile for any engine that can become the OS default. `complete_onboarding` fails with "No profile configured" without one.
- Wrapper fixes reach an installed engine only when its installer re-runs (for wrapper-only fixes, `cp` the repo file into `engines/<e>/scripts/`). Backport shared wrapper functions to EVERY engine; `diff` the wrappers when touching one.
- Bundle each installer wrapper directory in `tauri.conf.json`. A lone `install-*.ps1` breaks app-driven installs.
- Run Engines-page health checks in one-shot mode. Daemon prewarm plus the immediate fallback launches two copies of large models.
- Pass the install dialog's GPU-runtime choice as `-Cuda`. Send voice ids as one comma-joined `-Voices` argument and split with `ConvertTo-VoiceIds` (`powershell -File` binds neither `-Voices a,b` nor `-Voices a b` as an array).
- Pass `uv init` its target directory positionally (`uv init --bare --name X <dir>`); uv 0.12+ rejects `uv --project <dir> init`.
- Keep the cu126-index CUDA setup Windows-only in `Add-CudaRuntime`. The `install-*.sh` Linux ports pin plain PyPI torch/torchaudio.
- Register CUDA DLL directories with `os.add_dll_directory` AND prepend them to `PATH` in the wrapper. Python 3.8+ ignores `PATH` for extension deps, while onnxruntime's `LoadLibrary` ignores `add_dll_directory`.
- Pin torchaudio beside torch in CUDA profiles (same version, same cu126 index). Unpinned torchaudio dies at import with WinError 127.
- Drop CPU `onnxruntime` from GPU engine projects with `[tool.uv] exclude-dependencies` + `uv sync --reinstall-package onnxruntime-gpu`. `uv remove` is a no-op (transitive dep).
- KittenTTS 0.8.1 takes only `KittenTTS(model_name, cache_dir)`. Select the GPU by replacing `tts.model.session`, not with a `backend=` kwarg.
- Pass Kokoro exporter options by long name through `Invoke-Uv`; PowerShell binds `-o` as an ambiguous common parameter. Export Kokoro's duration model under isolated Python 3.12.
- Filter Kokoro's misaki phonemes through the model vocab before inference. Abort only on a missing letter phoneme.
- Change a model default in all four places: catalog `default_value` (`tts/catalog.rs`), `*Config::default()` and `default_*_profile()` (`config/tts.rs`), and `play-page.svelte`'s mock. A catalog-only edit leaves fresh installs on the old model.
- Read an HTTP response body inside the SAME `block_on_async` call that sends the request. Without an ambient tokio runtime, a `reqwest::Response` carried across calls loses its connection driver (`error decoding response body`). `fish.rs` shows the correct shape.
- Make any Tauri command that calls a provider `async`, run the blocking call in `tauri::async_runtime::spawn_blocking`, and release the config lock first. Bound voice-list requests with `tts::http::voice_list_client()`.
- Emote-tag support is per (engine, model) pair in `tts/catalog.rs::supports_emote_tags`. `eleven_v3_conversational` and Fish `drama-3` stay excluded until someone listens to a tagged read.
- Clamp provider WAV headers with `audio/wav.rs::clamp_chunk_sizes_to_file` before ANY in-app decode. xAI ships `data` = `i32::MAX`, Fish ships `0xFFFFFF00`; rodio's decoder trusts the field and concat dies with "end of stream". xAI clamps at the source; `concat_speech` clamps every fragment.
- Bump `VOICE_CACHE_SCHEMA` in `commands/tts/voices.rs` whenever `VoiceCatalogEntry` gains a field.
- Isolate one-shot preview files and process tracking from normal readings. Serialize local model loads, streams, previews, and one-shot tests; retire idle daemons before starting another process.
- Bound each installer download with `-TimeoutSec`. Make `install-uv.ps1` exit 1 when `uv.exe` is missing after the Astral script. Probe uv in the known folders, then each PATH folder (Scoop and pip installs).

## Browser companion

- Gate every browser-protocol addition on a capability. The native host's `ClientMessage` is `deny_unknown_fields` and drops the relay on any unknown field or action. Older extensions disconnect on any app event type they cannot parse.
- Bind the browser follow to each clip's own `session_id` when it activates, never to a `browser-reading` event. Gate trigger word events on `playback-fragment-audible` too.
- Match a page selection to copied text ignoring whitespace (`matchCopiedText`): the Windows clipboard has CRLF and Chrome adds blank lines between paragraphs.
- Map browser caption words onto the raw selection with `text_map::align`. Never re-derive the sanitizer's rewrites in a second place.
- Release the old browser reading before asking the document to capture its replacement. Start the session's state ticker at accept time, not after `speak_queued` returns.
- The browser pipe serves one client at a time. The native host retries `ERROR_PIPE_BUSY` with `WaitNamedPipeW`.
- Register the Chrome native host with PLAIN paths (no `\\?\` prefix) in the manifest `path` and the registry value. Tauri's `resource_dir()` returns `\\?\` paths, and Chrome then fails the handshake without reaching the pipe. `browser_registration.rs::plain_path` strips the prefix. When a connect fails while every name check passes, `reg query` the key and read the manifest.
- Treat a registration fix as NOT INSTALLED until you rebuild and reinstall. An older installed exe re-writes the broken values on every launch. Compare the installed `copyspeech.exe` mtime with the fix commit date.
- Send a state frame's `word` only while `playing` or `paused` with `word_available`. The extension disconnects (badge `!`) on any frame its parser rejects.
- Treat the double-copy announce as arriving LATE: a copy fires no extension event. Ping the worker from the page's `copy` event and let `begin_trigger` wait bounded for the port and `hello`.
- Declare `file:///*` host access and include it in content-script registration and trigger tab queries only when the browser's file-access switch permits it.
- Rebuild and include tracked `browser-extension/dist/` after companion source edits. The unpacked extension runs these bundles. The companion's icons come from `src-tauri/icons` at build time.
- A companion follow does not survive a page refresh. Reproduce mid-reading glide bugs inside a new reading.
- Set the Firefox build's `strict_min_version` to 153.0 or later (`documentId` APIs). Derive `dist-firefox/manifest.json` in `build.mjs` (`bun run build:firefox`), never by hand.
- Firefox native host manifests use `allowed_extensions` with the gecko ID. They live at `HKCU\Software\Mozilla\NativeMessagingHosts\com.copyspeech.browser` on Windows and `~/.mozilla/native-messaging-hosts/` on Linux.
- Smoke-test Firefox with `npx web-ext@latest run ... --profile-create-if-missing --arg=-headless --no-input`. web-ext has no `--headless` flag, and `--firefox-profile` needs a `user.js` with `devtools.debugger.remote-enabled=true`.
- Run the extension's Playwright specs from the repo root: they resolve `browser-extension/dist` against the CWD.
- Give the content spec's chrome stub every runtime API the bundle touches at load (`hover.ts` reads `chrome.runtime.getURL` at module top).
- Anchor a caption tween's clock at its first rendered frame and cap each step (`MARK_FRAME_CAP_MS` in `glide.ts`). A paint-time wall clock snaps the pill across late frames on busy pages.
- Hold the painted word on every wordless companion state frame. `find_word_at_position` returns None on inter-word gaps while status stays `playing`. Keep the paint until a reading boundary tears down through `release`.
- Parse `oklch(...)` in the companion's `resolveColor` as well as `rgb()` (Tailwind v4 pages). Port the app's `parseColor` unchanged.
- Run the root `bun run check` after browser-extension edits too. The root formatter gate covers `browser-extension/`.
- Append the caption pill to `document.documentElement` and never isolate the anchor root. The whole page is the backdrop that makes `mix-blend-mode: difference` invert the word.
- Fill the pill white under `mix-blend-mode: difference` and paint it above the word. An isolated but transparent host breaks the fill into a solid white block. The Play page host is safe (`bg-card`); the HUD caption must stay un-isolated.
- Follow the spoken word only when its line leaves a 15–82 % band of its scroll port, with a pause after a user scroll gesture. Call `glide.reposition()` from the scroll port's `scroll` event.
- Run `browser-extension/tests/glide.test.ts` and the content Playwright spec after changing the pill. The app's vitest suite does not cover them.

## History & cache

- Trace history export through its UI, backend command, templates, tests, and docs before removing it.
- Branch every synthesis save site on `history.enabled`: on saves to the history folder and logs; off calls `save_speech_cache` and logs nothing. `find_cached_speech` must read the same store.
- With history off, replay an early stop's paid fragments from the content-addressed cache. `find_cached_reading` replays only whole readings, so keep the per-fragment `find_cached_fragment` lookup in the pagination loop. A streamed fragment never replays (no complete WAV).
- A cached whole-reading replay is one `audio-ready` on the batch path even with streaming on. It pays per audio second before first audio (~4.2 s for 72 s at pitch 0.9; ~1.1 s at pitch 1.0). Measure it from `[Playback] webview playback started` minus the cached-replay emit line.
- Present history batches as one reading in `recent-history.svelte`. Keep fragment order for full text, playback, and whole-reading deletion. Filtering must preserve complete batches.
- Resolve history voice labels by both engine and voice ID. Keep raw IDs for playback and tooltips.
- Restore only history's saved engine, voice, and speed. Keep current profile pitch and effects. Report a missing voice profile instead of using a different voice.
- Hide the playback button's decorative spinner from accessibility naming so synthesis keeps the action named "Stop".
- Clear the shared audio queue on decode/play failure and invalidate pending decoding on Stop.
- A cache test that asserts an exact pagination count must set `fragment_size` above each sentence length; overlong sentences are force-split.

## Text pipeline

- Capture the on-disk TTS schema version before `migrate_tts_config`. It resets the version to 2 on every load, so a later schema-gated migration overwrites per-profile preferences at every restart.
- `scripts/copyspeech.mjs` is the live CLI used by Hermes. Verify its emitted `/speak` payload when renaming request flags.
- Fold Cyrillic homoglyphs only inside a word that also holds a Latin letter (`fold_homoglyphs`). A per-character fold turns "привет" into mixed script.
- Keep U+200C (ZWNJ) out of both invisible-character regexes in `tts_normalize.rs`. Persian and Indic words use it.
- Add a script's sentence terminator to both `is_sentence_end` in `pagination.rs` and the phrase regex in `captions.ts`.
- Route post-process LLM output through `sanitize_text_tag_safe`, never the plain pipeline. `remove_citations` deletes `[sighs]`.
- JIT-gate every paginated path (`synthesize_paginated`, `speak_queued_internal`): submit fragment 0 at once, then each later fragment inside the previous fragment's lead window. A fully cached queued reading skips the gate.
- Serialize queued readings with a flush + barrier (`commands/tts/queued_gate.rs`). The webview's `FragmentQueue` plays in ENQUEUE order and has no reading id, so a second reading would interleave. A waiting reading asks the holder to flush its rest, then takes the turn.
- Check the abort scope on every JIT gate poll and wake its 120 ms sleep on a scoped stop (`until_cancelled`). A stopped reading must never submit the next fragment.
- Flipping a `MarkdownSanitizationConfig` default fails every test built with `..Default::default()` that asserts the old behavior. Grep those tests and pin the field explicitly.

## Linux

- Launch with `GDK_BACKEND=x11` and `show()` the HUD window before `set_position`. Wayland toplevels cannot self-position.
- Hide the HUD's native window when the frontend emits global `hud:stop`. Webview playback never trips the Rust AudioPlayer monitor.

## Landing page

- Grep `src/` for the filename before removing or renaming anything in `static/`.
- Keep version numbers out of locale strings. They rot on every release.
- `VITE_IS_WEB` is never read from the environment. `vite.config.js` maps it from `COPYSPEECH_WEB`. Run `bun run dev:landing` / `preview:landing`.
- Format imported HTML/CSS/JS under `static/` before `bun run check`.
- Scope landing CSS under `.landing` in `landing.css`; `+layout.svelte` also renders the Play UI's root. Target `.dark .landing` for dark-only rules (mode-watcher adds `.dark`, never `.light`).
- Copy preview assets the landing uses from the untracked `docs_internal/` into `static/landing/`. The gitignored folder never deploys.
- Give the hero `.promise` heading `position: relative` when it uses `captionGlide`.
- End the landing Listen demo on `audio.ended`, not on the silent loop's clock.
- Never mark the providers marquee clone `inert`: it is on screen most of the loop and swallows clicks. Use `aria-hidden` with `tabindex="-1"` on its links.
- Translate a source mark's ink-box origin to (0, 0) before scaling it into a lockup viewBox. Preserve the OpenAI wordmark's p descender in the viewBox.
- svgo 4.x warns that `removeViewBox` is "not part of preset-default". Do not "fix" it with a standalone `'removeViewBox'` plugin: that strips the viewBox the mask sizing needs.

## Icons

- Do not fill Lucide icons with `fill="currentColor"`. Use the vendored Material filled glyphs in `src/lib/components/icons/`.
- Drive tray playback status from the webview store, never `AudioPlayer`. Keep the branded icon's color; macOS template mode strips color.
- Resize Windows tray artwork to the system small-icon size with alpha-aware filtering before passing it to Tauri.
- Keep `icons/icon.ico` in the Cargo build script's `rerun-if-changed` inputs. Verify the embedded 32px frame after rebuilding.
- Strip trailing whitespace when installing a designer-exported SVG verbatim; `git diff --check` fails on it.
- Regenerate every icon derivative with the base set: `tray/speaking.png`, `tray/paused.png` (`scripts/render-tray-icons.py`), `app-icon-inverted.png`, `browser-extension/dist/icons/`, and `static/landing/app-logo.svg` (a separate file).

## Release

- `bun run bump` derives the version from `src/lib/version.ts`. Verify the five ✅ lines. Expect the README ⚠️ and hand-bump its asset-name version strings. It never touches `browser-extension/`; bump that `manifest.json` and `package.json` by hand.
- Pass `draft: true` to `softprops/action-gh-release` when attaching extra assets to tauri-action's draft release.
- Keep `src-tauri/Cargo.lock` tracked and update it deliberately. A fresh resolve can hit yanked crates mid-release.
- In a fresh clone or worktree, run `bun run build` once before any `cargo` command in `src-tauri/`. tauri-build needs `dist/`.
- Every `latest.json` platform entry must keep both `url` and `signature`. Patch every entry that points at the AppImage, including `linux-x86_64-appimage`.
- Read `CHANGELOG.md` with `-Encoding utf8` in every PowerShell release step.
- Build `browser-native-host` in release mode before any Windows `tauri dev` or `tauri build`; `tauri.windows.conf.json` bundles its `.exe`.
- Keep the extension's `key` field and `com.copyspeech.browser` host name in sync with `browser_registration.rs`. A mismatch shows `!` with no visible error.

## i18n

- Bind the language selector to the saved preference, not the resolved locale. An empty value means System.
- Read the saved locale through the scalar `get_saved_locale` IPC before the first render; onboarding can hang on the full `get_config` payload.
- Keep tray labels in sync with the webview's effective locale, not just the saved value.
- Grep components for `>Text<` and `label="Text"` after an i18n pass. Literal UI text bypasses `$_` and passes locale parity.
- Pass caught errors to `$_` values as `String(e)`.
- Run `vp fmt src/lib/i18n/types.ts` after `node scripts/generate-i18n-types.js`.
- Write locale JSON with LF bytes (`newline="\n"` in Python).
- List only directories that hold locale JSON in `.vscode/settings.json` `i18n-ally.localesPaths`.

## Frontend checks

- Import test APIs from `vite-plus/test`, not `vitest`.
- Hold a mocked async API on a promise the test opens when proving a race. `vi.waitFor` polls and hides the race.
- Type test catalog maps with `satisfies Record<string, Catalog>`, not a `: Record<…>` annotation.
- Let one dynamic `import()` of a `vi.mock`ed module settle before code under test starts another.
- Unlisten a Tauri `listen` that resolves after its component's `onDestroy`. HMR can orphan the listener and double-fire.
- svelte-check 4.7.7 rejects `$props<T>()` type arguments. Use `interface Props` and `let x: Props = $props()`.
- `vp check`'s anti-slop `no-runtime-typeof` rejects a `typeof` branch on a value union. Coerce at the call (`String(value ?? "")`) or parse at the I/O boundary.
- Stub `Element.prototype.scrollIntoView`, `HTMLMediaElement.prototype.play` and `pause` in component tests.
- After `git checkout` of a watched source file, `touch` it. The Vite watcher can miss the write and keep serving the old transform.
- After moving a test into `__tests__/`, rewrite its `./` and `../` specifiers, `vi.mock` targets, dynamic `import()` paths, and `import.meta.dirname` paths.
- Bump `vite`, `vitest`, and the `overrides` pins together with `vite-plus`. Mismatched pins fail `svelte-check` on `vitest.config.ts` with "Excessive stack depth".
- The extension tests resolve `jsdom` from the root `node_modules`. jsdom 31 serializes `translate(-40px,0px)` as `translate(-40px)`.

## Settings

- Keep the Lenis content element stable across route changes; MotionWrapper replaces its inner node on navigation.
- Sync Lenis's cached limit through `syncLenisToLayout` after collapses, not only on resize. Call `lenis.dimensions.resize()` (not `lenis.resize()`, which cancels the in-flight scroll) before a programmatic `scrollTo`.
- Update `play-page.svelte`'s browser mock config when adding required `AppConfig` fields, matching backend defaults.
- Pass the current locale direction to Bits UI tooltip content. Its wrapper defaults to `dir="ltr"`.
- Gate hidden startup and close-to-tray on an actually available tray. Create the main window hidden and show first-run setup explicitly. Use one unminimize/show/focus helper for tray and second-instance reopening. Propagate OS autostart failures before persisting the preference.
- Force the last visible settings section active at the bottom of the scroll container. The layout `<main>` scrolls, not the window.
- The ui `collapsible` index exports `Collapsible` as the Root only. Import `CollapsibleRoot`/`CollapsibleTrigger`/`CollapsibleContent` by name.
- Draw the shadow below an empty settings divider with a positioned pseudo-element. Give light cards a tinted surface and a bright divider above the darker shadow.

## Experimental gating

- Experimental off FORCES features off at synthesis time (post-process, effects). Saved settings stay for re-enabling.
- Read the active effect through `effectiveEffect` (`src/lib/effects-gate.ts`), never `profile.effects`.
- Gate every history IPC that deletes stored audio (`run_history_cleanup` included).

## DSH plugin (copyspeech-dsh)

- Register one interaction id per gesture, not one per button. `uiConversation.interactions.dispatch()` returns the first id that calls `request.open()`. Shadow the host cell for its `quote` key and render both actions there.
- Shadow a keyed slot cell by registering the same key at a DIFFERENT priority; the lowest live priority renders. A same-key, same-priority registration throws. Keep the host interaction registered for admission.
- Capture a selection Range when the action opens. A click collapses the native selection unless the pill's `pointerdown` calls `preventDefault()`. Clear the native selection when a selection reading starts; the cloned range still paints the highlight.
- Commit DSH `client.js` with an explicit pathspec (`git commit -- client.js`).
- Drive the pill glide from ONE rAF loop. A CSS transition beside it drifts.
- Gate auto-read on the Session snapshot, never on the first reply id alone. Wait for `openState === 'open'` and speak a reply only after seeing `running` true. Run `bun scripts/test-dsh-plugin-auto-read.mjs` after touching the watcher.
- A partial auto-read excerpt drops the reply's middle. Align across the gap only on a proven run of the next spoken words (`resyncForward`).
- Grep every call of a helper a caption port deletes. A bare `wordRects` or `releaseMarkHost` throws inside the status-poll promise and the pill silently never paints. Run `bun scripts/test-dsh-plugin-captions.mjs` after touching the pill.
- Repaint the fixed pill on every scroll, and once more at glide end. Re-read the active word's rect on the scroller and the window.

## Hermes plugin (copyspeech-hermes)

- Gate auto-read on a `message.start` seen for the same `session_id`. Drop events with `replayed === true`. Require `payload.status === 'complete'` and the focused `session_id`: child sessions finish on their own id.
- Dedupe across windows with a claim keyed `claim.<session_id>.<seq>` in `ctx.storage`. The SDK gives no window id.
- Skip the plugin read when `localStorage['hermes.desktop.autoSpeakReplies'] === 'true'`. Hermes's built-in reader speaks the same reply.
- Match `GET /status` captions to the reply text, not to a request id. Require half of the caption words to map to the reply. Resync across the excerpt gap only on a run of 3 words. Keep an alignment miss unkeyed so the next poll retries.
- Hook replies with `[data-slot="aui_assistant-message-root"][data-role="assistant"]` and read text from `.aui-md`, skipping reasoning slots. Look up the reply in the focused pane (`[data-session-anchor]` = `session-tile:<focusedStoredSessionId>` else `workspace`), never the last assistant root in the document.
- Install the plugin through a junction (`New-Item -ItemType Junction`) so the watcher hot-reloads repo edits.
- Before tuning plugin alignment, check the app log for the missed fragment's `Clamped` line. A missing line means the engine never delivered captions for it.
- Run `bunx vp fmt` before writing a regex that strips the SDK import. The formatter splits long imports across lines.
- Write guards without `typeof` (`Array.isArray`, `String(x) === x`, `??`). Keep helpers in `plugin.js`: the loader rejects relative imports.
- Re-check focus and settings when a `/status` response lands, not only before the request.
- Use `scrollTo` behavior `instant` for Reduce Motion, not `auto`.
- Inject manual playback UI into the chat DOM (host hover row `.aui-message-actions-desktop` inside `[data-slot="aui_msg-actions"]`). Verify the selector against the RUNNING build's renderer chunks.
- Start every plugin reading through the control server's request-scoped routes (`/speak` with `request_id`, `/pause`, `/resume`, `/seek`, `/stop`) and mirror the request in one playback record.
- Gate the injected UI on `window.MutationObserver !== undefined && window.document !== undefined`. Initialize injected buttons before attachment; prune sync entries after detachment.
- Accept element-node selection boundaries inside the reply body; a Range does not always start in a text node.
- Serialize manual starts, not the `wait: true` response. Otherwise a new click cannot stop a blocked earlier reading.

## Claude Code plugin (copyspeech-claude)

- Run `plugin validate` and `plugin test` with the session's engine (`%LOCALAPPDATA%\Claude-Data\<id>\claude-code\<version>\<hash>\claude.exe`). The PATH `claude` lacks `ContextMenu`.
- In a fresh worktree, copy `copyspeech-claude/.claude-plugin/types/` from a checkout where Claude Code loaded the plugin before `bun run check`. The engine writes it and git ignores it.
- Validator rules: declare each helper that takes `$` as a top-level `function` and never shadow its name; keep `import()` out of the module and its tests; give a Box with `hover: { display: 'flex' }` its own `display: 'none'`.
- Run Button work through `$.clock.after(0, ...)`, never `await` it in `onPress` (10 s press budget). Keep `$.ui.scroll` direct; it works only inside the press.
- Keep Buttons and Svg out of the row that reads the spoken word: each per-word write redraws it. Put Pause, Resume, and Stop in the `AbovePrompt` band, which reads only `reading`. Keep the spoken word in a `StateFamily` member per row (`memberOf`).
- Show captions in the plugin's own `captions` Pane, never inside the reply (`Markdown` has no per-word spans). Only the Pane reads `spoken`. Scroll it with `$.ui.scroll({ in: "captions", to: { key } })`; `plugin test` cannot run it.
- Draw the block that holds the spoken word, and every list block, from `hooks/markdown.ts`. Read a list item with `prepareLine`, never `prepareSpeech` over the block. Every `Line` and table cell holds offsets into the reply; a spoken token must fall inside one or its word gets no chip. Keep never-drawn text (list marker, link target) out of `speakable` tokens. Find fences only with `fenceAfter` and `fenceSpans`. `tests/markdown.test.ts` checks these.
- Treat a `/speak` fetch give-up (`aborted`, `no complete answer`, fixed 30 s) as a running reading. The `/status` poll ends it.
- Collect auto-read rows from `AssistantMessage` renders between `turn.start` and `turn.complete` (`inTurn` only). `answer` holds only the last text block. Auto-read speaks only the last collected row. In a plugin test, start the turn with `$.prompt.submit` and register `on("prompt.submit")` before the first `$` call.
- Treat a `/status` answer as the current reading's only after its `/speak` answered (`run.heard`) and while `run` is the object the poll started with. `/status` has no request id.
- Do not end a reading on an inactive status that still carries a position: synthesis may run behind playback. Only a bare `{ active: false }` ends it, at once once the reading was heard. Add no idle wait. Clear only the reading the poll read (`endIfCurrent`).
- Apply a pane or command setting write through `settingOverrides` (`settingsNow`) wherever the plugin reads a setting. Store it as `{ from, to }` so a reload with another value retires it.
- Do not require a `$.config.list()` row before `$.config.set`: desktop lists none of the plugin's rows. Write `copyspeech@inline.<field>`, then `copyspeech.<field>`. `$.settings` only reads. Desktop also omits the number rows (`excerptTop`, `excerptBottom`); the pane's steppers write them anyway and toast any refusal (point the person to `/config`).
- Open the captions pane on `prompt.submit` when auto-read is on, not only at `turn.complete`: the engine may hold an unasked open undrawn below 144 columns. Start the auto-read reading before the pane opens, never after `await $.ui.open`.
- Open the pane only after a `/health` probe answers (`openPane`). A 5 s timer closes it when `/health` fails. A plugin test must stub `http.fetch` for `/health`.
- In a plugin test, drive auto-read with `$.turn.complete({ ..., reason: "answer" })` over a stub `on("turn.complete", () => ({ text: "" }))`. A `{ value }` wrapper is refused, and the test skips `$.turn.start`.
- Give a Button only string and `Text` children. A `Svg` or `Box` child is refused, and an icon-only label took every click on desktop, so the desktop Read button is the plain word Read. Keep Buttons out of a `Client` on desktop; put them in the Pane body.
- Keep an absolute Box inside its row on desktop; the desktop clips at the row. Hide a per-paragraph Read button with `display: "none"` and `hover: { display: "flex" }`, with no reserved column.
- Draw `Svg` only on desktop, vscode, and mobile surfaces. Guard with `e.surface`; `"Svg" in ui` is true on the terminal too.
- Load the plugin for development from the repo folder: `~/.claude/settings.json` `env` names `CLAUDE_CODE_PLUGIN_DIRS` and `CLAUDE_CODE_PLUGIN_DIR_WATCH=1`. Do not also copy it into `dev-mods`: that loads two `copyspeech` plugins.
- Say a dot in inline code as the word "dot" in `speakable()`. Engines read "." as a pause. Keep the marker one char so markdown offsets hold.
- Use reverse video for the pane chip (`backgroundColor: "text"`, `color: "inverseText"`). The mod SDK has no `mixBlendMode` or element `opacity`.
- Keep the captions pane's shown replies in `$.state` (`history`), set in `start()`. A reload empties module variables, and a render hook cannot write state. Do not rename a `$.state` key in a hot-reloaded plugin.
- `$.theme.set({ style })` covers messages and tool rows only. It cannot set the captions pane's font.
