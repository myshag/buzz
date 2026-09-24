/**
 * Stale-reader recovery (`useStaleReaderRecovery`) through the four real
 * sidebar hooks and their sync managers, with an in-memory relay/Tauri stub.
 *
 * Every test runs on mocked `setTimeout`, so recovery ticks and publish
 * debounces fire only when a test advances the clock.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});
const RELAY = "wss://relay.example";

let act;
let cleanup;
let renderHook;
let relayClient;
let sections;
let sort;
let stars;
let mutes;

before(async () => {
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    window: dom.window,
  });
  ({ act, cleanup, renderHook } = await import("@testing-library/react"));
  ({ relayClient } = await import("@/shared/api/relayClient"));
  sections = {
    ...(await import("./useChannelSections.ts")),
    ...(await import("./channelSectionsStorage.ts")),
    ...(await import("./channelSectionsSync.ts")),
  };
  sort = {
    ...(await import("./useChannelSortPreference.ts")),
    ...(await import("./channelSortPreference.ts")),
    ...(await import("./channelSortSync.ts")),
  };
  stars = {
    ...(await import("./useChannelStars.ts")),
    ...(await import("./channelStarsStorage.ts")),
    ...(await import("./channelStarsSync.ts")),
  };
  mutes = {
    ...(await import("./useChannelMutes.ts")),
    ...(await import("./channelMutesStorage.ts")),
    ...(await import("./channelMutesSync.ts")),
  };
});

after(() => dom.window.close());

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Relay event whose "ciphertext" is the JSON payload (decrypt is identity). */
function relayEvent(pubkey, dTag, createdAt, payload, id) {
  return {
    id: id ?? `eid-${dTag}-${createdAt}`,
    pubkey,
    created_at: createdAt,
    kind: 30078,
    content: JSON.stringify(payload),
    tags: [["d", dTag]],
    sig: "sig",
  };
}

/**
 * Installs the relay/Tauri stub.  `relay.fetch(n)` answers the n-th
 * `fetchEvents` call (return events, a promise, or throw).  Successful
 * publications land in `relay.published`; `relay.encryptGate` holds every
 * publish at encryption while it is an unresolved promise.  Live delivery
 * and reconnects are inert, so no echo ever reaches the hooks.
 */
function setup(t, pubkey, fetch = () => []) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const saved = { ...relayClient };
  const savedTauri = window.__TAURI_INTERNALS__;
  const relay = {
    fetches: 0,
    fetch,
    publish: async () => {},
    reconnect: () => {},
    published: [],
    encryptGate: null,
    payload: (i = -1) => JSON.parse(relay.published.at(i).content),
  };
  relayClient.fetchEvents = async () => relay.fetch(++relay.fetches);
  relayClient.publishEvent = async (event) => {
    await relay.publish(event);
    relay.published.push(event);
  };
  relayClient.subscribeLive = async () => async () => {};
  relayClient.subscribeToReconnects = (cb) => {
    relay.reconnect = cb;
    return () => {};
  };
  window.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args) => {
      if (cmd === "nip44_decrypt_from_self") return args.ciphertext;
      if (cmd === "nip44_encrypt_to_self") {
        await relay.encryptGate;
        return args.plaintext;
      }
      if (cmd === "sign_event")
        return JSON.stringify({
          id: `eid-pub-${relay.published.length}`,
          pubkey,
          content: args.content,
          created_at: args.createdAt,
          kind: args.kind,
          tags: args.tags,
          sig: "s",
        });
      throw new Error(`unmocked: ${cmd}`);
    },
  };
  t.after(() => {
    cleanup();
    Object.assign(relayClient, saved);
    window.__TAURI_INTERNALS__ = savedTauri;
    window.localStorage.clear();
  });
  return relay;
}

/** Holds every publish at `boundary` ("encrypt" or "sign") until `gate`. */
function holdAt(relay, boundary, gate) {
  if (boundary === "encrypt") {
    relay.encryptGate = gate;
    return;
  }
  const invoke = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
    if (cmd === "sign_event") await gate;
    return invoke(cmd, args);
  };
}

/** Records the sync manager a hook constructs, via its `bootstrap` call. */
function captureManager(t, Manager) {
  const orig = Manager.prototype.bootstrap;
  const spy = { current: null };
  Manager.prototype.bootstrap = function (...args) {
    spy.current = this;
    return orig.apply(this, args);
  };
  t.after(() => {
    Manager.prototype.bootstrap = orig;
  });
  return spy;
}

async function flush(turns = 8) {
  await act(async () => {
    for (let i = 0; i < turns; i++) await new Promise((r) => setImmediate(r));
  });
}

/** Completion oracle: flushes until `pred` holds, else fails with `message`. */
async function until(pred, message) {
  for (let i = 0; i < 100; i++) {
    if (pred()) return;
    await flush(1);
  }
  assert.fail(message);
}

