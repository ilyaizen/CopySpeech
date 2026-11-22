use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Barrier};

fn t0() -> Instant {
    Instant::now()
}

#[test]
fn register_preempt_duplicate_and_no_request_rules() {
    let mut reg = Registry::default();
    let now = t0();
    assert_eq!(reg.cancel("r1", now, |_| false), StopOutcome::Preempted);
    assert_eq!(reg.register("r1", now), Registration::Cancelled);
    assert_eq!(reg.register("r1", now), Registration::Cancelled);

    assert!(matches!(reg.register("dup", now), Registration::Proceed(_)));
    assert_eq!(reg.register("dup", now), Registration::Duplicate);

    reg.cancel("x", now, |_| false);
    assert!(!reg.is_cancelled(NO_REQUEST));
}

#[test]
fn live_cancel_finish_and_playback_stop_semantics() {
    let mut reg = Registry::default();
    let now = t0();
    let Registration::Proceed(a) = reg.register("a", now) else {
        panic!("a must register");
    };
    let Registration::Proceed(b) = reg.register("b", now) else {
        panic!("b must register");
    };
    reg.attach_reading(a, 10);
    reg.attach_reading(b, 20);
    assert_ne!(a, b);
    assert_eq!(
        reg.cancel("a", now, |r| r == Some(10)),
        StopOutcome::Cancelled {
            seq: a,
            stopped_playback: true
        }
    );
    assert!(reg.is_cancelled(a) && reg.stopped_playback(a));
    assert!(!reg.is_cancelled(b));
    assert_eq!(
        reg.cancel("a", now, |_| false),
        StopOutcome::AlreadyCancelled
    );
    reg.finish(a, now);
    assert!(reg.is_cancelled(a));
    assert_eq!(
        reg.cancel("b", now, |r| r == Some(10)),
        StopOutcome::Cancelled {
            seq: b,
            stopped_playback: false
        }
    );
    assert!(!reg.stopped_playback(b));

    let Registration::Proceed(done) = reg.register("done", now) else {
        panic!("done must register");
    };
    reg.finish(done, now);
    assert_eq!(
        reg.cancel("done", now, |_| false),
        StopOutcome::AlreadyFinished
    );
    assert!(!reg.is_cancelled(done));
}

#[test]
fn settled_ids_expire_and_stay_bounded() {
    let mut reg = Registry::default();
    let start = t0();
    reg.cancel("tomb", start, |_| false);
    let Registration::Proceed(live) = reg.register("live", start) else {
        panic!("live must register");
    };
    let later = start + RETAIN_FOR + Duration::from_secs(1);
    assert!(matches!(
        reg.register("tomb", later),
        Registration::Proceed(_)
    ));
    assert_eq!(
        reg.cancel("live", later, |_| false),
        StopOutcome::Cancelled {
            seq: live,
            stopped_playback: false
        }
    );

    let mut bounded = Registry::default();
    for i in 0..(MAX_SETTLED + 50) {
        bounded.cancel(
            &format!("t{i}"),
            start + Duration::from_millis(i as u64),
            |_| false,
        );
    }
    bounded.register("trigger-prune", start + Duration::from_secs(10));
    assert!(bounded.by_id.len() <= MAX_SETTLED + 1);
    assert!(bounded.cancelled.len() <= MAX_SETTLED);
}

#[test]
fn validate_id_accepts_safe_ids_and_rejects_others() {
    assert!(validate_id("hermes-0123abcd").is_ok());
    assert!(validate_id("a.b_c:d-E9").is_ok());
    assert!(validate_id("").is_err());
    assert!(validate_id(&"x".repeat(MAX_ID_LEN + 1)).is_err());
    assert!(validate_id("has space").is_err());
    assert!(validate_id("quote\"").is_err());
}

