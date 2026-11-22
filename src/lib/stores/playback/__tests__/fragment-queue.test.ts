import { describe, expect, it } from "vite-plus/test";
import { FragmentQueue, type QueuedFragment } from "../fragment-queue";

function fragment(index: number): QueuedFragment {
  return { audioBase64: `audio-${index}`, index, total: 5, text: `Part ${index}`, readingId: null };
}

function createQueue() {
  const played: number[] = [];
  let completed = false;
  const queue = new FragmentQueue({
    onFragmentPlay: async (fragment) => {
      played.push(fragment.index);
    },
    onQueueComplete: () => {
      completed = true;
    }
  });
  return { queue, played, isCompleted: () => completed };
}

describe("FragmentQueue", () => {
  it("does not complete a reading just because another reading is queued", async () => {
    const completed: number[] = [];
    const queue = new FragmentQueue({
      onFragmentPlay: async () => {},
      onReadingComplete: (id) => completed.push(id),
      onQueueComplete: () => {}
    });
    queue.enqueue({ ...fragment(0), readingId: 41 });
    queue.enqueue({ ...fragment(0), readingId: 42 });
    await queue.startProcessing();
    queue.handleFragmentEnded();
    expect(completed).toEqual([]);
  });

  it("retains played fragments for rewind, re-queues ahead of current, and resumes interrupted fragment", async () => {
    const { queue, played } = createQueue();
    for (const index of [0, 1, 2]) queue.enqueue(fragment(index));
    await queue.startProcessing(); // plays 0
    expect(played).toEqual([0]);
    queue.handleFragmentEnded(); // 0 done, plays 1
    expect(played).toEqual([0, 1]);
    expect(queue.getCurrentIndex()).toBe(1);

    const previous = queue.previousFragment(); // re-queues 0 ahead of 1; store plays it
    expect(previous?.index).toBe(0);
    expect(queue.getQueue().map((f) => f.index)).toEqual([0, 1, 2]);

    queue.handleFragmentEnded(); // rewind target 0 done, plays interrupted 1 again
    expect(played).toEqual([0, 1, 1]);
    queue.handleFragmentEnded(); // 1 done, plays 2
    expect(played).toEqual([0, 1, 1, 2]);
    expect(queue.getCurrentIndex()).toBe(2);
  });

  it("returns null when rewind history is empty or cleared", async () => {
    const { queue } = createQueue();
    queue.enqueue(fragment(0));
    queue.enqueue(fragment(1));
    await queue.startProcessing();
    expect(queue.previousFragment()).toBeNull();
    // Queue is untouched when nothing played earlier is retained.
    expect(queue.getQueue().map((f) => f.index)).toEqual([0, 1]);

    queue.handleFragmentEnded();
    queue.clear();
    expect(queue.previousFragment()).toBeNull();
    expect(queue.getQueueLength()).toBe(0);
  });

  it("caps the rewind history at three fragments", async () => {
    const { queue } = createQueue();
    for (let index = 0; index < 5; index++) queue.enqueue(fragment(index));
    await queue.startProcessing();
    for (let i = 0; i < 4; i++) queue.handleFragmentEnded();
    expect(queue.getCurrentIndex()).toBe(4);
    // Fragments 0..3 played; only 1..3 fit the cap, so 0 was evicted.
    expect([
      queue.previousFragment()?.index ?? null,
      queue.previousFragment()?.index ?? null,
      queue.previousFragment()?.index ?? null,
      queue.previousFragment()?.index ?? null
    ]).toEqual([3, 2, 1, null]);
  });

  it("waits for delayed next fragment without prematurely completing", async () => {
    const { queue, played, isCompleted } = createQueue();
    queue.enqueue(fragment(0));
    await queue.startProcessing();
    expect(played).toEqual([0]);
    expect(queue.isWaitingForNext()).toBe(false);

    queue.handleFragmentEnded();
    expect(queue.isWaitingForNext()).toBe(true);
    expect(isCompleted()).toBe(false);

    queue.enqueue(fragment(1));
    expect(queue.isWaitingForNext()).toBe(false);
    expect(played).toEqual([0, 1]);
    expect(queue.getCurrentIndex()).toBe(1);
  });

  it("handles terminal completion when waiting for delayed fragment after backend failure", async () => {
    const { queue, isCompleted } = createQueue();
    queue.enqueue(fragment(0));
    await queue.startProcessing();
    queue.handleFragmentEnded();

    expect(queue.isWaitingForNext()).toBe(true);
    expect(isCompleted()).toBe(false);

    queue.markTerminal();
    expect(queue.isWaitingForNext()).toBe(false);
    expect(isCompleted()).toBe(true);
  });

  it("completes a queue waiting for a fragment once its own reading is fully synthesized", async () => {
    const { queue, isCompleted } = createQueue();
    queue.enqueue({ ...fragment(0), readingId: 41 });
    await queue.startProcessing();
    queue.handleFragmentEnded();
    expect(queue.isWaitingForNext()).toBe(true);

    queue.markReadingComplete(42);
    expect(isCompleted()).toBe(false);

    queue.markReadingComplete(41);
    expect(queue.isWaitingForNext()).toBe(false);
    expect(isCompleted()).toBe(true);
  });

  it("supports full replay of all received fragments", async () => {
    const { queue, played, isCompleted } = createQueue();
    const total = 2;
    queue.enqueue({ audioBase64: "a0", index: 0, total, text: "Part 0", readingId: null });
    queue.enqueue({ audioBase64: "a1", index: 1, total, text: "Part 1", readingId: null });
    await queue.startProcessing();
    queue.handleFragmentEnded();
    queue.handleFragmentEnded();

    expect(played).toEqual([0, 1]);
    expect(isCompleted()).toBe(true);
    expect(queue.canReplay()).toBe(true);

    const replayed = await queue.replay();
    expect(replayed).toBe(true);
    expect(played).toEqual([0, 1, 0]);
  });
});