async function tick(t, ms) {
  await act(async () => t.mock.timers.tick(ms));
}

const sectionNames = (store) => store.sections.map((s) => s.name);
const sectionsPayload = (name) => ({
  version: 1,
  sections: [{ id: `s-${name}`, name, order: 0 }],
  assignments: {},
});

// ---------------------------------------------------------------------------
// Bootstrap failure → the immediate recovery tick applies the relay head
// ---------------------------------------------------------------------------

const bootstrapLanes = [
  {
    name: "useChannelSections",
    dTag: "channel-sections",
    payload: sectionsPayload("Remote"),
    render: (pk) => sections.useChannelSections(pk, RELAY),
    applied: (r) => sectionNames(r.current).includes("Remote"),
  },
  {
    name: "useChannelSortPreference",
    dTag: "channel-sort",
    payload: { version: 1, groups: { starred: "recent" } },
    render: (pk) => sort.useChannelSortPreference(pk, RELAY),
    applied: (r) => r.current.sortModeFor("starred") === "recent",
  },
  ...[
    [
      () => stars,
      "useChannelStars",
      "channel-stars",
      "starred",
      "starredChannelIds",
    ],
    [
      () => mutes,
      "useChannelMutes",
      "channel-mutes",
      "muted",
      "mutedChannelIds",
    ],
  ].map(([lane, name, dTag, flag, ids]) => ({
    name,
    dTag,
    seed: (pk) =>
      window.localStorage.setItem(
        lane().storageKey(pk),
        JSON.stringify({
          version: 1,
          channels: { "chan-local": { [flag]: true, updatedAt: 1000 } },
        }),
      ),
    payload: {
      version: 1,
      channels: { "chan-remote": { [flag]: true, updatedAt: 2000 } },
    },
    render: (pk) => lane()[name](pk, RELAY),
    // Per-entry lanes merge: the remote entry joins the seeded local one.
    applied: (r) =>
      r.current[ids].has("chan-remote") && r.current[ids].has("chan-local"),
  })),
];

for (const lane of bootstrapLanes) {
  test(`${lane.name} recovery applies the relay head after bootstrap fails`, async (t) => {
    const pk = `pk-boot-${lane.dTag}`;
    const relay = setup(t, pk, (n) => {
      if (n === 1) throw new Error("bootstrap fail");
      return [relayEvent(pk, lane.dTag, 1000, lane.payload)];
    });
    lane.seed?.(pk);
    const { result } = renderHook(() => lane.render(pk));
    await until(() => lane.applied(result), "remote not applied by recovery");
    assert.equal(relay.fetches, 2, "bootstrap plus one immediate recovery");
  });
}

// ---------------------------------------------------------------------------
// Visibility retry is immediate but single-flight
// ---------------------------------------------------------------------------
test("visibility retries immediately but never overlaps an in-flight read", async (t) => {
  const held = deferred();
  const relay = setup(t, "pk-vis", (n) => (n === 2 ? held.promise : []));
  renderHook(() => sections.useChannelSections("pk-vis", RELAY));
  const becomeVisible = () =>
    act(async () => {
      Object.defineProperty(document, "visibilityState", {
        value: "visible",
        configurable: true,
      });
      document.dispatchEvent(new dom.window.Event("visibilitychange"));
    });

  await until(() => relay.fetches === 2, "recovery read did not start");
  await becomeVisible();
  await flush();
  assert.equal(relay.fetches, 2, "visibility overlapped an in-flight read");

  held.resolve([]);
  await flush();
  await becomeVisible();
  await until(() => relay.fetches === 3, "visibility did not retry");
});

// ---------------------------------------------------------------------------
// Backoff: 5 → 10 → 30 → 60 → 60 s, each later head reaches UI and cache
// ---------------------------------------------------------------------------
test("recovery follows the backoff schedule and adopts each later head", async (t) => {
  const pk = "pk-backoff";
  const relay = setup(t, pk, (n) => {
    if (n <= 2) throw new Error("relay down");
    return [
      relayEvent(pk, "channel-sections", 1000 + n, sectionsPayload(`H${n}`)),
    ];
  });
  const { result } = renderHook(() => sections.useChannelSections(pk, RELAY));
  await until(() => relay.fetches === 2, "mount reads did not run");
  await flush();

  for (const [delay, n] of [
    [5_000, 3],
    [10_000, 4],
    [30_000, 5],
    [60_000, 6],
    [60_000, 7],
  ]) {
    await tick(t, delay - 1);
    assert.equal(relay.fetches, n - 1, `read before the ${delay} ms deadline`);
    await tick(t, 1);
    await until(
      () =>
        sectionNames(result.current).join() === `H${n}` &&
        sectionNames(sections.readChannelSectionsStore(pk, RELAY)).join() ===
          `H${n}`,
      `head H${n} not adopted into UI and cache at ${delay} ms`,
    );
    assert.equal(relay.fetches, n, `exactly one read at the ${delay} ms step`);
  }
});

