// Unit tests for the offline outbox. Run with: npm test
// localStorage doesn't exist in node — stub it before importing the module.
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const {
  mergeIntoOutbox, withoutFromOutbox,
  loadOutbox, queueWorkout, removeFromOutbox, flushOutbox,
} = await import("./outbox.js");

const s = (id, extra = {}) => ({ id, exercises: [], ...extra });

describe("mergeIntoOutbox / withoutFromOutbox (pure)", () => {
  test("appends new sessions, replaces same-id ones", () => {
    let box = mergeIntoOutbox([], s("a"));
    box = mergeIntoOutbox(box, s("b"));
    assert.equal(box.length, 2);
    box = mergeIntoOutbox(box, s("a", { note: "edited" })); // re-finish after edit
    assert.equal(box.length, 2);
    assert.equal(box.find((x) => x.id === "a").note, "edited");
  });
  test("ignores junk", () => {
    assert.deepEqual(mergeIntoOutbox(null, s("a")).length, 1);
    assert.deepEqual(mergeIntoOutbox([], null), []);
    assert.deepEqual(mergeIntoOutbox([], { noId: true }), []);
  });
  test("withoutFromOutbox drops by id", () => {
    const box = [s("a"), s("b")];
    assert.deepEqual(withoutFromOutbox(box, "a").map((x) => x.id), ["b"]);
    assert.equal(withoutFromOutbox(box, "zz").length, 2);
  });
});

describe("storage-backed queue", () => {
  beforeEach(() => store.clear());

  test("queue -> load -> remove round-trip, per user", () => {
    assert.equal(queueWorkout(1, s("a")), 1);
    assert.equal(queueWorkout(1, s("b")), 2);
    assert.equal(queueWorkout(2, s("z")), 1);        // other user, own box
    assert.deepEqual(loadOutbox(1).map((x) => x.id), ["a", "b"]);
    assert.equal(removeFromOutbox(1, "a"), 1);
    assert.deepEqual(loadOutbox(1).map((x) => x.id), ["b"]);
  });

  test("empty box clears the storage key entirely", () => {
    queueWorkout(1, s("a"));
    removeFromOutbox(1, "a");
    assert.equal(store.size, 0);
  });

  test("corrupt storage degrades to an empty box", () => {
    store.set("wt:u:1:outbox", "{not json");
    assert.deepEqual(loadOutbox(1), []);
  });

  test("flushOutbox sends everything, keeps failures", async () => {
    queueWorkout(1, s("ok1"));
    queueWorkout(1, s("fail"));
    queueWorkout(1, s("ok2"));
    const sent = [];
    const r = await flushOutbox(1, async (sess) => {
      if (sess.id === "fail") throw new Error("offline");
      sent.push(sess.id);
    });
    assert.deepEqual(r, { sent: 2, pending: 1 });
    assert.deepEqual(sent, ["ok1", "ok2"]);
    assert.deepEqual(loadOutbox(1).map((x) => x.id), ["fail"]);

    // second flush when the network is back
    const r2 = await flushOutbox(1, async () => {});
    assert.deepEqual(r2, { sent: 1, pending: 0 });
    assert.deepEqual(loadOutbox(1), []);
  });

  test("flushOutbox with an empty box is a no-op", async () => {
    const r = await flushOutbox(1, async () => { throw new Error("should not be called"); });
    assert.deepEqual(r, { sent: 0, pending: 0 });
  });
});
