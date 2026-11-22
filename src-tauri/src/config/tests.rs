#[cfg(test)]
mod tests {
    use crate::config::*;
    use crate::config::{load_or_default_from, save_to};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    #[test]
    fn filename_pattern_expands_placeholders_and_sanitizes() {
        let ts = expand_filename_pattern("output_{timestamp}.wav", "af_heart", "hello");
        let ts_part = ts
            .strip_prefix("output_")
            .and_then(|s| s.strip_suffix(".wav"))
            .unwrap();
        assert!(ts_part.parse::<i64>().is_ok());

        assert_eq!(
            expand_filename_pattern("tts_{voice}.wav", "af_heart", "hello"),
            "tts_af_heart.wav"
        );
        assert_eq!(
            expand_filename_pattern("{voice}.wav", "voice/with:bad<chars>", "text"),
            "voicewithbadchars.wav"
        );
        assert_eq!(
            expand_filename_pattern("{text}.wav", "voice", "Hello! @World#"),
            "hello_world.wav"
        );
        let long = "This is a very long text that should be truncated at thirty characters";
        let truncated = expand_filename_pattern("{text}.wav", "voice", long);
        assert!(truncated.strip_suffix(".wav").unwrap().len() <= 30);

        let dt = expand_filename_pattern("copyspeech_{datetime}.wav", "voice", "text");
        let dt_part = dt
            .strip_prefix("copyspeech_")
            .and_then(|s| s.strip_suffix(".wav"))
            .unwrap();
        assert_eq!(dt_part.len(), 17);
        assert_eq!(dt_part.chars().nth(4), Some('-'));
        assert_eq!(dt_part.chars().nth(7), Some('-'));
        assert_eq!(dt_part.chars().nth(10), Some('_'));

        let date_time = expand_filename_pattern("{date}_{time}.wav", "voice", "text");
        let parts: Vec<&str> = date_time.strip_suffix(".wav").unwrap().split('_').collect();
        assert_eq!((parts.len(), parts[0].len(), parts[1].len()), (2, 10, 6));

        let multi = expand_filename_pattern("{voice}_{text}_{date}.wav", "af_heart", "Hello");
        assert!(multi.starts_with("af_heart_hello_") && multi.ends_with(".wav"));
        assert_eq!(
            expand_filename_pattern("static_filename.wav", "voice", "text"),
            "static_filename.wav"
        );
    }

    #[test]
    fn validation_checks_command_placeholders_and_double_copy_window() {
        assert!(AppConfig::default().validate().is_ok());

        let set_active_local = |config: &mut AppConfig| {
            config.tts.active_backend = TtsEngine::Local;
            if let Some(profile) = config
                .tts
                .profiles
                .iter_mut()
                .find(|p| p.id == config.tts.active_profile_id)
            {
                profile.engine = TtsEngine::Local;
            }
        };

        let mut empty_cmd = AppConfig::default();
        set_active_local(&mut empty_cmd);
        empty_cmd.tts.command = String::new();
        assert!(empty_cmd
            .validate()
            .unwrap_err()
            .iter()
            .any(|e| matches!(e, ValidationError::CommandEmpty)));

        let mut bad_args = AppConfig::default();
        set_active_local(&mut bad_args);
        bad_args.tts.args_template = vec!["-v".into(), "{voice}".into()];
        assert!(bad_args
            .validate()
            .unwrap_err()
            .iter()
            .any(|e| matches!(e, ValidationError::ArgsTemplateMissingPlaceholder { .. })));

        let mut small_window = AppConfig::default();
        small_window.trigger.double_copy_window_ms = 50;
        assert!(small_window
            .validate()
            .unwrap_err()
            .iter()
            .any(|e| matches!(e, ValidationError::DoubleCopyWindowTooSmall { .. })));
    }

