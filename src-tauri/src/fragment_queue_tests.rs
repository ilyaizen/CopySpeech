use super::*;

fn create_test_fragment(text: &str, index: usize, total: usize) -> TextFragment {
    TextFragment::new(text.to_string(), index, total)
}

#[test]
fn queue_lifecycle_add_get_audio_and_clear_resets_stop_flag() {
    let queue = FragmentQueue::new();
    assert!(queue.is_empty());
    assert_eq!(queue.len(), 0);
    assert_eq!(queue.status(), QueueStatus::Idle);

    queue.add_fragment(create_test_fragment("First", 0, 2));
    assert!(!queue.is_empty());
    assert_eq!(queue.len(), 1);
    assert!(!queue.has_audio(0));

    let fake_audio = vec![1, 2, 3, 4, 5];
    queue.set_audio(0, fake_audio.clone());
    assert!(queue.has_audio(0));
    assert_eq!(queue.get_audio(0), Some(fake_audio));

    queue.add_fragments(vec![create_test_fragment("Second", 1, 2)]);
    assert_eq!(queue.len(), 2);
    assert_eq!(queue.get_fragment(0).unwrap().text, "First");
    assert_eq!(queue.get_fragment(1).unwrap().text, "Second");

    queue.stop();
    assert!(queue.should_stop());
    assert_eq!(queue.status(), QueueStatus::Stopped);

    queue.clear();
    assert!(queue.is_empty());
    assert_eq!(queue.len(), 0);
    assert!(!queue.should_stop());
    assert_eq!(queue.status(), QueueStatus::Idle);
}

#[test]
fn queue_navigation_next_previous_and_skip_bounds() {
    let queue = FragmentQueue::new();
    queue.add_fragments(vec![
        create_test_fragment("First", 0, 3),
        create_test_fragment("Second", 1, 3),
        create_test_fragment("Third", 2, 3),
    ]);

    assert_eq!(queue.next(), Some(0));
    assert!(queue.skip_to(1).is_ok());
    assert_eq!(queue.current_index(), Some(1));
    assert_eq!(queue.next(), Some(2));

    queue.skip_to(2).unwrap();
    assert_eq!(queue.next(), None);
    assert_eq!(queue.previous(), Some(1));

    queue.skip_to(0).unwrap();
    assert_eq!(queue.previous(), None);
    assert!(queue.skip_to(10).is_err());
}

#[test]
fn queue_status_transitions_and_stop_flag() {
    let queue = FragmentQueue::new();
    queue.add_fragment(create_test_fragment("Test", 0, 1));
    assert_eq!(queue.status(), QueueStatus::Idle);
    assert!(!queue.should_stop());

    queue.start();
    assert_eq!(queue.status(), QueueStatus::Playing);

    queue.pause();
    assert_eq!(queue.status(), QueueStatus::Paused);

    queue.resume();
    assert_eq!(queue.status(), QueueStatus::Playing);

    queue.stop();
    assert_eq!(queue.status(), QueueStatus::Stopped);
    assert!(queue.should_stop());

    queue.clear_stop_flag();
    assert!(!queue.should_stop());
}