// ---------------------------------------------------------------------------
// Pending edit at tick start: a read started while an edit is pending could
// return the pre-edit blob after the edit publishes and pending clears, when
// neither apply-time guard can reject it.  The tick must skip the read and
// keep polling, so a later head is still adopted.
// ---------------------------------------------------------------------------

const pendingLanes = [
  {
    name: "useChannelSections",
    dTag: "channel-sections",
    Manager: () => sections.ChannelSectionSyncManager,
    render: (pk) => sections.useChannelSections(pk, RELAY),
    edit: (r) => r.current.createSection("Local"),
    stale: sectionsPayload("Stale"),
    later: sectionsPayload("Later"),
    ui: (r) => ({ sections: r.current.sections }),
    cache: (pk) => sections.readChannelSectionsStore(pk, RELAY),
    isLocal: (s) => sectionNames(s).join() === "Local",
    isLater: (s) => sectionNames(s).join() === "Later",
  },
  {
    name: "useChannelSortPreference",
    dTag: "channel-sort",
    Manager: () => sort.ChannelSortSyncManager,
    render: (pk) => sort.useChannelSortPreference(pk, RELAY),
    edit: (r) => r.current.setSortModeFor("channels", "recent"),
    stale: { version: 1, groups: { starred: "recent" } },
    later: { version: 1, groups: { dms: "recent" } },
    ui: (r) => ({
      groups: Object.fromEntries(
        ["starred", "channels", "dms"]
          .map((g) => [g, r.current.sortModeFor(g)])
          .filter(([, mode]) => mode !== "alpha"),
      ),
    }),
    cache: (pk) => sort.readChannelSortStore(pk, RELAY),
    isLocal: (s) => JSON.stringify(s.groups) === '{"channels":"recent"}',
    isLater: (s) => JSON.stringify(s.groups) === '{"dms":"recent"}',
  },
];

for (const lane of pendingLanes) {
  test(`${lane.name} skips a recovery read that starts while an edit is pending`, async (t) => {
    const pk = `pk-pending-${lane.dTag}`;
    const staleRead = deferred();
    const encrypt = deferred();
    const manager = captureManager(t, lane.Manager());
    const relay = setup(t, pk, (n) => {
      if (n <= 2) throw new Error("relay down");
      return []; // pre-publish own-blob read
    });
    relay.encryptGate = encrypt.promise;
    const { result } = renderHook(() => lane.render(pk));
    await until(() => relay.fetches === 2, "mount reads did not run");
    await flush();

    await act(async () => lane.edit(result));
    await tick(t, 2_000); // debounce → pre-publish read, then held encrypt
    await until(() => relay.fetches === 3, "publish did not start");
    relay.fetch = () => staleRead.promise;

    await tick(t, 3_000); // 5 s recovery tick while the edit is pending
    await flush();
    encrypt.resolve();
    await until(
      () => relay.published.length === 1 && !manager.current.getPendingStore(),
      "local edit was not published",
    );
    staleRead.resolve([relayEvent(pk, lane.dTag, 3000, lane.stale)]);
    await flush();

    assert.ok(lane.isLocal(lane.ui(result)), "stale read replaced the edit");
    assert.ok(lane.isLocal(lane.cache(pk)), "stale read replaced the cache");
    assert.ok(lane.isLocal(relay.payload()), "published payload lost edit");
    assert.equal(relay.fetches, 3, "recovery read while an edit was pending");

    const laterAt = relay.published[0].created_at + 1;
    relay.fetch = () => [relayEvent(pk, lane.dTag, laterAt, lane.later)];
    await tick(t, 10_000);
    await until(
      () => lane.isLater(lane.ui(result)) && lane.isLater(lane.cache(pk)),
      "recovery stopped polling after the skipped tick",
    );
  });
}

// ---------------------------------------------------------------------------
// Pending ownership: edit A's ACK lands after edit B replaced pending.  A's
// completion must not clear B's pending, or a recovery read before B's
// debounce would treat B as published and apply A's head over it.
// ---------------------------------------------------------------------------
const perEntry = (lane, name, flag, ids, Manager, read) => ({
  name,
  dTag: `channel-${flag === "starred" ? "stars" : "mutes"}`,
  Manager: () => lane()[Manager],
  render: (pk) => lane()[name](pk, RELAY),
  editA: (r) =>
    r.current[flag === "starred" ? "starChannel" : "muteChannel"]("a"),
  editB: (r) =>
    r.current[flag === "starred" ? "starChannel" : "muteChannel"]("b"),
  ui: (r) => ({
    channels: Object.fromEntries(
      [...r.current[ids]].map((id) => [id, { [flag]: true }]),
    ),
  }),
  cache: (pk) => lane()[read](pk),
  hasB: (s) => s.channels.b?.[flag] === true,
});
const ownershipLanes = [
  ...pendingLanes.map((lane, i) => ({
    ...lane,
    editA: lane.edit,
    editB: [
      (r) => r.current.createSection("B"),
      (r) => r.current.setSortModeFor("dms", "recent"),
    ][i],
    hasB: [
      (s) => sectionNames(s).includes("B"),
      (s) => s.groups.dms === "recent",
    ][i],
  })),
  perEntry(
    () => stars,
    "useChannelStars",
    "starred",
    "starredChannelIds",
    "ChannelStarSyncManager",
    "readChannelStarsStore",
  ),
  perEntry(
    () => mutes,
    "useChannelMutes",
    "muted",
    "mutedChannelIds",
    "ChannelMuteSyncManager",
    "readChannelMutesStore",
  ),
];

