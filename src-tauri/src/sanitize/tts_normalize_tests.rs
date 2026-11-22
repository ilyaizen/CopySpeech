use super::*;

#[test]
fn normalize_characters_folds_quotes_dashes_fullwidth_and_homoglyphs() {
    assert_eq!(
        normalize_characters("\u{201C}quoted\u{201D} and \u{2018}single\u{2019}"),
        "\"quoted\" and 'single'"
    );
    assert_eq!(normalize_characters("co\u{2013}op"), "co-op");
    assert_eq!(normalize_characters("a\u{00A0}b\u{202F}c"), "a b c");
    assert_eq!(
        normalize_characters("Ｈｅｌｌｏ　Ｗｏｒｌｄ"),
        "Hello World"
    );
    // Cyrillic lookalikes fold only when mixed with Latin letters.
    assert_eq!(normalize_characters("саt"), "cat");
    assert_eq!(normalize_characters("жизнь"), "жизнь");
    assert_eq!(normalize_characters("привет саt"), "привет cat");
    assert_eq!(normalize_characters("Россия"), "Россия");
}

#[test]
fn normalize_strips_invisibles_but_keeps_zero_width_non_joiner() {
    assert_eq!(
        normalize_characters("in\u{200B}vis\u{00AD}ible"),
        "invisible"
    );
    assert_eq!(normalize_characters("\u{FEFF}leading"), "leading");
    assert_eq!(sanitize_tts("می\u{200C}خواهم"), "می\u{200C}خواهم");
}

#[test]
fn strip_leading_orphans_and_acceptance_example() {
    assert_eq!(
        strip_leading_orphans(", They didn't know that they were looking for a better theory."),
        "They didn't know that they were looking for a better theory."
    );
    assert_eq!(strip_leading_orphans(" ••  Point one"), "Point one");
    assert_eq!(
        strip_leading_orphans("\"Quoted start\""),
        "\"Quoted start\""
    );
    assert_eq!(
        sanitize_tts(", They didn\u{2019}t know that they were looking for a better theory."),
        "They didn't know that they were looking for a better theory."
    );
}

#[test]
fn remove_unpronounceable_strips_emojis_symbol_scripts_and_controls() {
    assert_eq!(remove_unpronounceable("Hello 😀 world"), "Hello  world");
    assert_eq!(remove_unpronounceable("🎉🎊 Party time"), " Party time");
    assert_eq!(remove_unpronounceable("No emojis here"), "No emojis here");
    assert_eq!(remove_unpronounceable("🌍 Earth 🌏"), " Earth ");
    assert_eq!(remove_unpronounceable("Text ✅ check"), "Text  check");

    assert_eq!(remove_unpronounceable("A⭐B★C→D∑E①F■G"), "ABCDEFG");
    assert_eq!(remove_unpronounceable("⌚ watch ⏩ now"), " watch  now");
    assert_eq!(remove_unpronounceable("🀄🂠🄰 tiles"), " tiles");
    assert_eq!(
        remove_unpronounceable("wow‼ really⁉ infoℹ"),
        "wow really info"
    );
    assert_eq!(remove_unpronounceable("🇺🇸 US flag"), " US flag");

    assert_eq!(remove_unpronounceable("x\u{E000}y"), "xy");
    assert_eq!(remove_unpronounceable("bad \u{FFFD} data"), "bad  data");
    assert_eq!(remove_unpronounceable("hy\u{00AD}phen"), "hyphen");
    assert_eq!(remove_unpronounceable("a\u{200B}b"), "ab");
    assert_eq!(remove_unpronounceable("\u{FEFF}text"), "text");
    assert_eq!(remove_unpronounceable("a\u{0007}\u{009F}b"), "ab");
    assert_eq!(remove_unpronounceable("1\u{FE0F}\u{20E3}"), "1");
}

#[test]
fn remove_unpronounceable_normalizes_whitespace_controls_and_keeps_speech() {
    assert_eq!(remove_unpronounceable("foo\tbar"), "foo bar");
    assert_eq!(remove_unpronounceable("a\u{000B}b\u{000C}c"), "a b c");
    assert_eq!(
        remove_unpronounceable("it's — ok… \"quoted\""),
        "it's — ok… \"quoted\""
    );
    assert_eq!(remove_unpronounceable("a、b。c「d」"), "a、b。c「d」");
    assert_eq!(remove_unpronounceable("50% + $5"), "50% + $5");
}

