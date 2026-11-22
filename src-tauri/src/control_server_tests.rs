use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use tokio::sync::oneshot;

fn post_request(path: &str, body: &str) -> Vec<u8> {
    format!(
        "POST {} HTTP/1.1\r\nContent-Length: {}\r\n\r\n{}",
        path,
        body.len(),
        body
    )
    .into_bytes()
}

fn speak_request(body: &serde_json::Value) -> Vec<u8> {
    let body = body.to_string();
    format!(
        "POST /speak HTTP/1.1\r\nContent-Length: {}\r\n\r\n{}",
        body.len(),
        body
    )
    .into_bytes()
}

#[test]
fn loopback_accepts_loopback_and_rejects_external_or_malformed() {
    for addr in [
        "127.0.0.1:43117",
        "127.9.9.9:8080",
        "[::1]:43117",
        "localhost:43117",
        "LOCALHOST:43117",
    ] {
        assert!(is_loopback_addr(addr), "{addr} should be loopback");
    }
    for addr in [
        "0.0.0.0:43117",
        "192.168.1.5:43117",
        "[::]:43117",
        "example.com:43117",
        "10.0.0.1:43117",
        "",
        "not an address",
    ] {
        assert!(!is_loopback_addr(addr), "{addr} must be rejected");
    }
}