for (const [lane, identical] of ownershipLanes.flatMap((l) => [
  [l, false],
  [l, true],
])) {
  test(`${lane.name} keeps a newer edit pending when an older publish completes (${identical ? "identical" : "ack"})`, async (t) => {
    const pk = `pk-own-${lane.dTag}`;
    const ackA = deferred();
    const preflight = deferred();
    let ackStarted = false;
    const manager = captureManager(t, lane.Manager());
    const m = () => manager.current;
    const pending = () =>
      (
        m().getPendingStore ??
        m().getPendingStarStore ??
        m().getPendingMuteStore
      ).call(m());
    const relay = setup(t, pk, (n) => {
      if (n <= 2) throw new Error("relay down");
      return []; // pre-publish own-blob reads
    });
    const { result } = renderHook(() => lane.render(pk));
    await until(() => relay.fetches === 2, "mount reads did not run");
    await flush();

    relay.publish = () => {
      ackStarted = true;
      return ackA.promise;
    };
    await act(async () => lane.editA(result));
    await tick(t, 2_000); // A's debounce → publishEvent, ACK held
    await until(() => relay.fetches === 3, "A did not reach publish");
    await flush();
    assert.ok(ackStarted && !relay.published.length, "A not held at ACK");
    relay.publish = async () => {};
    if (identical) {
      // Reconnect requeues the same A; its redundant publish is held in
      // preflight so B lands before A takes the identical-payload return.
      const sameA = pending();
      await act(async () => relay.reconnect());
      await until(() => relay.fetches === 4, "reconnect read not started");
      await flush();
      assert.equal(pending(), sameA, "reconnect changed the store reference");
      await act(async () => ackA.resolve());
      await until(
        () => relay.published.length === 1 && !pending(),
        "A unsettled",
      );
      relay.fetch = () => preflight.promise;
      await tick(t, 2_000);
      await until(() => relay.fetches === 5, "duplicate preflight not started");
    }
    await act(async () => lane.editB(result));
    if (identical) await act(async () => preflight.resolve([]));
    await act(async () => ackA.resolve());
    await until(() => relay.published.length === 1, "A was not acknowledged");

    const headA = relay.published[0];
    relay.fetch = () => [headA];
    await act(async () => {
      Object.defineProperty(document, "visibilityState", {
        value: "visible",
        configurable: true,
      });
      document.dispatchEvent(new dom.window.Event("visibilitychange"));
    });
    await flush();
    assert.ok(
      pending() && lane.hasB(pending()),
      "A's completion cleared B's pending",
    );
    assert.ok(lane.hasB(lane.ui(result)), "recovery replaced B in the UI");
    assert.ok(lane.hasB(lane.cache(pk)), "recovery replaced B in the cache");

    await tick(t, 2_000); // B's debounce
    await until(
      () => relay.published.length === 2 && !pending(),
      "B did not publish",
    );
    assert.ok(lane.hasB(relay.payload()), "published payload lost B");

    relay.fetch = () => [];
    const reads = relay.fetches;
    await tick(t, 60_000);
    await until(() => relay.fetches > reads, "recovery stopped polling");
  });
}

// ---------------------------------------------------------------------------
// Apply-time pending guard: the local updater is still held when the remote
// response is queued, so a response-time pending check would pass.
// ---------------------------------------------------------------------------
test("remote response queued behind a held local updater does not replace the edit", async (t) => {
  const pk = "pk-held";
  const recovery = deferred();
  const manager = captureManager(t, sections.ChannelSectionSyncManager);
  const relay = setup(t, pk, (n) => {
    if (n === 1) throw new Error("bootstrap fail");
    return n === 2 ? recovery.promise : [];
  });
  const { result } = renderHook(() => sections.useChannelSections(pk, RELAY));
  await until(() => relay.fetches === 2, "recovery read did not start");

  await act(async () => {
    // A queued (non-identical) value update makes React defer rather than
    // eagerly run the next updater, so createSection's updater stays held.
    const key = sections.storageKey(pk, RELAY);
    window.localStorage.setItem(key, JSON.stringify(sectionsPayload("Cached")));
    window.dispatchEvent(new dom.window.StorageEvent("storage", { key }));
    result.current.createSection("Local");
    recovery.resolve([
      relayEvent(pk, "channel-sections", 3000, sectionsPayload("Stale")),
    ]);
    for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
    assert.equal(manager.current.getPendingStore(), null, "updater not held");
    assert.ok(
      !sectionNames(sections.readChannelSectionsStore(pk, RELAY)).includes(
        "Local",
      ),
      "local updater ran before the remote response was queued",
    );
  });

  await tick(t, 2_000);
  await until(
    () => relay.published.length === 1 && !manager.current.getPendingStore(),
    "local edit was not published",
  );
  const local = "Cached,Local";
  assert.equal(sectionNames(relay.payload()).join(), local);
  assert.equal(sectionNames(result.current).join(), local);
  assert.equal(
    sectionNames(sections.readChannelSectionsStore(pk, RELAY)).join(),
    local,
  );
});

