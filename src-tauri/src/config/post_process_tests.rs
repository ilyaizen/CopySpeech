use super::*;

#[test]
fn default_config_seeds_builtin_providers_templates_and_prompts() {
    let cfg = PostProcessConfig::default();
    assert_eq!(cfg.provider_id, "groq");
    assert_eq!(cfg.active_provider().map(|p| p.id.as_str()), Some("groq"));
    let provider_ids: Vec<&str> = cfg.providers.iter().map(|p| p.id.as_str()).collect();
    assert!(provider_ids.contains(&"zai"));
    assert!(provider_ids.contains(&"openrouter"));

    let template_ids: Vec<&str> = cfg.templates.iter().map(|t| t.id.as_str()).collect();
    assert_eq!(template_ids, vec!["dramatize", "concise"]);
    assert_eq!(cfg.active_template_id, "dramatize");
    assert_eq!(
        cfg.active_template().map(|t| t.class),
        Some(PostProcessTemplateClass::Preserve)
    );
    assert_eq!(
        cfg.templates
            .iter()
            .find(|t| t.id == "concise")
            .unwrap()
            .class,
        PostProcessTemplateClass::Rewrite
    );
    assert_eq!(cfg.min_chars, 0);

    assert!(CONCISE_PROMPT.starts_with("You compress text"));
    assert!(CONCISE_PROMPT.contains("${output}"));
    assert!(CONCISE_PROMPT.contains("Keep every fact, name, number"));
    assert!(CONCISE_PROMPT.ends_with("Text:\n${output}"));

    assert!(DEFAULT_POST_PROCESS_PROMPT.starts_with("You add expressive audio tags"));
    assert!(DEFAULT_POST_PROCESS_PROMPT.contains("${output}"));
    assert!(DEFAULT_POST_PROCESS_PROMPT.contains("[sighs]"));
    assert!(DEFAULT_POST_PROCESS_PROMPT.contains("Do not use <break> or SSML"));
    assert!(!DEFAULT_POST_PROCESS_PROMPT
        .to_lowercase()
        .contains("caveman"));
}

#[test]
fn normalize_folds_legacy_groq_credentials_once_and_never_resurrects() {
    let mut cfg = PostProcessConfig {
        api_key: "gsk_legacy".to_string(),
        model: "llama-3.1-8b-instant".to_string(),
        ..Default::default()
    };
    cfg.normalize();
    assert!(cfg.api_key.is_empty());
    assert!(cfg.model.is_empty());
    let groq = cfg.providers.iter().find(|p| p.id == "groq").unwrap();
    assert_eq!(groq.api_key, "gsk_legacy");
    assert_eq!(groq.model, "llama-3.1-8b-instant");

    cfg.normalize();
    let groq = cfg.providers.iter().find(|p| p.id == "groq").unwrap();
    assert_eq!(groq.api_key, "gsk_legacy");
    assert_eq!(groq.model, "llama-3.1-8b-instant");

    let mut current = PostProcessConfig::default();
    current
        .providers
        .iter_mut()
        .find(|p| p.id == "groq")
        .unwrap()
        .api_key = "gsk_current".to_string();
    current.normalize();
    assert_eq!(
        current
            .providers
            .iter()
            .find(|p| p.id == "groq")
            .unwrap()
            .api_key,
        "gsk_current"
    );
}