#[test]
fn owner_claim_and_stop_reach_only_active_owner() {
    let owner = PlaybackOwner::new();
    let stops = AtomicUsize::new(0);
    assert!(owner.claim(7, || false, || {}));
    assert!(!owner.stop_if_owner(8, || {
        stops.fetch_add(1, Ordering::SeqCst);
    }));
    assert!(owner.stop_if_owner(7, || {
        stops.fetch_add(1, Ordering::SeqCst);
    }));
    assert_eq!(stops.load(Ordering::SeqCst), 1);

    assert!(owner.claim(3, || false, || {}));
    let mut emitted = false;
    assert!(!owner.claim(4, || true, || emitted = true));
    assert!(!emitted);
    owner.claim(NO_REQUEST, || false, || {});
    let mut stopped = false;
    assert!(!owner.stop_if_owner(3, || stopped = true));
    assert!(!owner.stop_if_owner(NO_REQUEST, || stopped = true));
    assert!(!stopped);
}

#[test]
fn audible_claim_and_release_follow_the_webview() {
    let owner = PlaybackOwner::new();
    assert_eq!(owner.with_current(|current| current), NO_REQUEST);

    owner.claim_audible(0);
    assert_eq!(owner.with_current(|current| current), NO_REQUEST);

    owner.claim_audible(11);
    assert_eq!(owner.with_current(|current| current), 11);

    owner.release_audible(12);
    assert_eq!(owner.with_current(|current| current), 11);

    owner.release_audible(11);
    assert_eq!(owner.with_current(|current| current), NO_REQUEST);
    owner.release_audible(11);
    assert_eq!(owner.with_current(|current| current), NO_REQUEST);
}

fn cancel_on(
    owner: &PlaybackOwner,
    reg: &Mutex<Registry>,
    id: &str,
    stop: impl FnOnce(),
) -> StopOutcome {
    owner.with_current(|current| {
        let outcome = reg
            .lock()
            .unwrap()
            .cancel(id, Instant::now(), |reading| reading == Some(current));
        if let StopOutcome::Cancelled {
            stopped_playback: true,
            ..
        } = outcome
        {
            stop();
        }
        outcome
    })
}

#[test]
fn scoped_cancel_targets_only_reading_owning_speakers() {
    let owner = PlaybackOwner::new();
    let reg = Mutex::new(Registry::default());
    let now = Instant::now();
    let Registration::Proceed(waiting) = reg.lock().unwrap().register("cancel-waiting", now) else {
        panic!("waiting must register");
    };
    let Registration::Proceed(audible) = reg.lock().unwrap().register("cancel-audible", now) else {
        panic!("audible must register");
    };
    let Registration::Proceed(unstarted) = reg.lock().unwrap().register("cancel-none", now) else {
        panic!("unstarted must register");
    };
    reg.lock().unwrap().attach_reading(waiting, 21);
    reg.lock().unwrap().attach_reading(audible, 22);
    owner.claim_audible(22);

    assert_eq!(
        cancel_on(&owner, &reg, "cancel-none", || panic!(
            "unstarted owns nothing"
        )),
        StopOutcome::Cancelled {
            seq: unstarted,
            stopped_playback: false
        }
    );
    assert_eq!(
        cancel_on(&owner, &reg, "cancel-waiting", || panic!(
            "waiting owns nothing"
        )),
        StopOutcome::Cancelled {
            seq: waiting,
            stopped_playback: false
        }
    );
    let mut stopped = false;
    assert_eq!(
        cancel_on(&owner, &reg, "cancel-audible", || stopped = true),
        StopOutcome::Cancelled {
            seq: audible,
            stopped_playback: true
        }
    );
    assert!(stopped);
}