#[test]
fn strips_newlines_urls_and_citations() {
    assert_eq!(sanitize_tts("line one\nline two"), "line one line two");
    assert_eq!(sanitize_tts("a\r\nb\nc"), "a b c");
    assert_eq!(sanitize_tts("no newlines"), "no newlines");

    assert_eq!(
        remove_urls("Visit https://example.com for info"),
        "Visit  for info"
    );
    assert_eq!(remove_urls("See http://foo.bar/path?q=1 here"), "See  here");
    assert_eq!(remove_urls("No URLs here"), "No URLs here");

    assert_eq!(
        remove_citations("According to [1] and [12]"),
        "According to  and "
    );
    assert_eq!(remove_citations("See [a] and [xyz]"), "See  and ");
    assert_eq!(remove_citations("No citations"), "No citations");
}

#[test]
fn expands_slash_lookups_options_and_ratios() {
    assert_eq!(expand_slash_lookups("w/o any issue"), "without any issue");
    assert_eq!(expand_slash_lookups("w/ sugar"), "with sugar");
    assert_eq!(expand_slash_lookups("n/a"), "not applicable");
    assert_eq!(expand_slash_lookups("and/or both"), "and or both");

    assert_eq!(
        expand_slash_options("true/false value"),
        "true or false value"
    );
    assert_eq!(
        expand_slash_options("yes/no question"),
        "yes or no question"
    );

    assert_eq!(expand_slash_ratios("100 km/h speed"), "100 km per h speed");
    assert_eq!(
        expand_slash_ratios("9.8 m/s acceleration"),
        "9.8 m per s acceleration"
    );
}

#[test]
fn expands_latin_and_title_abbreviations() {
    assert_eq!(
        expand_latin_abbreviations("e.g. this one"),
        "for example this one"
    );
    assert_eq!(
        expand_latin_abbreviations("i.e. that is"),
        "that is that is"
    );
    assert_eq!(
        expand_latin_abbreviations("and etc. more"),
        "and et cetera more"
    );
    assert_eq!(expand_latin_abbreviations("A vs. B"), "A versus B");

    assert_eq!(expand_title_abbreviations("Dr. Smith"), "Doctor Smith");
    assert_eq!(expand_title_abbreviations("Mr. Johnson"), "Mister Johnson");
    assert_eq!(expand_title_abbreviations("Mrs. Davis"), "Misses Davis");
    assert_eq!(expand_title_abbreviations("Ms. Williams"), "Miss Williams");
    assert_eq!(expand_title_abbreviations("Prof. Brown"), "Professor Brown");
    assert_eq!(expand_title_abbreviations("Rev. White"), "Reverend White");
    assert_eq!(
        expand_title_abbreviations("Sr. Martinez"),
        "Senior Martinez"
    );
    assert_eq!(
        expand_title_abbreviations("Jr. King Jr."),
        "Junior King Junior "
    );
    assert_eq!(expand_title_abbreviations("Hon. Lee"), "Honorable Lee");
    assert_eq!(expand_title_abbreviations("Sir John"), "Sir John");
    assert_eq!(
        expand_title_abbreviations("Madam President"),
        "Madam President"
    );
}

#[test]
fn expands_number_suffixes_and_ignores_bare_letters() {
    for (input, expected) in [
        ("2bn revenue", "2 billion revenue"),
        ("1.5bn users", "1.5 billion users"),
        ("$2bn deal", "$2 billion deal"),
        ("3B valuation", "3 billion valuation"),
        ("5m users", "5 million users"),
        ("5 m users", "5 million users"),
        ("2.5m downloads", "2.5 million downloads"),
        ("10M followers", "10 million followers"),
        ("3k subscribers", "3 thousand subscribers"),
        ("2 k followers", "2 thousand followers"),
        ("50K views", "50 thousand views"),
        ("2.5k stars", "2.5 thousand stars"),
        ("1tr market cap", "1 trillion market cap"),
        ("2TR debt", "2 trillion debt"),
        ("100k", "100 thousand"),
        ("1000K", "1000 thousand"),
        ("999M", "999 million"),
        ("100B", "100 billion"),
        ("999tr", "999 trillion"),
        ("3.75bn", "3.75 billion"),
        ("4.5tr", "4.5 trillion"),
        ("0k", "0 thousand"),
        ("0M", "0 million"),
        ("0bn", "0 billion"),
        ("0B", "0 billion"),
        ("0tr", "0 trillion"),
        ("from 5m to 10m users", "from 5 million to 10 million users"),
        (
            "Revenue hit $5bn this quarter",
            "Revenue hit $5 billion this quarter",
        ),
        ("$10k profit", "$10 thousand profit"),
        ("€5M funding", "€5 million funding"),
        ("£2bn deal", "£2 billion deal"),
        ("maximum", "maximum"),
        ("bank", "bank"),
        ("milk", "milk"),
        ("k users", "k users"),
        ("M downloads", "M downloads"),
        ("bn revenue", "bn revenue"),
        ("B valuation", "B valuation"),
        ("tr market cap", "tr market cap"),
    ] {
        assert_eq!(expand_number_suffixes(input), expected, "{input}");
    }
}

