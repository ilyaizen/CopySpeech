use super::*;
use crate::config::SanitizationConfig;
use crate::sanitize::{sanitize_text, tts_normalize::sanitize_tts};

#[test]
fn cleanup_artifacts_normalizes_spaces_commas_and_ellipsis() {
    assert_eq!(cleanup_artifacts("word  more"), "word more");
    assert_eq!(cleanup_artifacts("word   more"), "word more");
    assert_eq!(cleanup_artifacts("word , more"), "word, more");
    assert_eq!(cleanup_artifacts("word  , more"), "word, more");
    assert_eq!(cleanup_artifacts("word,, more"), "word, more");
    assert_eq!(cleanup_artifacts("word, , more"), "word, more");
    assert_eq!(cleanup_artifacts("word,,, more"), "word, more");
    assert_eq!(cleanup_artifacts("word,."), "word.");
    assert_eq!(cleanup_artifacts("word, ."), "word.");
    assert_eq!(cleanup_artifacts("word,next"), "word, next");
    assert_eq!(cleanup_artifacts("word;next"), "word; next");
    assert_eq!(cleanup_artifacts("word,"), "word");
    assert_eq!(cleanup_artifacts("word, "), "word");
    assert_eq!(cleanup_artifacts("word..."), "word...");
    assert_eq!(cleanup_artifacts("wait... more"), "wait... more");
}

#[test]
fn sanitize_tts_cleans_parentheses_and_em_dash_spacing() {
    assert_eq!(sanitize_tts("text (aside) more"), "text, aside, more");
    assert_eq!(sanitize_tts("text (aside), more"), "text, aside, more");
    assert_eq!(sanitize_tts("word\u{2014}another"), "word, another");

    let input = "integrity (wholeness), grace (composure) and kindness under pressure (and a balanced proportion), seeing things";
    let result = sanitize_tts(input);
    assert!(!result.contains(",,"), "Double commas in: {result}");
    assert!(!result.contains(" ,"), "Space before comma in: {result}");
    assert!(!result.ends_with(','), "Trailing comma in: {result}");
}

#[test]
fn full_pipeline_handles_realistic_markdown_and_strips_newlines() {
    let config = SanitizationConfig {
        enabled: true,
        markdown: crate::config::MarkdownSanitizationConfig {
            enabled: true,
            strip_bold_italic: true,
            ..Default::default()
        },
        tts_normalization: crate::config::TtsNormalizationConfig { enabled: true },
        ..Default::default()
    };

    let input = r#"# Introduction

According to **recent studies** [1], the speed limit is ~100 km/h (e.g. on highways). Dr. Smith & Prof. Johnson reported that the company's revenue grew from $2bn to $5bn.

Visit https://example.com for more info & contact user@example.com.

- Item 1
- Item 2

> This is an important quote from the research.

Use `sudo apt-get install` for setup.

See [documentation](https://docs.example.com) for details.

## Key Points

The project is valued at **100M** with 5k users. Cost is €50 per unit & ~10% profit margin."#;

    let result = sanitize_text(input, &config);
    assert!(!result.contains('\n'));
    assert!(!result.contains('#'));
    assert!(!result.contains("**"));
    assert!(!result.contains("[1]"));
    assert!(!result.contains("[documentation]"));
    assert!(!result.contains("- "));
    assert!(!result.contains("> "));
    assert!(result.contains('`'));
    assert!(!result.contains("https://"));
    assert!(result.contains("for example"));
    assert!(result.contains("approximately"));
    assert!(result.contains("kilometers"));
    assert!(result.contains("and"));
    assert!(result.contains("per"));
    assert!(result.contains("Doctor"));
    assert!(result.contains("Professor"));
    assert!(result.contains("billion"));
    assert!(result.contains("million"));
    assert!(result.contains("thousand"));
    assert!(result.contains("dollars"));
    assert!(result.contains("euros"));
    assert!(result.contains("at example.com"));
    assert!(!result.contains("  "));
    assert!(!result.contains(",,"));
}

#[test]
fn full_pipeline_respects_pass_toggles() {
    let input = "# Title\n**Bold** text & ~100 km/h.";

    let disabled = SanitizationConfig {
        enabled: false,
        ..Default::default()
    };
    assert_eq!(sanitize_text(input, &disabled), input);

    let md_only = SanitizationConfig {
        enabled: true,
        markdown: crate::config::MarkdownSanitizationConfig {
            enabled: true,
            strip_bold_italic: true,
            ..Default::default()
        },
        tts_normalization: crate::config::TtsNormalizationConfig { enabled: false },
        ..Default::default()
    };
    let md_res = sanitize_text(input, &md_only);
    assert!(!md_res.contains('#'));
    assert!(!md_res.contains("**"));
    assert!(md_res.contains('&'));
    assert!(md_res.contains('~'));

    let tts_only = SanitizationConfig {
        enabled: true,
        markdown: crate::config::MarkdownSanitizationConfig {
            enabled: false,
            ..Default::default()
        },
        tts_normalization: crate::config::TtsNormalizationConfig { enabled: true },
        ..Default::default()
    };
    let tts_res = sanitize_text(input, &tts_only);
    assert!(tts_res.contains('#'));
    assert!(tts_res.contains("**"));
    assert!(tts_res.contains("and"));
    assert!(tts_res.contains("approximately"));
    assert!(tts_res.contains("kilometers"));
}

#[test]
fn test_full_preprocessing_pipeline_empty_after_filtering() {
    let config = SanitizationConfig {
        enabled: true,
        markdown: crate::config::MarkdownSanitizationConfig {
            enabled: true,
            ..Default::default()
        },
        tts_normalization: crate::config::TtsNormalizationConfig { enabled: true },
        ..Default::default()
    };
    assert!(sanitize_text("``````", &config).trim().is_empty());
}