#[test]
fn concurrent_emit_never_lands_after_the_scoped_stop() {
    for _ in 0..40 {
        let owner = Arc::new(PlaybackOwner::new());
        let reg = Arc::new(Mutex::new(Registry::default()));
        let Registration::Proceed(seq) = reg.lock().unwrap().register("r", Instant::now()) else {
            panic!("r must register");
        };
        let reading = 77;
        reg.lock().unwrap().attach_reading(seq, reading);
        let events = Arc::new(Mutex::new(Vec::<&'static str>::new()));
        let start = Arc::new(Barrier::new(2));

        let emitter = {
            let (owner, reg, events, start) =
                (owner.clone(), reg.clone(), events.clone(), start.clone());
            std::thread::spawn(move || {
                start.wait();
                owner.claim(
                    reading,
                    || reg.lock().unwrap().is_cancelled(seq),
                    || events.lock().unwrap().push("audio"),
                );
            })
        };
        let stopper = {
            let (owner, reg, events, start) =
                (owner.clone(), reg.clone(), events.clone(), start.clone());
            std::thread::spawn(move || {
                start.wait();
                owner.with_current(|current| {
                    let outcome = reg
                        .lock()
                        .unwrap()
                        .cancel("r", Instant::now(), |r| r == Some(current));
                    if let StopOutcome::Cancelled {
                        stopped_playback: true,
                        ..
                    } = outcome
                    {
                        events.lock().unwrap().push("stop");
                    }
                });
            })
        };
        emitter.join().unwrap();
        stopper.join().unwrap();
        let events = events.lock().unwrap().clone();
        assert!(
            events.is_empty() || events == ["audio", "stop"],
            "audio emitted after its stop: {events:?}"
        );
    }
}

#[tokio::test]
async fn until_cancelled_wakes_on_cancel_and_passes_completion() {
    let Registration::Proceed(ok_seq) = register("until-cancelled-ok") else {
        panic!("must register");
    };
    assert_eq!(until_cancelled(ok_seq, async { 5 }).await, Some(5));

    let id = "until-cancelled-test";
    let Registration::Proceed(seq) = register(id) else {
        panic!("must register");
    };
    let canceller = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(15)).await;
        cancel(id, || {});
    });
    assert_eq!(
        until_cancelled(seq, std::future::pending::<()>()).await,
        None
    );
    canceller.await.unwrap();
}

#[tokio::test]
async fn until_cancelled_or_aborted_handles_immediate_and_live_aborts() {
    assert_eq!(
        until_cancelled_or_aborted(NO_REQUEST, || false, async { 7 }).await,
        Some(7)
    );
    assert_eq!(
        until_cancelled_or_aborted(NO_REQUEST, || true, std::future::pending::<()>()).await,
        None
    );

    let aborted = Arc::new(AtomicBool::new(false));
    let flip = aborted.clone();
    let flipper = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(15)).await;
        flip.store(true, Ordering::Relaxed);
    });
    assert_eq!(
        until_cancelled_or_aborted(
            NO_REQUEST,
            || aborted.load(Ordering::Relaxed),
            std::future::pending::<()>(),
        )
        .await,
        None
    );
    flipper.await.unwrap();
}

#[test]
fn ticket_drop_finishes_the_request() {
    let id = "ticket-drop-test";
    let Registration::Proceed(seq) = register(id) else {
        panic!("must register");
    };
    drop(Ticket::new(seq));
    assert_eq!(
        cancel(id, || panic!("finished request must not stop")),
        StopOutcome::AlreadyFinished
    );
}

fn local_state() -> (PlaybackOwner, Mutex<Registry>) {
    (PlaybackOwner::new(), Mutex::new(Registry::default()))
}

fn register_live(reg: &Mutex<Registry>, id: &str) -> u64 {
    match reg.lock().unwrap().register(id, Instant::now()) {
        Registration::Proceed(seq) => seq,
        _ => panic!("{id} must register"),
    }
}