// ---------------------------------------------------------------------------
// Bootstrap seed: seeding a cached store sets pending without a local edit
// (no revision bump), so only the apply-time pending check stops a recovery
// read that started before the seed from cancelling the seed publication.
// ---------------------------------------------------------------------------
for (const lane of [
  {
    name: "useChannelSections",
    dTag: "channel-sections",
    Manager: () => sections.ChannelSectionSyncManager,
    render: (pk) => sections.useChannelSections(pk, RELAY),
    seed: sectionsPayload("Seed"),
    remote: sectionsPayload("Remote"),
    key: (pk) => sections.storageKey(pk, RELAY),
    ui: (r) => sectionNames(r.current).join(),
    cache: (pk) =>
      sectionNames(sections.readChannelSectionsStore(pk, RELAY)).join(),
    // Whole-blob lane: the head recovery observed supersedes the seed.
    yielded: "Remote",
  },
  {
    name: "useChannelStars",
    dTag: "channel-stars",
    Manager: () => stars.ChannelStarSyncManager,
    render: (pk) => stars.useChannelStars(pk, RELAY),
    seed: {
      version: 1,
      channels: { seed: { starred: true, updatedAt: 1000 } },
    },
    remote: {
      version: 1,
      channels: { remote: { starred: true, updatedAt: 2000 } },
    },
    key: (pk) => stars.storageKey(pk),
    ui: (r) => [...r.current.starredChannelIds].sort().join(),
    cache: (pk) =>
      Object.keys(
        JSON.parse(window.localStorage.getItem(stars.storageKey(pk))).channels,
      )
        .sort()
        .join(),
    kept: "seed",
    merged: "remote,seed",
  },
]) {
  test(`${lane.name} bootstrap seed against a head recovery observed`, async (t) => {
    const pk = `pk-seed-${lane.dTag}`;
    const boot = deferred();
    const recovery = deferred();
    const manager = captureManager(t, lane.Manager());
    const pending = () =>
      (
        manager.current.getPendingStore ?? manager.current.getPendingStarStore
      ).call(manager.current);
    const relay = setup(t, pk, (n) =>
      n === 1 ? boot.promise : n === 2 ? recovery.promise : [],
    );
    window.localStorage.setItem(lane.key(pk), JSON.stringify(lane.seed));
    const { result } = renderHook(() => lane.render(pk));
    await until(
      () => relay.fetches === 2,
      "bootstrap and recovery not in flight",
    );
    assert.equal(pending(), null, "pending before the recovery read started");

    await act(async () => boot.resolve([])); // absent + zero watermark → seed
    await until(() => pending() !== null, "bootstrap did not seed");
    await act(async () =>
      recovery.resolve([relayEvent(pk, lane.dTag, 3000, lane.remote)]),
    );
    await flush();

    await tick(t, 2_000); // seed debounce; prepublish read returns []
    if (lane.yielded) {
      await until(() => pending() === null, "seed still pending");
      assert.equal(relay.published.length, 0, "seed overwrote the head");
      relay.fetch = () => [relayEvent(pk, lane.dTag, 3000, lane.remote)];
      await tick(t, 5_000);
      await until(
        () =>
          lane.ui(result) === lane.yielded && lane.cache(pk) === lane.yielded,
        "observed head not adopted after the seed yielded",
      );
      return;
    }
    await until(
      () => relay.published.length === 1 && pending() === null,
      "recovery read cancelled the seed publication",
    );
    assert.deepEqual(relay.payload(), lane.seed);
    assert.equal(lane.ui(result), lane.kept);
    assert.equal(lane.cache(pk), lane.kept);

    if (!lane.merged) return;
    // Per-entry lane: the next recovery tick merges the remote entry.
    relay.fetch = () => [relayEvent(pk, lane.dTag, 4000, lane.remote)];
    await tick(t, 3_000);
    await until(
      () => lane.ui(result) === lane.merged && lane.cache(pk) === lane.merged,
      "remote entry not merged after the seed published",
    );
  });
}

