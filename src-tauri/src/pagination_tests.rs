use super::*;

fn default_config() -> PaginationConfig {
    PaginationConfig::default()
}

#[test]
fn paginate_fast_paths_return_single_fragment() {
    let disabled = PaginationConfig {
        enabled: false,
        ..default_config()
    };
    let long = "This is a very long text that should normally be split into multiple fragments for proper TTS processing.";
    let frags = paginate_text(long, &disabled);
    assert_eq!(frags.len(), 1);
    assert_eq!(frags[0].text, long);

    let big = PaginationConfig {
        enabled: true,
        fragment_size: 2000,
    };
    assert_eq!(paginate_text("Short text.", &big)[0].text, "Short text.");
    assert_eq!(paginate_text("", &default_config())[0].text, "");

    let exact_cfg = PaginationConfig {
        enabled: true,
        fragment_size: 100,
    };
    let exact = "A".repeat(99) + ".";
    let exact_frags = paginate_text(&exact, &exact_cfg);
    assert_eq!(exact_frags.len(), 1);
    assert_eq!(exact_frags[0].text, exact);

    let ws_cfg = PaginationConfig {
        enabled: true,
        fragment_size: 5,
    };
    let ws = paginate_text("          ", &ws_cfg);
    assert_eq!(ws.len(), 1);
    assert_eq!(ws[0].text, "          ");
}

#[test]
fn test_should_paginate() {
    let config = PaginationConfig {
        enabled: true,
        fragment_size: 100,
    };
    assert!(!should_paginate("Short text.", &config));
    assert!(should_paginate("A".repeat(200).as_str(), &config));

    let disabled = PaginationConfig {
        enabled: false,
        ..default_config()
    };
    assert!(!should_paginate(&"A".repeat(200), &disabled));
}

#[test]
fn sentence_boundaries_cover_ascii_and_cjk_marks() {
    let periods = detect_sentence_boundaries("First sentence. Second sentence. Third sentence.");
    assert_eq!(periods.len(), 3);
    assert!(periods.iter().all(|b| b.delimiter == '.'));

    assert!(detect_sentence_boundaries("Hello! World! Test!").len() >= 2);
    assert!(detect_sentence_boundaries("Who? What? Where?").len() >= 2);

    let cjk = detect_sentence_boundaries("这是第一句。这是第二句！这是第三句？");
    assert_eq!(
        cjk.iter().map(|b| b.delimiter).collect::<Vec<_>>(),
        vec!['。', '！', '？']
    );
}

#[test]
fn abbreviations_and_decimal_or_version_periods_are_not_sentence_ends() {
    assert_eq!(
        detect_sentence_boundaries("Mr. Smith went to the store. Dr. Jones was there.").len(),
        2
    );
    assert_eq!(
        detect_sentence_boundaries("We have apples, oranges, etc. Then we have bananas.").len(),
        1
    );
    assert!(
        !detect_sentence_boundaries("Use e.g. apples and i.e. oranges. Then buy more.").is_empty()
    );
    assert!(
        !detect_sentence_boundaries("MR. Smith and mrs. Jones. DR. Williams is here.").is_empty()
    );
    assert_eq!(
        detect_sentence_boundaries(
            "Upgrade to v0.2.10 now. It fixes pi at 3.14 and example.com too."
        )
        .len(),
        2
    );
}

#[test]
fn paginate_splits_at_sentence_boundaries_and_preserves_content() {
    let cases = [
        (
            50,
            "This is sentence one. This is sentence two. This is sentence three. This is sentence four. This is sentence five.",
        ),
        (
            100,
            &format!("{}. {}. {}.", "A".repeat(80), "B".repeat(40), "C".repeat(40)),
        ),
        (
            400,
            &("Short. ".to_owned()
                + &"This is a much longer sentence with many more words. ".repeat(5)
                + "Brief. "
                + &"Another very long sentence that goes on and on. ".repeat(3)),
        ),
    ];
    for (fragment_size, text) in cases {
        let config = PaginationConfig {
            enabled: true,
            fragment_size,
        };
        let fragments = paginate_text(text, &config);
        assert!(
            fragments.len() > 1,
            "expected split for size {fragment_size}"
        );
        for (i, fragment) in fragments.iter().enumerate() {
            assert_eq!(fragment.index, i);
            assert_eq!(fragment.total, fragments.len());
            if fragment.index + 1 < fragment.total && !fragment.text.is_empty() {
                let last_char = fragment.text.chars().last().unwrap();
                assert!(is_sentence_end(last_char), "{}", fragment.text);
            }
        }
        let combined: String = fragments.iter().map(|f| f.text.as_str()).collect();
        assert_eq!(combined.replace(' ', ""), text.replace(' ', ""));
    }
}

#[test]
fn test_paginate_with_various_fragment_sizes_same_text() {
    let text = "This is sentence one. This is sentence two. This is sentence three. This is sentence four. This is sentence five.";
    let mut previous_count = usize::MAX;
    for size in [50, 100, 200, 500] {
        let config = PaginationConfig {
            enabled: true,
            fragment_size: size,
        };
        let fragments = paginate_text(text, &config);
        assert!(fragments.len() <= previous_count);
        previous_count = fragments.len();
    }
}