#[test]
fn parse_request_routes_status_stop_pause_resume_and_seek() {
    assert!(matches!(
        parse_request(b"GET /status HTTP/1.1\r\nHost: 127.0.0.1:43117\r\n\r\n"),
        Ok(ControlRequest::Status)
    ));
    assert!(matches!(
        parse_request(b"POST /stop HTTP/1.1\r\nContent-Length: 0\r\n\r\n"),
        Ok(ControlRequest::Stop(StopRequest { request_id: None }))
    ));
    assert!(matches!(
        parse_request(&post_request("/stop", "{}")),
        Ok(ControlRequest::Stop(StopRequest { request_id: None }))
    ));
    assert!(matches!(
        parse_request(&post_request("/stop", r#"{"request_id":"hermes-abc123"}"#)),
        Ok(ControlRequest::Stop(StopRequest {
            request_id: Some(ref id),
        })) if id == "hermes-abc123"
    ));
    assert!(matches!(
        parse_request(&post_request("/pause", r#"{"request_id":"hermes-p"}"#)),
        Ok(ControlRequest::Pause(ref id)) if id == "hermes-p"
    ));
    assert!(matches!(
        parse_request(&post_request("/resume", r#"{"request_id":"hermes-r"}"#)),
        Ok(ControlRequest::Resume(ref id)) if id == "hermes-r"
    ));
    for (body, expected) in [
        (r#"{"request_id":"hermes-s","delta_ms":5000}"#, 5000i64),
        (r#"{"request_id":"hermes-s","delta_ms":-5000}"#, -5000),
        (r#"{"request_id":"hermes-s","delta_ms":60000}"#, 60_000),
        (r#"{"request_id":"hermes-s","delta_ms":-60000}"#, -60_000),
    ] {
        assert!(matches!(
            parse_request(&post_request("/seek", body)),
            Ok(ControlRequest::Seek(SeekControl {
                ref request_id,
                delta_ms,
            })) if request_id == "hermes-s" && delta_ms == expected
        ));
    }
}

#[test]
fn status_body_serves_the_reported_caption_with_cors() {
    let caption = r#"{"text":"hi","captions":null,"position_ms":42,"duration_ms":1000,"paused":false,"active":true}"#;
    crate::playback_signal::remember_caption(caption.to_string());
    assert_eq!(status_body(), caption);
    let response = http_response_cors(200, "OK", &status_body());
    assert!(response.starts_with("HTTP/1.1 200 OK\r\n"));
    assert!(response.contains("Content-Type: application/json\r\n"));
    assert!(response.contains("Access-Control-Allow-Origin: *\r\n"));
    assert!(response.ends_with(caption));
    assert!(!http_response(200, "OK", r#"{"ok":true}"#).contains("Access-Control-Allow-Origin"));
}

#[test]
fn invalid_requests_controls_and_speak_options_are_rejected() {
    assert!(matches!(
        parse_request(&post_request("/play", "{}")),
        Err((404, _))
    ));
    for raw in [
        post_request("/stop", r#"{"request_id":"bad id"}"#),
        post_request("/stop", "not json"),
        speak_request(&serde_json::json!({ "text": "hi", "request_id": "" })),
        post_request("/pause", "{}"),
        post_request("/pause", r#"{"request_id":"bad id"}"#),
        post_request("/resume", "not json"),
        post_request("/seek", r#"{"request_id":"hermes-s"}"#),
        post_request("/seek", r#"{"request_id":"hermes-s","delta_ms":0}"#),
        post_request("/seek", r#"{"request_id":"hermes-s","delta_ms":1.5}"#),
        post_request("/seek", r#"{"request_id":"hermes-s","delta_ms":60001}"#),
        post_request("/seek", r#"{"request_id":"hermes-s","delta_ms":-60001}"#),
        post_request("/seek", r#"{"request_id":"bad id","delta_ms":5000}"#),
    ] {
        assert!(matches!(parse_request(&raw), Err((400, _))));
    }

    let mut request: SpeakRequest =
        serde_json::from_str(r#"{"text":"hello","engine":"not-an-engine"}"#).unwrap();
    assert!(validate_speak_options(&request).is_err());
    request.engine = None;
    request.effect = Some("not-an-effect".to_string());
    assert!(validate_speak_options(&request).is_err());
}

#[test]
fn speak_request_parses_fields_and_legacy_aliases() {
    let full = serde_json::json!({
        "text": "hello",
        "request_id": "hermes-1",
        "wait": true,
        "post_process": true
    });
    let Ok(ControlRequest::Speak(s)) = parse_request(&speak_request(&full)) else {
        panic!("expected speak request");
    };
    assert_eq!(s.text, "hello");
    assert_eq!(s.request_id.as_deref(), Some("hermes-1"));
    assert_eq!(s.wait, Some(true));
    assert_eq!(s.post_process, Some(true));

    let minimal = serde_json::json!({ "text": "hello" });
    let Ok(ControlRequest::Speak(s)) = parse_request(&speak_request(&minimal)) else {
        panic!("expected speak request");
    };
    assert_eq!(s.wait, None);
    assert_eq!(s.post_process, None);

    let legacy = serde_json::json!({
        "text": "hello",
        "profile": "pi",
        "persist_selection": true,
        "condense": true,
        "wait": false
    });
    let Ok(ControlRequest::Speak(s)) = parse_request(&speak_request(&legacy)) else {
        panic!("expected speak request");
    };
    assert_eq!(s.post_process, Some(true));
    assert_eq!(s.wait, Some(false));
}

// ---- request lifecycle (run_speak) ----

fn unique_id(name: &str) -> String {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    format!("{}-{}", name, NEXT.fetch_add(1, Ordering::SeqCst))
}

fn never_finishes(_generation: u64) -> std::future::Pending<bool> {
    std::future::pending()
}

async fn bounded<F: Future>(fut: F) -> F::Output {
    tokio::time::timeout(Duration::from_secs(3), fut)
        .await
        .expect("speak request hung instead of settling")
}

#[tokio::test]
async fn stop_before_speak_registers_never_speaks() {
    let id = unique_id("pre");
    assert_eq!(
        speak_requests::cancel(&id, || panic!("nothing plays yet")),
        speak_requests::StopOutcome::Preempted
    );
    let lock = tokio::sync::Mutex::new(());
    let spoken = AtomicUsize::new(0);
    let outcome = bounded(run_speak(
        Some(&id),
        true,
        &lock,
        |_| {
            spoken.fetch_add(1, Ordering::SeqCst);
            async { Ok(()) }
        },
        never_finishes,
    ))
    .await;
    assert_eq!(outcome, Ok(SpeakOutcome::Cancelled));
    assert_eq!(spoken.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn preempted_and_duplicate_requests_do_not_interrupt_playback() {
    let lock = tokio::sync::Mutex::new(());
    let interrupts = AtomicUsize::new(0);
    let preempted = unique_id("interrupt-preempted");
    speak_requests::cancel(&preempted, || panic!("nothing plays"));
    let result = run_speak_with_interrupt(
        Some(&preempted),
        true,
        &lock,
        abort_generation,
        || {
            interrupts.fetch_add(1, Ordering::SeqCst);
            false
        },
        |_, _| async { Ok(()) },
        never_finishes,
    )
    .await;
    assert_eq!(result, Ok(SpeakOutcome::Cancelled));

    let duplicate = unique_id("interrupt-duplicate");
    let Registration::Proceed(seq) = speak_requests::register(&duplicate) else {
        panic!("request must register");
    };
    let _ticket = Ticket::new(seq);
    let result = run_speak_with_interrupt(
        Some(&duplicate),
        true,
        &lock,
        abort_generation,
        || {
            interrupts.fetch_add(1, Ordering::SeqCst);
            false
        },
        |_, _| async { Ok(()) },
        never_finishes,
    )
    .await;
    assert!(matches!(result, Err((409, _))));
    assert_eq!(interrupts.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn global_abort_during_synthesis_does_not_wait_for_playback() {
    static GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    fn generation() -> u64 {
        GENERATION.load(Ordering::SeqCst)
    }
    let lock = tokio::sync::Mutex::new(());
    let result = bounded(run_speak_with_interrupt(
        None,
        true,
        &lock,
        generation,
        || false,
        |_, _| async {
            GENERATION.fetch_add(1, Ordering::SeqCst);
            Ok(())
        },
        never_finishes,
    ))
    .await;
    assert_eq!(result, Ok(SpeakOutcome::Cancelled));
}

#[tokio::test]
async fn global_abort_releases_request_queued_before_synthesis() {
    static GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    fn generation() -> u64 {
        GENERATION.load(Ordering::SeqCst)
    }
    let lock = tokio::sync::Mutex::new(());
    let _held = lock.lock().await;
    let spoken = AtomicBool::new(false);
    let (result, ()) = tokio::join!(
        bounded(run_speak_with_interrupt(
            None,
            true,
            &lock,
            generation,
            || false,
            |_, _| {
                spoken.store(true, Ordering::SeqCst);
                async { Ok(()) }
            },
            never_finishes,
        )),
        async {
            tokio::time::sleep(Duration::from_millis(15)).await;
            GENERATION.fetch_add(1, Ordering::SeqCst);
        },
    );
    assert_eq!(result, Ok(SpeakOutcome::Cancelled));
    assert!(!spoken.load(Ordering::SeqCst));
}

#[tokio::test]
async fn own_interrupt_spares_request_but_racing_global_stop_cancels() {
    static GEN_OWN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    fn gen_own() -> u64 {
        GEN_OWN.load(Ordering::SeqCst)
    }
    let lock = tokio::sync::Mutex::new(());
    let own = bounded(run_speak_with_interrupt(
        None,
        true,
        &lock,
        gen_own,
        || {
            GEN_OWN.fetch_add(1, Ordering::SeqCst);
            true
        },
        |_, captured| {
            assert_eq!(captured, GEN_OWN.load(Ordering::SeqCst));
            async { Ok(()) }
        },
        |_| async { true },
    ))
    .await;
    assert_eq!(own, Ok(SpeakOutcome::Spoken));

    static GEN_RACE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    fn gen_race() -> u64 {
        GEN_RACE.load(Ordering::SeqCst)
    }
    let spoken = AtomicBool::new(false);
    let raced = bounded(run_speak_with_interrupt(
        None,
        true,
        &lock,
        gen_race,
        || {
            GEN_RACE.fetch_add(2, Ordering::SeqCst);
            true
        },
        |_, _| {
            spoken.store(true, Ordering::SeqCst);
            async { Ok(()) }
        },
        never_finishes,
    ))
    .await;
    assert_eq!(raced, Ok(SpeakOutcome::Cancelled));
    assert!(!spoken.load(Ordering::SeqCst));
}

#[tokio::test]
async fn stop_while_queued_behind_another_wait_never_speaks() {
    let id = unique_id("queued");
    let lock = std::sync::Arc::new(tokio::sync::Mutex::new(()));
    let held = lock.clone().lock_owned().await;
    let spoken = std::sync::Arc::new(AtomicUsize::new(0));
    let task = {
        let (id, lock, spoken) = (id.clone(), lock.clone(), spoken.clone());
        tokio::spawn(async move {
            run_speak(
                Some(&id),
                true,
                &lock,
                |_| {
                    spoken.fetch_add(1, Ordering::SeqCst);
                    async { Ok(()) }
                },
                never_finishes,
            )
            .await
        })
    };
    tokio::time::sleep(Duration::from_millis(15)).await;
    assert!(!task.is_finished());
    assert!(matches!(
        speak_requests::cancel(&id, || panic!("nothing of this request plays")),
        speak_requests::StopOutcome::Cancelled { .. }
    ));
    let outcome = bounded(task).await.expect("join");
    drop(held);
    assert_eq!(outcome, Ok(SpeakOutcome::Cancelled));
    assert_eq!(spoken.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn stop_during_synthesis_settles_cancelled_without_waiting() {
    let id = unique_id("synth");
    let lock = tokio::sync::Mutex::new(());
    let (started_tx, started_rx) = oneshot::channel::<()>();
    let (release_tx, release_rx) = oneshot::channel::<()>();
    let canceller = {
        let id = id.clone();
        tokio::spawn(async move {
            started_rx.await.expect("speak started");
            let outcome = speak_requests::cancel(&id, || {});
            release_tx.send(()).expect("release synthesis");
            outcome
        })
    };
    let outcome = bounded(run_speak(
        Some(&id),
        true,
        &lock,
        |seq| async move {
            assert_ne!(seq, NO_REQUEST);
            started_tx.send(()).expect("signal start");
            release_rx.await.expect("released");
            assert!(crate::AbortScope::begin_for_request(seq).aborted());
            Ok(())
        },
        never_finishes,
    ))
    .await;
    assert!(matches!(
        canceller.await.expect("join"),
        speak_requests::StopOutcome::Cancelled { .. }
    ));
    assert_eq!(outcome, Ok(SpeakOutcome::Cancelled));
}

#[tokio::test]
async fn cancel_that_stopped_playback_absorbs_its_own_finish() {
    let id = unique_id("absorb");
    let lock = tokio::sync::Mutex::new(());
    let (waiting_tx, waiting_rx) = oneshot::channel::<()>();
    let (finish_tx, finish_rx) = oneshot::channel::<()>();
    let finish_tx = std::sync::Mutex::new(Some(finish_tx));
    let waiting_tx = std::sync::Mutex::new(Some(waiting_tx));
    let finish_seen = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let canceller = {
        let id = id.clone();
        tokio::spawn(async move {
            waiting_rx.await.expect("entered playback wait");
            speak_requests::cancel(&id, || {
                let tx = finish_tx.lock().unwrap().take().expect("one stop");
                std::thread::spawn(move || {
                    // Exceed CANCEL_POLL (25 ms) so the wait sees cancellation before finish arrives.
                    std::thread::sleep(Duration::from_millis(120));
                    let _ = tx.send(());
                });
            })
        })
    };
    let seen = finish_seen.clone();
    let outcome = bounded(run_speak(
        Some(&id),
        true,
        &lock,
        |seq| async move {
            let reading = 9001;
            speak_requests::attach_reading(seq, reading);
            speak_requests::claim_audible(reading);
            Ok(())
        },
        move |_| {
            let waiting_tx = waiting_tx.lock().unwrap().take().expect("one wait");
            async move {
                let _ = waiting_tx.send(());
                let finished = finish_rx.await.is_ok();
                seen.store(finished, Ordering::SeqCst);
                finished
            }
        },
    ))
    .await;
    assert_eq!(outcome, Ok(SpeakOutcome::Cancelled));
    assert!(matches!(
        canceller.await.expect("join"),
        speak_requests::StopOutcome::Cancelled {
            stopped_playback: true,
            ..
        }
    ));
    assert!(finish_seen.load(Ordering::SeqCst));
}

#[tokio::test]
async fn cancelled_synthesis_error_is_reported_as_cancelled() {
    let id = unique_id("synth-err");
    let lock = tokio::sync::Mutex::new(());
    let outcome = bounded(run_speak(
        Some(&id),
        true,
        &lock,
        |_| {
            let id = id.clone();
            async move {
                speak_requests::cancel(&id, || {});
                Err("Reading cancelled".to_string())
            }
        },
        never_finishes,
    ))
    .await;
    assert_eq!(outcome, Ok(SpeakOutcome::Cancelled));
}

#[tokio::test]
async fn stop_during_playback_wait_releases_the_waiter() {
    let id = unique_id("playing");
    let lock = tokio::sync::Mutex::new(());
    let canceller = {
        let id = id.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(15)).await;
            speak_requests::cancel(&id, || {})
        })
    };
    let outcome = bounded(run_speak(
        Some(&id),
        true,
        &lock,
        |_| async { Ok(()) },
        never_finishes,
    ))
    .await;
    assert_eq!(outcome, Ok(SpeakOutcome::Cancelled));
    assert!(matches!(
        canceller.await.expect("join"),
        speak_requests::StopOutcome::Cancelled { .. }
    ));
}

#[tokio::test]
async fn a_foreign_finish_does_not_satisfy_the_requests_wait() {
    let _guard = crate::playback_signal::playback_wait_test_lock();
    let id = unique_id("foreign-finish");
    let lock = tokio::sync::Mutex::new(());
    let foreign_fired = std::sync::Arc::new(AtomicBool::new(false));
    {
        let foreign_fired = foreign_fired.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(15)).await;
            foreign_fired.store(true, Ordering::SeqCst);
            crate::playback_signal::signal_finished_for(None);
        });
    }
    {
        let id = id.clone();
        tokio::spawn(async move {
            let reading = loop {
                if let Some(reading) = speak_requests::reading_for_id(&id) {
                    break reading;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            };
            tokio::time::sleep(Duration::from_millis(40)).await;
            crate::playback_signal::signal_finished_for(Some(reading));
        });
    }
    let started = std::time::Instant::now();
    let wait_id = id.clone();
    let outcome = bounded(run_speak(
        Some(&id),
        true,
        &lock,
        |seq| async move {
            crate::AbortScope::begin_reading_for_request(seq);
            tokio::time::sleep(Duration::from_millis(50)).await;
            Ok(())
        },
        move |_| {
            let waiter = crate::playback_signal::PlaybackWait::new(Some(&wait_id));
            async move {
                waiter
                    .wait(Duration::from_secs(SPEAK_WAIT_TIMEOUT_SECS))
                    .await
            }
        },
    ))
    .await;
    assert_eq!(outcome, Ok(SpeakOutcome::Spoken));
    assert!(foreign_fired.load(Ordering::SeqCst));
    assert!(started.elapsed() >= Duration::from_millis(30));
}

#[tokio::test]
async fn late_stop_spares_the_next_request() {
    let first = unique_id("first");
    let second = unique_id("second");
    let lock = tokio::sync::Mutex::new(());
    let outcome = bounded(run_speak(
        Some(&first),
        true,
        &lock,
        |_| async { Ok(()) },
        |_| async { true },
    ))
    .await;
    assert_eq!(outcome, Ok(SpeakOutcome::Spoken));
    assert_eq!(
        speak_requests::cancel(&first, || panic!("a finished request owns nothing")),
        speak_requests::StopOutcome::AlreadyFinished
    );
    let spoken = AtomicUsize::new(0);
    let outcome = bounded(run_speak(
        Some(&second),
        true,
        &lock,
        |seq| {
            spoken.fetch_add(1, Ordering::SeqCst);
            async move {
                assert!(!crate::AbortScope::begin_for_request(seq).aborted());
                Ok(())
            }
        },
        |_| async { true },
    ))
    .await;
    assert_eq!(outcome, Ok(SpeakOutcome::Spoken));
    assert_eq!(spoken.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn reused_request_id_is_rejected() {
    let id = unique_id("dup");
    let lock = tokio::sync::Mutex::new(());
    let first = bounded(run_speak(
        Some(&id),
        true,
        &lock,
        |_| async { Ok(()) },
        |_| async { true },
    ))
    .await;
    assert_eq!(first, Ok(SpeakOutcome::Spoken));
    let spoken = AtomicUsize::new(0);
    let second = bounded(run_speak(
        Some(&id),
        true,
        &lock,
        |_| {
            spoken.fetch_add(1, Ordering::SeqCst);
            async { Ok(()) }
        },
        |_| async { true },
    ))
    .await;
    assert!(matches!(second, Err((409, _))), "{:?}", second);
    assert_eq!(spoken.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn unscoped_speak_keeps_the_legacy_lifecycle() {
    let lock = tokio::sync::Mutex::new(());
    let waited = std::sync::Arc::new(AtomicUsize::new(0));
    let waited_in = waited.clone();
    let outcome = bounded(run_speak(
        None,
        true,
        &lock,
        |seq| async move {
            assert_eq!(seq, NO_REQUEST);
            Ok(())
        },
        move |_| {
            waited_in.fetch_add(1, Ordering::SeqCst);
            async { true }
        },
    ))
    .await;
    assert_eq!(outcome, Ok(SpeakOutcome::Spoken));
    assert_eq!(waited.load(Ordering::SeqCst), 1);
    assert!(matches!(
        bounded(run_speak(
            None,
            true,
            &lock,
            |_| async { Err("boom".to_string()) },
            never_finishes
        ))
        .await,
        Err((500, _))
    ));
}

#[tokio::test]
async fn non_wait_request_answers_audible_and_stays_stoppable_until_end() {
    let playing = unique_id("nowait-playing");
    let lock = tokio::sync::Mutex::new(());
    let outcome = bounded(run_speak(
        Some(&playing),
        false,
        &lock,
        |_| async { Ok(()) },
        never_finishes,
    ))
    .await;
    assert_eq!(outcome, Ok(SpeakOutcome::Spoken));
    assert!(matches!(
        speak_requests::cancel(&playing, || {}),
        speak_requests::StopOutcome::Cancelled { .. }
    ));

    let ended = unique_id("nowait-ended");
    let (finish_tx, finish_rx) = oneshot::channel::<()>();
    let outcome = bounded(run_speak(
        Some(&ended),
        false,
        &lock,
        |_| async { Ok(()) },
        move |_| async move { finish_rx.await.is_ok() },
    ))
    .await;
    assert_eq!(outcome, Ok(SpeakOutcome::Spoken));
    finish_tx.send(()).expect("finish playback");
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while speak_requests::is_live(&ended) {
        assert!(std::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert_eq!(
        speak_requests::cancel(&ended, || panic!("an ended request owns nothing")),
        speak_requests::StopOutcome::AlreadyFinished
    );

    let audible = unique_id("nowait-audible");
    let (rest_tx, rest_rx) = oneshot::channel::<()>();
    let outcome = bounded(run_speak_inner(
        Some(&audible),
        false,
        &lock,
        abort_generation,
        |_| true,
        || false,
        move |_, _| async move {
            let _ = rest_rx.await;
            Ok(())
        },
        never_finishes,
    ))
    .await;
    assert_eq!(outcome, Ok(SpeakOutcome::Spoken));
    assert!(speak_requests::is_live(&audible));
    let _ = rest_tx.send(());
    assert!(matches!(
        speak_requests::cancel(&audible, || {}),
        speak_requests::StopOutcome::Cancelled { .. }
    ));
}