#[test]
fn live_seq_and_dispatch_refuse_unknown_finished_and_cancelled_requests() {
    let (owner, reg) = local_state();
    let live = register_live(&reg, "seq-live");
    assert_eq!(reg.lock().unwrap().live_seq("seq-live"), Some(live));
    assert_eq!(reg.lock().unwrap().live_seq("seq-unknown"), None);

    let done = register_live(&reg, "seq-done");
    reg.lock().unwrap().finish(done, Instant::now());
    assert_eq!(reg.lock().unwrap().live_seq("seq-done"), None);

    let cancelled = register_live(&reg, "seq-cancelled");
    reg.lock()
        .unwrap()
        .cancel("seq-cancelled", Instant::now(), |_| false);
    assert_eq!(reg.lock().unwrap().live_seq("seq-cancelled"), None);
    let _ = cancelled;

    for id in ["seq-unknown", "seq-done", "seq-cancelled"] {
        assert!(!dispatch_to_owner_with(
            id,
            &owner,
            &reg,
            Duration::from_secs(1),
            Duration::from_millis(5),
            |_| panic!("{id} must not emit"),
        ));
    }
}

#[test]
fn dispatch_runs_for_live_owner_only_and_times_out_for_non_owner() {
    let (owner, reg) = local_state();
    let seq = register_live(&reg, "control-owner");
    reg.lock().unwrap().attach_reading(seq, 41);
    owner.claim_audible(41);

    let mut seen = Vec::new();
    assert!(dispatch_to_owner_with(
        "control-owner",
        &owner,
        &reg,
        Duration::from_millis(200),
        Duration::from_millis(5),
        |s| seen.push(s),
    ));
    assert_eq!(seen, [seq]);

    let queued = register_live(&reg, "control-queued");
    let _ = queued;
    assert!(!dispatch_to_owner_with(
        "control-queued",
        &owner,
        &reg,
        Duration::from_millis(20),
        Duration::from_millis(5),
        |_| panic!("queued reading owns nothing"),
    ));
}

#[test]
fn dispatch_waits_for_a_starting_reading_to_become_audible() {
    let owner = Arc::new(PlaybackOwner::new());
    let reg = Arc::new(Mutex::new(Registry::default()));
    let seq = register_live(&reg, "control-starting");
    reg.lock().unwrap().attach_reading(seq, 42);
    let claimer = {
        let (owner, reg) = (Arc::clone(&owner), Arc::clone(&reg));
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(15));
            assert_eq!(reg.lock().unwrap().live_seq("control-starting"), Some(seq));
            owner.claim_audible(42);
        })
    };

    let mut seen = Vec::new();
    assert!(dispatch_to_owner_with(
        "control-starting",
        &owner,
        &reg,
        Duration::from_secs(2),
        Duration::from_millis(5),
        |s| seen.push(s),
    ));
    claimer.join().unwrap();
    assert_eq!(seen, [seq]);
}

#[test]
fn dispatch_emits_while_holding_the_owner_lock() {
    use std::sync::mpsc;

    let owner = Arc::new(PlaybackOwner::new());
    let reg = Arc::new(Mutex::new(Registry::default()));
    let seq = register_live(&reg, "control-lock");
    reg.lock().unwrap().attach_reading(seq, 44);
    owner.claim_audible(44);

    let (run_started_tx, run_started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let (claimed_tx, claimed_rx) = mpsc::channel::<()>();
    let dispatcher = {
        let (owner, reg) = (Arc::clone(&owner), Arc::clone(&reg));
        std::thread::spawn(move || {
            dispatch_to_owner_with(
                "control-lock",
                &owner,
                &reg,
                Duration::from_secs(2),
                Duration::from_millis(5),
                |_| {
                    run_started_tx.send(()).expect("signal run");
                    release_rx.recv().expect("released");
                },
            )
        })
    };
    run_started_rx.recv_timeout(Duration::from_secs(1)).unwrap();

    let claimer = {
        let owner = Arc::clone(&owner);
        std::thread::spawn(move || {
            owner.claim(NO_REQUEST, || false, || {});
            let _ = claimed_tx.send(());
        })
    };
    assert!(claimed_rx.recv_timeout(Duration::from_millis(30)).is_err());
    release_tx.send(()).unwrap();
    claimed_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(dispatcher.join().unwrap());
    claimer.join().unwrap();
}