    #[test]
    fn test_default_tts_config_uses_the_os_default_profile() {
        let tts = TtsConfig::default();
        // kale is the Windows default; macOS and Linux stay on tiny-voca
        // until install-kale.sh passes a clean-install check there.
        let is_windows = cfg!(target_os = "windows");
        let (engine, profile_id) = if is_windows {
            (TtsEngine::Kale, "profile-kale-default")
        } else {
            (TtsEngine::TinyVoca, "profile-tiny-voca-default")
        };
        assert_eq!(TtsEngine::default(), engine);
        assert_eq!(tts.schema_version, 8);
        assert_eq!(tts.active_backend, engine);
        assert!(tts
            .profiles
            .iter()
            .any(|profile| profile.engine == TtsEngine::Edge));
        assert_eq!(tts.active_profile_id, profile_id);
        assert_eq!(
            tts.profiles
                .iter()
                .find(|profile| profile.id == tts.active_profile_id)
                .map(|profile| &profile.engine),
            Some(&engine)
        );
        if is_windows {
            assert!(tts
                .profiles
                .iter()
                .any(|profile| profile.id == "profile-kale-default"));
            assert!(!tts
                .profiles
                .iter()
                .any(|profile| profile.id == "profile-tiny-voca-default"));
        }
    }

    #[test]
    fn engine_ids_match_frontend_union() {
        for (engine, expected) in [
            (TtsEngine::TinyVoca, "\"tiny-voca\""),
            (TtsEngine::Kale, "\"kale\""),
        ] {
            assert_eq!(serde_json::to_string(&engine).unwrap(), expected);
            assert_eq!(serde_json::from_str::<TtsEngine>(expected).unwrap(), engine);
        }
    }

    #[test]
    fn legacy_v0_migration_creates_default_profile_and_is_idempotent() {
        let mut tts = TtsConfig::default();
        tts.schema_version = 0;
        tts.profiles = Vec::new();
        tts.active_backend = TtsEngine::ElevenLabs;
        tts.elevenlabs.voice_id = "voice-xyz".into();

        let migrated = migrate_tts_config(tts);
        assert_eq!(migrated.schema_version, 2);
        assert_eq!(migrated.active_profile_id, "default");
        assert_eq!(migrated.profiles.len(), 1);
        assert_eq!(migrated.profiles[0].engine, TtsEngine::ElevenLabs);
        assert_eq!(migrated.profiles[0].voice, "voice-xyz");

        let once = migrate_tts_config(TtsConfig::default());
        let twice = migrate_tts_config(once.clone());
        assert_eq!(once.profiles.len(), twice.profiles.len());
        assert_eq!(twice.schema_version, 2);
    }

    #[test]
    fn v6_adds_kokoro_and_readopts_edge_profiles() {
        use crate::config::tts::{
            migrate_add_kokoro_profile_v6, KITTEN_DEFAULT_PROFILE_ID, KOKORO_DEFAULT_PROFILE_ID,
        };

        let mut tts = TtsConfig::default();
        tts.schema_version = 5;
        tts.profiles.retain(|p| p.id != KOKORO_DEFAULT_PROFILE_ID);
        tts.active_backend = TtsEngine::Kitten;
        tts.active_profile_id = KITTEN_DEFAULT_PROFILE_ID.into();
        let before = tts.profiles.len();

        migrate_add_kokoro_profile_v6(&mut tts);
        assert_eq!(tts.schema_version, 6);
        assert_eq!(tts.profiles.len(), before + 1);
        assert!(tts
            .profiles
            .iter()
            .any(|p| p.id == KOKORO_DEFAULT_PROFILE_ID && p.engine == TtsEngine::Kokoro));
        assert_eq!(tts.active_backend, TtsEngine::Kitten);
        assert_eq!(tts.active_profile_id, KITTEN_DEFAULT_PROFILE_ID);
        migrate_add_kokoro_profile_v6(&mut tts);
        assert_eq!(tts.profiles.len(), before + 1);

        let mut edge_tts = TtsConfig::default();
        edge_tts.schema_version = 5;
        edge_tts
            .profiles
            .retain(|p| p.id != KOKORO_DEFAULT_PROFILE_ID);
        let mut edge_profile = default_kokoro_profile();
        edge_profile.id = "default".into();
        edge_profile.engine = TtsEngine::Edge;
        edge_profile.voice = "en-US-AvaMultilingualNeural".into();
        edge_profile.voice_label = None;
        edge_tts.profiles.push(edge_profile);
        edge_tts.active_backend = TtsEngine::Edge;
        edge_tts.active_profile_id = "default".into();

        migrate_add_kokoro_profile_v6(&mut edge_tts);
        let active = edge_tts
            .profiles
            .iter()
            .find(|p| p.id == edge_tts.active_profile_id)
            .unwrap();
        assert_eq!(active.engine, TtsEngine::Edge);
        assert_eq!(active.voice, "en-US-AvaMultilingualNeural");
        assert!(edge_tts
            .profiles
            .iter()
            .any(|p| p.id == KOKORO_DEFAULT_PROFILE_ID));
    }