#[test]
fn test_force_split_never_breaks_a_word() {
    let config = PaginationConfig {
        enabled: true,
        fragment_size: 20,
    };
    let text = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu";
    let fragments = paginate_text(text, &config);
    assert!(fragments.len() > 1);
    for fragment in &fragments {
        let trimmed = fragment.text.trim();
        assert!(!trimmed.is_empty());
        assert!(fragment.text.starts_with(trimmed) && fragment.text.ends_with(trimmed));
    }
    let rejoined: String = fragments
        .iter()
        .map(|f| f.text.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    for word in text.split_whitespace() {
        assert!(rejoined.split_whitespace().any(|w| w == word));
    }
}

#[test]
fn test_oversized_tail_after_a_short_sentence_is_split() {
    let config = PaginationConfig {
        enabled: true,
        fragment_size: 50,
    };
    let tail = "word ".repeat(40);
    let text = format!("Short. {}", tail.trim());
    let fragments = paginate_text(&text, &config);
    assert!(fragments.len() > 1);
    for fragment in &fragments {
        assert!(fragment.text.chars().count() <= config.fragment_size as usize);
    }
}

#[test]
fn test_missing_space_after_sentence_period_stays_word_safe() {
    let text = "The sky is blue.It looks nice.";
    let fragments = paginate_text(
        text,
        &PaginationConfig {
            enabled: true,
            fragment_size: 12,
        },
    );
    assert!(fragments.len() > 1, "expected force split: {fragments:?}");
    assert!(
        fragments
            .iter()
            .any(|f| f.text.split_whitespace().any(|w| w == "blue.It")),
        "blue.It must stay intact: {:?}",
        fragments.iter().map(|f| &f.text).collect::<Vec<_>>()
    );
    for fragment in &fragments {
        for word in fragment.text.split_whitespace() {
            assert!(
                text.split_whitespace().any(|w| w == word),
                "fragment word {word:?} is not a whole source word"
            );
        }
    }
}

#[test]
fn initialisms_identifiers_and_punctuated_latin_tokens_stay_whole() {
    let config = PaginationConfig {
        enabled: true,
        fragment_size: 40,
    };
    for token in [
        "U.S.A.",
        "Ph.D.",
        "System.Console",
        "README.TXT",
        "192.168.1.1",
    ] {
        let text = format!("Please send the parcel to the {token} office and confirm");
        let fragments = paginate_text(&text, &config);
        for fragment in &fragments {
            for word in fragment.text.split_whitespace() {
                assert!(text.split_whitespace().any(|w| w == word));
            }
        }
        assert!(fragments
            .iter()
            .any(|f| f.text.split_whitespace().any(|w| w == token)));
    }

    let tight = "Send it to the U.S.A. office now and Ph.D. students later on";
    let tight_frags = paginate_text(
        tight,
        &PaginationConfig {
            enabled: true,
            fragment_size: 12,
        },
    );
    for fragment in &tight_frags {
        for word in fragment.text.split_whitespace() {
            assert!(
                tight.split_whitespace().any(|w| w == word),
                "fragment word {word:?} is not a whole source word"
            );
        }
    }

    for token in [
        "https://example.com/some/very/long/path/that/keeps/going/and/going",
        "client/server",
        "1,000,000",
        "https://example.com/path?token=abcdef",
        "https://example.com/.well-known/security.txt",
        "../path/file.txt",
        "some_.name",
        "Hello!World?Test",
    ] {
        let fragments = paginate_text(
            &format!("before {token} after"),
            &PaginationConfig {
                enabled: true,
                fragment_size: 5,
            },
        );
        assert!(fragments.iter().any(|fragment| fragment.text == token));
    }
}

#[test]
fn oversized_token_is_kept_whole_below_hard_cap_and_split_above() {
    let small_cfg = PaginationConfig {
        enabled: true,
        fragment_size: 20,
    };
    let token = "x".repeat(70);
    let fragments = paginate_text(&format!("alpha {token} omega"), &small_cfg);
    assert!(fragments.iter().any(|f| f.text == token));

    let cap_cfg = PaginationConfig {
        enabled: true,
        fragment_size: 50,
    };
    let huge = "y".repeat(TOKEN_HARD_CAP + 100);
    assert!(paginate_text(&huge, &cap_cfg).len() > 1);
}

#[test]
fn non_latin_scripts_split_on_clause_and_danda_boundaries() {
    let cjk = "这是第一句话，这是第二句话，这是第三句话，这是第四句话";
    let ranges = force_split_ranges(cjk, 12);
    assert!(ranges.len() > 1);
    let chars: Vec<char> = cjk.chars().collect();
    for (_, end) in &ranges {
        if *end < chars.len() {
            assert!(is_cjk_clause_delimiter(chars[*end - 1]));
        }
    }

    let hindi = "यह एक परीक्षण वाक्य है। ".repeat(6);
    let hindi_frags = paginate_text(
        &hindi,
        &PaginationConfig {
            fragment_size: 60,
            ..default_config()
        },
    );
    assert!(hindi_frags.len() > 1);
    for fragment in &hindi_frags {
        assert!(fragment.text.ends_with('।'));
        for word in fragment.text.split_whitespace() {
            assert!(hindi.split_whitespace().any(|w| w == word));
        }
    }
}