// ---------------------------------------------------------------------------
// Whole-blob lanes: an absence-based seed must not replace a remote head that
// a later read observed.  The prepublish read finds R, so the seed is
// abandoned and the next recovery tick adopts R.
// ---------------------------------------------------------------------------
for (const lane of [
  {
    name: "useChannelSections",
    dTag: "channel-sections",
    Manager: () => sections.ChannelSectionSyncManager,
    render: (pk) => sections.useChannelSections(pk, RELAY),
    seed: sectionsPayload("Seed"),
    remote: sectionsPayload("Remote"),
    key: (pk) => sections.storageKey(pk, RELAY),
    ui: (r) => sectionNames(r.current).join(),
    cache: (pk) =>
      sectionNames(sections.readChannelSectionsStore(pk, RELAY)).join(),
    adopted: "Remote",
    later: sectionsPayload("Later"),
    laterUi: "Later",
  },
  {
    name: "useChannelSortPreference",
    dTag: "channel-sort",
    Manager: () => sort.ChannelSortSyncManager,
    render: (pk) => sort.useChannelSortPreference(pk, RELAY),
    seed: { version: 1, groups: { channels: "recent" } },
    remote: { version: 1, groups: { dms: "recent" } },
    key: (pk) => sort.storageKey(pk, RELAY),
    ui: (r) =>
      ["channels", "dms"]
        .filter((g) => r.current.sortModeFor(g) !== "alpha")
        .join(),
    cache: (pk) =>
      Object.keys(sort.readChannelSortStore(pk, RELAY).groups).join(),
    adopted: "dms",
    later: { version: 1, groups: { channels: "recent" } },
    laterUi: "channels",
  },
]) {
  test(`${lane.name} bootstrap seed yields to a head observed after it was queued`, async (t) => {
    const pk = `pk-seed-yield-${lane.dTag}`;
    const boot = deferred();
    const recovery = deferred();
    const manager = captureManager(t, lane.Manager());
    const remote = [relayEvent(pk, lane.dTag, 3000, lane.remote)];
    const relay = setup(t, pk, (n) =>
      n === 1 ? boot.promise : n === 2 ? recovery.promise : remote,
    );
    window.localStorage.setItem(lane.key(pk), JSON.stringify(lane.seed));
    const { result } = renderHook(() => lane.render(pk));
    await until(() => relay.fetches === 2, "mount reads not in flight");

    await act(async () => boot.resolve([]));
    await until(
      () => manager.current.getPendingStore() !== null,
      "bootstrap did not seed",
    );
    await act(async () => recovery.resolve(remote));
    await flush();

    await tick(t, 2_000); // seed debounce
    await until(
      () => manager.current.getPendingStore() === null,
      "seed was not abandoned",
    );
    assert.equal(relay.published.length, 0, "seed overwrote the remote head");

    relay.reconnect(); // a cancelled seed must not come back via reconnect
    await flush();
    await tick(t, 5_000); // next recovery tick adopts R
    await until(
      () => lane.ui(result) === lane.adopted && lane.cache(pk) === lane.adopted,
      "remote head not adopted after the seed yielded",
    );
    await tick(t, 2_000);
    await flush();
    assert.equal(relay.published.length, 0, "seed republished");
  });

  for (const boundary of ["encrypt", "sign"]) {
    test(`${lane.name} bootstrap seed yields to a head recorded during ${boundary}`, async (t) => {
      const pk = `pk-seed-${boundary}-${lane.dTag}`;
      const boot = deferred();
      const recovery = deferred();
      const gate = deferred();
      const manager = captureManager(t, lane.Manager());
      const remote = [relayEvent(pk, lane.dTag, 3000, lane.remote)];
      const relay = setup(t, pk, (n) =>
        n === 1 ? boot.promise : n === 2 ? recovery.promise : [],
      );
      holdAt(relay, boundary, gate.promise);
      window.localStorage.setItem(lane.key(pk), JSON.stringify(lane.seed));
      const { result } = renderHook(() => lane.render(pk));
      await until(() => relay.fetches === 2, "mount reads not in flight");
      await act(async () => boot.resolve([]));
      await until(
        () => manager.current.getPendingStore() !== null,
        "bootstrap did not seed",
      );
      await tick(t, 2_000); // debounce → prepublish [] → held at boundary
      await until(() => relay.fetches === 3, "prepublish did not run");
      await flush();
      await act(async () => recovery.resolve(remote));
      await flush();
      await act(async () => gate.resolve());
      await flush();
      assert.equal(relay.published.length, 0, "seed overwrote the head");
      assert.equal(manager.current.getPendingStore(), null, "seed pending");
      relay.fetch = () => remote;
      await tick(t, 5_000);
      await until(
        () =>
          lane.ui(result) === lane.adopted && lane.cache(pk) === lane.adopted,
        "remote head not adopted",
      );
    });
  }

  test(`${lane.name} requeued bootstrap seed still yields to a later head`, async (t) => {
    const pk = `pk-seed-requeue-${lane.dTag}`;
    const gate = deferred();
    const manager = captureManager(t, lane.Manager());
    const remote = [relayEvent(pk, lane.dTag, 3000, lane.remote)];
    const relay = setup(t, pk, () => []);
    window.localStorage.setItem(lane.key(pk), JSON.stringify(lane.seed));
    const { result } = renderHook(() => lane.render(pk));
    await until(
      () => manager.current?.getPendingStore() != null,
      "bootstrap did not seed",
    );
    const seed = manager.current.getPendingStore();
    // Reconnect read sees no head, so the same pending seed is requeued.
    relay.fetch = () => {
      throw new Error("relay down");
    };
    await act(async () => relay.reconnect());
    await flush();
    assert.equal(manager.current.getPendingStore(), seed, "seed not requeued");
    relay.fetch = () => [];
    relay.encryptGate = gate.promise;
    await tick(t, 2_000); // requeued debounce → prepublish [] → held encrypt
    await flush();
    relay.fetch = () => remote;
    await act(async () => relay.reconnect()); // records R mid-encrypt
    await flush();
    await act(async () => gate.resolve());
    await flush();
    assert.equal(relay.published.length, 0, "requeued seed overwrote the head");
    await tick(t, 10_000);
    await until(
      () => lane.ui(result) === lane.adopted && lane.cache(pk) === lane.adopted,
      "remote head not adopted",
    );
  });

  test(`${lane.name} reconnect-cancelled seed does not stall later recovery`, async (t) => {
    const pk = `pk-seed-stall-${lane.dTag}`;
    const manager = captureManager(t, lane.Manager());
    const relay = setup(t, pk, () => []);
    window.localStorage.setItem(lane.key(pk), JSON.stringify(lane.seed));
    const { result } = renderHook(() => lane.render(pk));
    await until(
      () => manager.current?.getPendingStore() != null,
      "bootstrap did not seed",
    );
    relay.fetch = () => [relayEvent(pk, lane.dTag, 3000, lane.remote)];
    await act(async () => relay.reconnect()); // during the seed debounce
    await flush();
    await tick(t, 2_000);
    await flush();
    assert.equal(lane.ui(result), lane.adopted, "first head not applied");
    assert.equal(relay.published.length, 0, "seed published over the head");
    relay.fetch = () => [relayEvent(pk, lane.dTag, 4000, lane.later)];
    for (const ms of [5_000, 10_000, 30_000, 60_000]) await tick(t, ms);
    await until(
      () => lane.ui(result) === lane.laterUi && lane.cache(pk) === lane.laterUi,
      "stuck seed blocked later recovery",
    );
  });

  test(`${lane.name} bootstrap seed publishes when no head appears`, async (t) => {
    const pk = `pk-seed-control-${lane.dTag}`;
    const manager = captureManager(t, lane.Manager());
    const relay = setup(t, pk, () => []);
    window.localStorage.setItem(lane.key(pk), JSON.stringify(lane.seed));
    renderHook(() => lane.render(pk));
    await until(
      () => manager.current?.getPendingStore() != null,
      "bootstrap did not seed",
    );
    await tick(t, 2_000);
    await until(() => relay.published.length === 1, "seed was not published");
    assert.deepEqual(relay.payload(), lane.seed);
  });
}