    #[test]
    fn v7_promotes_local_piper_and_leaves_hand_written_commands_alone() {
        let mut tts = TtsConfig::default();
        let mut piper = default_kokoro_profile();
        piper.id = "piper-local".into();
        piper.engine = TtsEngine::Local;
        piper.voice = "en_US-joe-medium".into();
        piper.voice_label = None;
        piper.engine_options = ProfileEngineOptions::Local(LocalEngineOptions {
            command: Some("uv".into()),
            args_template: Some(
                [
                    "run",
                    "--project",
                    "{engine_dir}/piper",
                    "python",
                    "{engine_dir}/piper/scripts/copyspeech-piper.py",
                    "--text-file",
                    "{input}",
                    "--voice",
                    "{voice}",
                    "--output",
                    "{output}",
                ]
                .iter()
                .map(|s| s.to_string())
                .collect(),
            ),
        });
        let mut custom = default_kokoro_profile();
        custom.id = "my-cli".into();
        custom.engine = TtsEngine::Local;
        custom.engine_options = ProfileEngineOptions::Local(LocalEngineOptions {
            command: Some("python".into()),
            args_template: Some(vec!["-m".into(), "my_tts".into(), "{input}".into()]),
        });
        let custom_before = custom.clone();
        tts.profiles.extend([piper, custom]);
        tts.active_backend = TtsEngine::Local;
        tts.active_profile_id = "piper-local".into();

        crate::config::tts::migrate_tts_profiles_v7(&mut tts);
        assert_eq!(tts.schema_version, 7);
        let promoted = tts.profiles.iter().find(|p| p.id == "piper-local").unwrap();
        assert_eq!(promoted.engine, TtsEngine::Piper);
        assert!(matches!(
            promoted.engine_options,
            ProfileEngineOptions::Piper(_)
        ));
        assert_eq!(promoted.voice_label.as_deref(), Some("Joe"));
        assert_eq!(tts.active_backend, TtsEngine::Piper);

        let kept = tts.profiles.iter().find(|p| p.id == "my-cli").unwrap();
        assert_eq!(kept.engine, TtsEngine::Local);
        assert_eq!(kept.engine_options, custom_before.engine_options);
    }

    #[test]
    fn v7_remaps_legacy_and_unset_gemini_models_but_not_custom_ones() {
        let mut tts = TtsConfig::default();
        let mut legacy = default_google_profile();
        legacy.id = "g-legacy".into();
        legacy.engine_options = ProfileEngineOptions::Google(GoogleEngineOptions {
            model: Some(crate::config::tts::LEGACY_GEMINI_TTS_MODEL.into()),
            output_format: Some("wav".into()),
        });
        let mut unset = default_google_profile();
        unset.id = "g-unset".into();
        unset.engine_options = ProfileEngineOptions::Google(GoogleEngineOptions {
            model: None,
            output_format: Some("wav".into()),
        });
        let mut custom = default_google_profile();
        custom.id = "g-custom".into();
        custom.engine_options = ProfileEngineOptions::Google(GoogleEngineOptions {
            model: Some("gemini-3.8-flash-lite-tts".into()),
            output_format: Some("wav".into()),
        });
        tts.profiles.extend([legacy, unset, custom]);
        tts.google.model = crate::config::tts::LEGACY_GEMINI_TTS_MODEL.into();

        crate::config::tts::migrate_tts_profiles_v7(&mut tts);

        let model = |tts: &TtsConfig, id: &str| {
            tts.profiles
                .iter()
                .find(|p| p.id == id)
                .unwrap()
                .engine_options
                .google()
                .unwrap()
                .model
                .clone()
                .unwrap()
        };
        assert_eq!(
            model(&tts, "g-legacy"),
            crate::config::tts::GEMINI_TTS_MODEL
        );
        assert_eq!(model(&tts, "g-unset"), crate::config::tts::GEMINI_TTS_MODEL);
        assert_eq!(model(&tts, "g-custom"), "gemini-3.8-flash-lite-tts");
        assert_eq!(tts.google.model, crate::config::tts::GEMINI_TTS_MODEL);

        crate::config::tts::migrate_tts_profiles_v7(&mut tts);
        assert_eq!(model(&tts, "g-custom"), "gemini-3.8-flash-lite-tts");
        assert_eq!(tts.schema_version, 7);
    }