#[test]
fn legacy_and_missing_template_fields_fold_to_builtins_with_gating_defaults() {
    let mut legacy_prompts = vec!["".to_string()];
    legacy_prompts.extend(LEGACY_DEFAULT_PROMPTS.iter().map(|s| s.to_string()));
    for prompt in legacy_prompts {
        let mut cfg = PostProcessConfig {
            prompt,
            templates: Vec::new(),
            active_template_id: String::new(),
            ..Default::default()
        };
        cfg.normalize();
        assert_eq!(cfg.prompt, "");
        assert_eq!(
            cfg.templates
                .iter()
                .map(|t| t.id.as_str())
                .collect::<Vec<_>>(),
            vec!["dramatize", "concise"]
        );
        assert_eq!(cfg.active_template_id, "dramatize");
        cfg.normalize();
        assert_eq!(cfg.templates.len(), 2);
    }

    let mut missing: PostProcessConfig = serde_json::from_str(r#"{ "enabled": true }"#).unwrap();
    assert!(missing.templates.is_empty());
    assert_eq!(missing.min_chars, 0);
    assert!(!missing.require_request_flag);
    assert_eq!(missing.timeout_secs, 5);
    missing.normalize();
    let active = missing.active_template().expect("builtins seeded");
    assert_eq!(active.id, "dramatize");
    assert!(active.prompt.contains("${output}"));
    assert_eq!(missing.prompt, "");

    let overridden: PostProcessConfig = serde_json::from_str(
        r#"{ "enabled": true, "min_chars": 0, "require_request_flag": true, "timeout_secs": 0 }"#,
    )
    .unwrap();
    assert!(overridden.require_request_flag);
    assert_eq!(overridden.timeout_secs, 0);
}

#[test]
fn custom_legacy_prompts_fold_to_rewrite_template_and_drop_legacy_fields() {
    let json = r#"{
        "enabled": true,
        "prompt": "p ${output}",
        "api_key": "gsk_old",
        "model": "openai/gpt-oss-20b"
    }"#;
    let mut cfg: PostProcessConfig = serde_json::from_str(json).unwrap();
    cfg.normalize();
    assert!(cfg.enabled);
    assert_eq!(cfg.provider_id, "groq");
    let groq = cfg.providers.iter().find(|p| p.id == "groq").unwrap();
    assert_eq!(groq.api_key, "gsk_old");
    assert_eq!(groq.model, "openai/gpt-oss-20b");

    let active = cfg.active_template().unwrap();
    assert_eq!(active.id, "custom-legacy");
    assert_eq!(active.name, "Custom");
    assert_eq!(active.prompt, "p ${output}");
    assert_eq!(active.class, PostProcessTemplateClass::Rewrite);

    // Idempotent on second normalize.
    cfg.normalize();
    assert_eq!(cfg.templates.len(), 3);
    assert_eq!(cfg.active_template_id, "custom-legacy");

    let out = serde_json::to_string(&cfg).unwrap();
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert!(v.get("api_key").is_none());
    assert!(v.get("model").is_none());
    assert!(v.get("prompt").is_none());
    assert_eq!(v["templates"].as_array().unwrap().len(), 3);
    assert_eq!(v["active_template_id"], "custom-legacy");
    assert_eq!(v["providers"].as_array().unwrap()[0]["api_key"], "gsk_old");
}

#[test]
fn normalize_repairs_dangling_ids_reseeds_deleted_builtins_and_falls_back() {
    let mut dangling_provider = PostProcessConfig {
        provider_id: "deleted-provider".to_string(),
        ..Default::default()
    };
    dangling_provider.normalize();
    assert_eq!(dangling_provider.provider_id, "groq");

    let mut empty_registry = PostProcessConfig {
        providers: Vec::new(),
        ..Default::default()
    };
    empty_registry.normalize();
    assert!(empty_registry.active_provider().is_none());

    let mut reseed = PostProcessConfig::default();
    reseed.normalize();
    reseed.templates.retain(|t| t.id != "concise");
    reseed
        .templates
        .iter_mut()
        .find(|t| t.id == "dramatize")
        .unwrap()
        .prompt = "edited ${output}".to_string();
    reseed.normalize();
    assert!(reseed.templates.iter().any(|t| t.id == "concise"));
    assert_eq!(
        reseed
            .templates
            .iter()
            .find(|t| t.id == "dramatize")
            .unwrap()
            .prompt,
        "edited ${output}"
    );
    assert_eq!(reseed.active_template_id, "dramatize");

    let mut dangling_tpl = PostProcessConfig {
        active_template_id: "deleted-template".to_string(),
        ..Default::default()
    };
    dangling_tpl.normalize();
    assert_eq!(dangling_tpl.active_template_id, "dramatize");

    // Without normalize, raw accessors fall back to the first entry.
    dangling_tpl.templates.retain(|t| t.id != "dramatize");
    dangling_tpl.active_template_id = "nope".to_string();
    assert_eq!(
        dangling_tpl.active_template().map(|t| t.id.as_str()),
        Some("concise")
    );
    let raw_provider = PostProcessConfig {
        provider_id: "nope".to_string(),
        ..Default::default()
    };
    assert_eq!(
        raw_provider.active_provider().map(|p| p.id.as_str()),
        Some("groq")
    );
}