// ---------------------------------------------------------------------------
// Revision guard: a read that started before the edit and lands after its
// publication succeeded (pending already clear) is discarded.
// ---------------------------------------------------------------------------
test("read started before an edit is discarded after the edit publishes", async (t) => {
  const pk = "pk-revision";
  const recovery = deferred();
  const manager = captureManager(t, sections.ChannelSectionSyncManager);
  const relay = setup(t, pk, (n) => {
    if (n === 1) throw new Error("bootstrap fail");
    return n === 2 ? recovery.promise : [];
  });
  const { result } = renderHook(() => sections.useChannelSections(pk, RELAY));
  await until(() => relay.fetches === 2, "recovery read did not start");

  await act(async () => result.current.createSection("Local"));
  await tick(t, 2_000);
  await until(
    () => relay.published.length === 1 && !manager.current.getPendingStore(),
    "local edit was not published",
  );
  assert.equal(sectionNames(relay.payload()).join(), "Local");

  await act(async () =>
    recovery.resolve([
      relayEvent(pk, "channel-sections", 3000, sectionsPayload("Stale")),
    ]),
  );
  await flush();
  assert.equal(sectionNames(result.current).join(), "Local");
  assert.equal(
    sectionNames(sections.readChannelSectionsStore(pk, RELAY)).join(),
    "Local",
  );
});