#[test]
fn expands_metric_units_after_number_suffix_priority() {
    assert_eq!(expand_metric_units("10mm gap"), "10 millimeters gap");
    assert_eq!(expand_metric_units("5 cm wide"), "5 centimeters wide");
    assert_eq!(expand_metric_units("3km away"), "3 kilometers away");
    assert_eq!(expand_metric_units("2kg of rice"), "2 kilograms of rice");
    assert_eq!(expand_metric_units("500g pack"), "500 grams pack");
    assert_eq!(expand_metric_units("10 m tall"), "10 meters tall");
    assert_eq!(expand_metric_units("maximum"), "maximum");

    assert!(sanitize_tts("The company has 5m users").contains("million"));
    assert!(sanitize_tts("The distance is 5km").contains("kilometers"));
}

#[test]
fn expands_operators_and_at_symbols() {
    assert!(expand_symbols("A & B").contains("and"));
    assert!(expand_symbols("50%").contains("percent"));
    assert!(expand_symbols("~100").contains("approximately"));
    assert!(expand_symbols("2 + 3").contains("plus"));
    assert!(expand_symbols("x = 5").contains("equals"));
    assert!(expand_symbols("90°").contains("degrees"));
    assert_eq!(
        expand_symbols("email user@example.com here"),
        "email user at example.com here"
    );
    assert_eq!(expand_symbols("@username"), "at username");
}

#[test]
fn expands_currency_symbols_and_edge_cases() {
    for (input, expected) in [
        ("$50", "50 dollars"),
        ("€20", "20 euros"),
        ("£15", "15 pounds"),
        ("¥1000", "1000 yen"),
        ("$19.99", "19.99 dollars"),
        ("€12.50", "12.50 euros"),
        ("£3.75", "3.75 pounds"),
        ("The price is $50", "The price is 50 dollars"),
        ("It costs €20 total", "It costs 20 euros total"),
        ("You owe £15 to me", "You owe 15 pounds to me"),
        ("$50 and $100", "50 dollars and 100 dollars"),
        ("€20 to €30", "20 euros to 30 euros"),
        (
            "$50 and €20 and £15",
            "50 dollars and 20 euros and 15 pounds",
        ),
        ("Convert $100 to €85", "Convert 100 dollars to 85 euros"),
        ("Price:$50", "Price:50 dollars"),
        ("Cost(€20)", "Cost(20 euros)"),
        ("$0", "0 dollars"),
        ("€.50", "€.50"),
        ("$", "$"),
        ("$$$", "$$$"),
        ("50$", "50$"),
    ] {
        assert_eq!(expand_symbols(input), expected, "{input}");
    }
}

#[test]
fn normalizes_punctuation_and_runs_combined_pipeline() {
    assert_eq!(normalize_punctuation("wait\u{2026}"), "wait...");
    assert_eq!(normalize_punctuation("wait. . ."), "wait...");
    assert_eq!(normalize_punctuation("wait..."), "wait...");
    assert_eq!(
        normalize_punctuation("word\u{2014}another"),
        "word, another"
    );
    assert_eq!(
        normalize_punctuation("text (aside) more"),
        "text , aside, more"
    );

    let input = "According to [1], the speed is ~100 km/h (e.g. on highways) & drivers should check https://traffic.info for updates etc.";
    let result = sanitize_tts(input);
    assert!(!result.contains("https://"));
    assert!(!result.contains("[1]"));
    assert!(result.contains("and"));
    assert!(result.contains("approximately"));
    assert!(result.contains("for example"));
    assert!(result.contains("et cetera"));
}