    #[test]
    fn fresh_defaults_and_missing_fields_use_safe_defaults() {
        let config = AppConfig::default();
        assert!(config.playback.duck.enabled);
        assert_eq!(config.playback.duck.level_percent, 10);
        assert!(config.playback.streaming_enabled);
        assert!(!config.history.enabled);
        assert!(!config.post_process.enabled);
        assert!(!config.general.experimental_enabled);
        assert!(!config.general.effects_enabled);
        assert!(config.general.show_tray_icon);
        for profile in &config.tts.profiles {
            assert!(!profile.effects.enabled);
            assert_eq!(profile.effects.active_effect, EffectId::None);
        }

        let legacy_general: GeneralConfig =
            serde_json::from_str(r#"{"launch_on_login": false, "start_minimized": true}"#).unwrap();
        assert!(legacy_general.show_tray_icon);
        assert!(!legacy_general.experimental_enabled);
        assert!(!legacy_general.effects_enabled);
        assert!(legacy_general.animations_enabled);

        let playback: PlaybackConfig =
            serde_json::from_str(r#"{"on_retrigger": "interrupt"}"#).unwrap();
        assert!(playback.duck.enabled);
        assert_eq!(playback.duck.level_percent, 10);
        assert!(playback.streaming_enabled);
        assert!(playback.caption_animation);

        let pe: ProfileEffects = serde_json::from_str(r#"{}"#).unwrap();
        assert!(!pe.enabled);
        assert_eq!(pe.active_effect, EffectId::None);

        let output: OutputConfig = serde_json::from_str(
            r#"{"enabled": true, "directory": "/tmp", "filename_pattern": "test.wav"}"#,
        )
        .unwrap();
        assert!(output.enabled);
        assert_eq!(output.format_config.format, AudioFormat::Wav);
        assert_eq!(output.format_config.mp3_bitrate, 192);
    }

    #[test]
    fn explicit_saved_values_and_unset_locale_survive_roundtrip() {
        let mut config = serde_json::to_value(AppConfig::default()).unwrap();
        assert_eq!(config["general"]["locale"], "");
        assert_eq!(config["playback"]["streaming_enabled"], true);
        config["general"].as_object_mut().unwrap().remove("locale");
        config["playback"]
            .as_object_mut()
            .unwrap()
            .remove("streaming_enabled");
        let mut restored: AppConfig = serde_json::from_value(config).unwrap();
        assert_eq!(restored.general.locale, "");
        assert!(restored.playback.streaming_enabled);

        restored.general.locale = "en".to_string();
        restored.playback.streaming_enabled = false;
        let roundtripped: AppConfig =
            serde_json::from_str(&serde_json::to_string(&restored).unwrap()).unwrap();
        assert_eq!(roundtripped.general.locale, "en");
        assert!(!roundtripped.playback.streaming_enabled);

        assert_eq!(
            OutputConfig::default().filename_pattern,
            "copyspeech-{compact_datetime}-{seq}.wav"
        );
        let mut saved_out = serde_json::to_value(OutputConfig::default()).unwrap();
        saved_out["filename_pattern"] = serde_json::json!("copyspeech-custom-{seq}.wav");
        let restored_out: OutputConfig = serde_json::from_value(saved_out).unwrap();
        assert_eq!(restored_out.filename_pattern, "copyspeech-custom-{seq}.wav");

        let playback: PlaybackConfig = serde_json::from_str(
            r#"{"on_retrigger": "interrupt", "duck": {"enabled": true, "level_percent": 35}, "streaming_enabled": false}"#,
        )
        .unwrap();
        assert!(playback.duck.enabled);
        assert_eq!(playback.duck.level_percent, 35);
        assert!(!playback.streaming_enabled);

        let pe: ProfileEffects =
            serde_json::from_str(r#"{"enabled": true, "active_effect": "walkie_talkie"}"#).unwrap();
        assert!(pe.enabled);
        assert_eq!(pe.active_effect, EffectId::WalkieTalkie);
    }

    #[test]
    fn effective_feature_gates_follow_truth_tables() {
        let mut config = AppConfig::default();
        for experimental in [false, true] {
            for flag in [false, true] {
                config.general.experimental_enabled = experimental;

                config.hotkey.enabled = flag;
                let effective = config.effective_hotkey();
                assert_eq!(effective.enabled, experimental && flag);
                assert_eq!(effective.shortcut, config.hotkey.shortcut);
                assert_eq!(config.hotkey.enabled, flag);

                config.history.enabled = flag;
                assert_eq!(config.is_history_effective(), experimental && flag);

                config.hud.enabled = flag;
                assert_eq!(config.is_hud_effective(), experimental && flag);

                config.playback.duck.enabled = flag;
                assert_eq!(config.is_duck_effective(), flag);
            }
        }
    }

    // ── On-disk load / reload migration regression tests ─────────────────────

    /// Unique per-test config path: parallel test threads each get their own
    /// temp directory, keyed by pid + monotonic counter + label.
    fn temp_config_path(label: &str) -> PathBuf {
        static NEXT_ID: AtomicU32 = AtomicU32::new(0);
        let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "copyspeech-config-test-{}-{}-{label}",
            std::process::id(),
            id
        ));
        std::fs::create_dir_all(&dir).expect("create temp config dir");
        dir.join("config.json")
    }

    fn discard_temp_config(path: &PathBuf) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[test]
    fn legacy_on_disk_config_migrates_to_v8_and_seeds_post_process() {
        let path = temp_config_path("legacy-v0");
        std::fs::write(
            &path,
            r#"{
                "version": "0.1.5",
                "general": {"launch_on_login": false, "start_minimized": true},
                "trigger": {
                    "listen_enabled": true,
                    "double_copy_window_ms": 1500,
                    "max_text_length": 100000
                },
                "tts": {
                    "active_backend": "local",
                    "command": "uv",
                    "args_template": [
                        "run",
                        "--project",
                        "{engine_dir}/kitten",
                        "python",
                        "{engine_dir}/kitten/scripts/copyspeech-kitten.py",
                        "--text-file",
                        "{input}",
                        "--voice",
                        "{voice}",
                        "--output",
                        "{output}"
                    ],
                    "voice": "Rosie"
                },
                "playback": {"on_retrigger": "queue", "playback_speed": 1.35, "pitch": 1.15},
                "hud": {
                    "enabled": false,
                    "position": "bottom-left",
                    "width": 300,
                    "height": 100,
                    "opacity": 0.85
                },
                "post_process": {
                    "enabled": true,
                    "prompt": "Polish this for listening, keep every name: ${output}"
                }
            }"#,
        )
        .expect("write legacy config fixture");

        let cfg = load_or_default_from(&path);
        assert_eq!(cfg.tts.schema_version, 8);
        assert_eq!(cfg.version, CONFIG_VERSION);

        let default_profile = cfg
            .tts
            .profiles
            .iter()
            .find(|p| p.id == "default")
            .expect("legacy config rebuilds a 'default' profile");
        assert_eq!(default_profile.engine, TtsEngine::Local);
        assert_eq!(default_profile.voice, "Rosie");
        assert_eq!(default_profile.speed, 1.35);
        assert_eq!(default_profile.pitch, 1.15);
        assert_eq!(cfg.tts.active_profile_id, "default");

        for bundled in [
            crate::config::tts::KITTEN_DEFAULT_PROFILE_ID,
            crate::config::tts::QWEN_DEFAULT_PROFILE_ID,
            crate::config::tts::KOKORO_DEFAULT_PROFILE_ID,
        ] {
            assert!(
                cfg.tts.profiles.iter().any(|p| p.id == bundled),
                "bundled profile {bundled} missing after migration"
            );
        }

        for profile in &cfg.tts.profiles {
            assert!(profile.post_process.enabled);
            assert_eq!(
                profile.post_process.active_template_id.as_deref(),
                Some("custom-legacy")
            );
        }
        assert!(cfg.post_process.enabled);

        discard_temp_config(&path);
    }

    #[test]
    fn v8_seed_does_not_overwrite_edited_per_profile_post_process_on_reload() {
        let path = temp_config_path("v7-seed-then-reload");

        let mut on_disk = AppConfig::default();
        on_disk.tts.schema_version = 7;
        on_disk.post_process.enabled = true;
        save_to(&path, &on_disk).expect("write v7 config");

        let migrated = load_or_default_from(&path);
        assert_eq!(migrated.tts.schema_version, 8);
        assert!(migrated.post_process.enabled);
        let seeded_template = if migrated.post_process.active_template_id.is_empty() {
            None
        } else {
            Some(migrated.post_process.active_template_id.clone())
        };
        for profile in &migrated.tts.profiles {
            assert!(profile.post_process.enabled);
            assert_eq!(profile.post_process.active_template_id, seeded_template);
        }

        let mut edited = migrated;
        let kokoro = edited
            .tts
            .profiles
            .iter_mut()
            .find(|p| p.id == crate::config::tts::KOKORO_DEFAULT_PROFILE_ID)
            .expect("bundled Kokoro profile");
        kokoro.post_process = ProfilePostProcess {
            enabled: true,
            active_template_id: Some("my-custom-template".into()),
        };
        let kitten = edited
            .tts
            .profiles
            .iter_mut()
            .find(|p| p.id == crate::config::tts::KITTEN_DEFAULT_PROFILE_ID)
            .expect("bundled Kitten profile");
        kitten.post_process = ProfilePostProcess {
            enabled: false,
            active_template_id: None,
        };
        save_to(&path, &edited).expect("save edited v8 config");

        let reloaded = load_or_default_from(&path);
        assert_eq!(reloaded.tts.schema_version, 8);
        assert_eq!(reloaded.tts.profiles.len(), edited.tts.profiles.len());
        let kokoro = reloaded
            .tts
            .profiles
            .iter()
            .find(|p| p.id == crate::config::tts::KOKORO_DEFAULT_PROFILE_ID)
            .unwrap();
        assert!(kokoro.post_process.enabled);
        assert_eq!(
            kokoro.post_process.active_template_id.as_deref(),
            Some("my-custom-template")
        );
        let kitten = reloaded
            .tts
            .profiles
            .iter()
            .find(|p| p.id == crate::config::tts::KITTEN_DEFAULT_PROFILE_ID)
            .unwrap();
        assert!(!kitten.post_process.enabled);
        assert_eq!(kitten.post_process.active_template_id, None);
        assert!(reloaded.post_process.enabled);

        discard_temp_config(&path);
    }

    #[test]
    fn v8_on_disk_config_keeps_per_profile_post_process() {
        let path = temp_config_path("v8-on-disk");

        let mut on_disk = AppConfig::default();
        on_disk.post_process.enabled = false;
        let kokoro = on_disk
            .tts
            .profiles
            .iter_mut()
            .find(|p| p.id == crate::config::tts::KOKORO_DEFAULT_PROFILE_ID)
            .expect("bundled Kokoro profile");
        kokoro.post_process = ProfilePostProcess {
            enabled: true,
            active_template_id: Some("my-custom-template".into()),
        };
        let kitten = on_disk
            .tts
            .profiles
            .iter_mut()
            .find(|p| p.id == crate::config::tts::KITTEN_DEFAULT_PROFILE_ID)
            .expect("bundled Kitten profile");
        kitten.post_process = ProfilePostProcess {
            enabled: true,
            active_template_id: None,
        };
        save_to(&path, &on_disk).expect("write v8 config");

        let loaded = load_or_default_from(&path);
        assert_eq!(loaded.tts.schema_version, 8);

        let kokoro = loaded
            .tts
            .profiles
            .iter()
            .find(|p| p.id == crate::config::tts::KOKORO_DEFAULT_PROFILE_ID)
            .unwrap();
        assert!(kokoro.post_process.enabled);
        assert_eq!(
            kokoro.post_process.active_template_id.as_deref(),
            Some("my-custom-template")
        );
        let kitten = loaded
            .tts
            .profiles
            .iter()
            .find(|p| p.id == crate::config::tts::KITTEN_DEFAULT_PROFILE_ID)
            .unwrap();
        assert!(kitten.post_process.enabled);
        assert_eq!(kitten.post_process.active_template_id, None);

        for profile in loaded.tts.profiles.iter().filter(|p| {
            p.id != crate::config::tts::KOKORO_DEFAULT_PROFILE_ID
                && p.id != crate::config::tts::KITTEN_DEFAULT_PROFILE_ID
        }) {
            assert!(!profile.post_process.enabled);
            assert_eq!(profile.post_process.active_template_id, None);
        }
        assert!(!loaded.post_process.enabled);

        discard_temp_config(&path);
    }
}
