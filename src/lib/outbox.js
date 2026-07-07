// ---------------------------------------------------------------------------
//  OFFLINE OUTBOX
//  Finished workouts that couldn't reach the server (gym dead-zones, flaky
//  connections) are queued here per user and re-sent when we're back online.
//  Server saves are idempotent upserts keyed by the session's client id, so
//  flushing the same session twice is harmless.
//  Pure queue logic is separated from storage so it can be unit-tested.
// ---------------------------------------------------------------------------

// Replace an existing entry with the same id, else append. Pure.
export function mergeIntoOutbox(box, session) {
  const list = Array.isArray(box) ? box : [];
  if (!session || !session.id) return list;
  const i = list.findIndex((s) => s && s.id === session.id);
  if (i === -1) return [...list, session];
  const copy = [...list];
  copy[i] = session;
  return copy;
}

// Drop an entry by id. Pure.
export function withoutFromOutbox(box, id) {
  return (Array.isArray(box) ? box : []).filter((s) => s && s.id !== id);
}

/* ------------------------- localStorage wrappers ------------------------- */

const outboxKey = (userId) => `wt:u:${userId}:outbox`;

export function loadOutbox(userId) {
  try {
    const raw = localStorage.getItem(outboxKey(userId));
    const box = raw ? JSON.parse(raw) : [];
    return Array.isArray(box) ? box : [];
  } catch {
    return [];
  }
}

export function saveOutbox(userId, box) {
  try {
    if (!box || box.length === 0) localStorage.removeItem(outboxKey(userId));
    else localStorage.setItem(outboxKey(userId), JSON.stringify(box));
  } catch {}
}

// Queue (or re-queue) a session; returns the new pending count.
export function queueWorkout(userId, session) {
  const box = mergeIntoOutbox(loadOutbox(userId), session);
  saveOutbox(userId, box);
  return box.length;
}

// Remove a session (e.g. the user deleted it before it ever synced);
// returns the new pending count.
export function removeFromOutbox(userId, id) {
  const box = withoutFromOutbox(loadOutbox(userId), id);
  saveOutbox(userId, box);
  return box.length;
}

// Try to upload everything queued for this user. `send` is the async uploader
// (one session -> resolves on success). Keeps whatever still fails; returns
// { sent, pending }.
export async function flushOutbox(userId, send) {
  const box = loadOutbox(userId);
  if (!box.length) return { sent: 0, pending: 0 };
  const remaining = [];
  for (const s of box) {
    try {
      await send(s);
    } catch {
      remaining.push(s);
    }
  }
  saveOutbox(userId, remaining);
  return { sent: box.length - remaining.length, pending: remaining.length };
}