// ---------------------------------------------------------------------------
// Unmount cancels an in-flight recovery read
// ---------------------------------------------------------------------------
test("unmount prevents an in-flight recovery read from writing the cache", async (t) => {
  const pk = "pk-unmount";
  const recovery = deferred();
  const relay = setup(t, pk, (n) => (n === 2 ? recovery.promise : []));
  const { unmount } = renderHook(() => sections.useChannelSections(pk, RELAY));
  await until(() => relay.fetches === 2, "recovery read did not start");

  unmount();
  recovery.resolve([
    relayEvent(pk, "channel-sections", 9000, sectionsPayload("Ghost")),
  ]);
  await flush();
  assert.deepEqual(
    sectionNames(sections.readChannelSectionsStore(pk, RELAY)),
    [],
  );
});

// ---------------------------------------------------------------------------
// Equal-second tie-break: the lower event ID is the canonical head
// ---------------------------------------------------------------------------
test("recovery keeps the lower event ID at an equal created_at", async (t) => {
  const pk = "pk-tiebreak";
  const relay = setup(t, pk, (n) => [
    n === 1
      ? relayEvent(pk, "channel-sections", 1000, sectionsPayload("Low"), "aaa")
      : relayEvent(
          pk,
          "channel-sections",
          1000,
          sectionsPayload("High"),
          "zzz",
        ),
  ]);
  const { result } = renderHook(() => sections.useChannelSections(pk, RELAY));
  await until(() => relay.fetches === 2, "mount reads did not run");
  await flush();
  assert.equal(sectionNames(result.current).join(), "Low");
});

// ---------------------------------------------------------------------------
// A failed cache write leaves the same head retryable
// ---------------------------------------------------------------------------
test("a one-shot cache-write failure leaves the same head retryable", async (t) => {
  const pk = "pk-quota";
  const relay = setup(t, pk, (n) => {
    if (n === 1) throw new Error("bootstrap fail");
    return [relayEvent(pk, "channel-sections", 9000, sectionsPayload("Kept"))];
  });
  const target = sections.storageKey(pk, RELAY);
  const proto = Object.getPrototypeOf(window.localStorage);
  const origSetItem = proto.setItem;
  let failures = 0;
  proto.setItem = function (key, value) {
    if (key === target && failures++ === 0)
      throw new DOMException("QuotaExceededError");
    return origSetItem.call(this, key, value);
  };
  t.after(() => {
    proto.setItem = origSetItem;
  });

  const { result } = renderHook(() => sections.useChannelSections(pk, RELAY));
  await until(() => relay.fetches === 2, "recovery read did not run");
  await flush();
  assert.deepEqual(sectionNames(result.current), []);

  await tick(t, 5_000);
  await until(
    () => sectionNames(result.current).join() === "Kept",
    "same head not retried after the write recovered",
  );
});

// ---------------------------------------------------------------------------
// Still-mounted relay switch (A → B): A's held reads never reach UI or cache,
// and the recovery loop restarts on B.  Stars and mutes matter because their
// `applyRemote` does not capture relayUrl.
// ---------------------------------------------------------------------------
for (const [lane, name, dTag, flag, ids] of [
  [
    () => stars,
    "useChannelStars",
    "channel-stars",
    "starred",
    "starredChannelIds",
  ],
  [() => mutes, "useChannelMutes", "channel-mutes", "muted", "mutedChannelIds"],
]) {
  test(`${name} relay switch rejects relay-A reads and recovers on relay B`, async (t) => {
    const pk = `pk-switch-${dTag}`;
    const relayA = "wss://relay-a.example";
    const payload = (chan) => ({
      version: 1,
      channels: { [chan]: { [flag]: true, updatedAt: 1000 } },
    });
    const heldA = [];
    let bHead = relayEvent(pk, dTag, 1000, payload("chan-b"));
    let relayUrl = relayA;
    const relay = setup(t, pk, () => {
      if (relayUrl !== relayA) return [bHead];
      const held = deferred();
      heldA.push(held);
      return held.promise;
    });
    const { result, rerender } = renderHook(() => lane()[name](pk, relayUrl));
    await until(() => heldA.length === 2, "relay-A reads did not start");

    relayUrl = RELAY;
    rerender();
    await until(() => result.current[ids].has("chan-b"), "B not applied");

    // A's held responses are newer than B, so only the lifetime fence can
    // reject them.
    for (const held of heldA)
      held.resolve([relayEvent(pk, dTag, 5000, payload("chan-a"))]);
    await flush();
    const cached = () =>
      JSON.parse(window.localStorage.getItem(lane().storageKey(pk))).channels;
    assert.ok(!result.current[ids].has("chan-a"), "relay-A entry in UI");
    assert.ok(cached()["chan-b"] && !cached()["chan-a"], "relay-A in cache");

    const fetchesOnB = relay.fetches;
    bHead = relayEvent(pk, dTag, 2000, payload("chan-b-later"));
    await tick(t, 5_000);
    await until(
      () => result.current[ids].has("chan-b-later") && cached()["chan-b-later"],
      "recovery loop did not restart on relay B",
    );
    assert.equal(relay.fetches, fetchesOnB + 1, "one B recovery read at 5 s");
  });
}
