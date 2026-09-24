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

/** The pending store of any sidebar sync manager. */
const pendingOf = (m) =>
  (m.getPendingStore ?? m.getPendingStarStore ?? m.getPendingMuteStore).call(m);

/**
 * Seed publications once a head is observed: none for whole-blob lanes,
 * only the seed ∪ head union for per-entry lanes.
 */
function assertSeedYielded(lane, relay) {
  const sent = lane.published?.(relay) ?? relay.published.map(() => "?");
  const want = lane.published ? sent.map(() => lane.adopted) : [];
  assert.deepEqual(sent, want, "seed published without the observed head");
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
// Bootstrap seed (whole-blob lane): a recovery read that started before the
// seed and returns a head is recorded first, so the seed yields to it and a
// later read adopts the head.
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
]) {
  test(`${lane.name} bootstrap seed against a head recovery observed`, async (t) => {
    const pk = `pk-seed-${lane.dTag}`;
    const boot = deferred();
    const recovery = deferred();
    const manager = captureManager(t, lane.Manager());
    const pending = () => pendingOf(manager.current);
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
    await until(() => pending() === null, "seed still pending");
    assert.equal(relay.published.length, 0, "seed overwrote the head");
    relay.fetch = () => [relayEvent(pk, lane.dTag, 3000, lane.remote)];
    await tick(t, 5_000);
    await until(
      () => lane.ui(result) === lane.yielded && lane.cache(pk) === lane.yielded,
      "observed head not adopted after the seed yielded",
    );
  });
}

// ---------------------------------------------------------------------------
// All four lanes: an absence-based seed must not replace a remote head that
// a later read observed.  Whole-blob lanes abandon the seed and adopt R;
// per-entry lanes publish only the seed's union with R.
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
  ...[
    [
      () => stars,
      "useChannelStars",
      "channel-stars",
      "starred",
      "ChannelStarSyncManager",
      "starredChannelIds",
    ],
    [
      () => mutes,
      "useChannelMutes",
      "channel-mutes",
      "muted",
      "ChannelMuteSyncManager",
      "mutedChannelIds",
    ],
  ].map(([lane, name, dTag, flag, Manager, ids]) => {
    const entries = (...keys) => ({
      version: 1,
      channels: Object.fromEntries(
        keys.map((k, i) => [k, { [flag]: true, updatedAt: 1000 + i }]),
      ),
    });
    return {
      name,
      dTag,
      Manager: () => lane()[Manager],
      render: (pk) => lane()[name](pk, RELAY),
      seed: entries("seed"),
      remote: entries("remote"),
      key: (pk) => lane().storageKey(pk),
      ui: (r) => [...r.current[ids]].sort().join(),
      cache: (pk) =>
        Object.keys(
          JSON.parse(window.localStorage.getItem(lane().storageKey(pk)))
            .channels,
        )
          .sort()
          .join(),
      // Per-entry lanes merge the observed head into the local seed.
      adopted: "remote,seed",
      // Every seed publication carries R; none is the seed alone.
      published: (relay) =>
        relay.published.map((e) =>
          Object.keys(JSON.parse(e.content).channels).sort().join(),
        ),
      later: entries("remote", "later"),
      laterUi: "later,remote,seed",
    };
  }),
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
      () => pendingOf(manager.current) !== null,
      "bootstrap did not seed",
    );
    await act(async () => recovery.resolve(remote));
    await flush();

    await tick(t, 2_000); // seed debounce
    await until(
      () => pendingOf(manager.current) === null,
      "seed was not abandoned",
    );
    assertSeedYielded(lane, relay);

    relay.reconnect(); // a cancelled seed must not come back via reconnect
    await flush();
    await tick(t, 5_000); // next recovery tick adopts R
    await until(
      () => lane.ui(result) === lane.adopted && lane.cache(pk) === lane.adopted,
      "remote head not adopted after the seed yielded",
    );
    await tick(t, 2_000);
    await flush();
    assertSeedYielded(lane, relay);
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
        () => pendingOf(manager.current) !== null,
        "bootstrap did not seed",
      );
      await tick(t, 2_000); // debounce → prepublish [] → held at boundary
      await until(() => relay.fetches === 3, "prepublish did not run");
      await flush();
      await act(async () => recovery.resolve(remote));
      await flush();
      await act(async () => gate.resolve());
      await flush();
      if (!lane.published) {
        assert.equal(relay.published.length, 0, "seed overwrote the head");
        assert.equal(pendingOf(manager.current), null, "seed pending");
      }
      relay.fetch = () => remote;
      // Per-entry lanes first publish the re-armed union, then read R.
      for (const ms of [5_000, 10_000]) await tick(t, ms);
      await until(
        () =>
          lane.ui(result) === lane.adopted && lane.cache(pk) === lane.adopted,
        "remote head not adopted",
      );
      assertSeedYielded(lane, relay);
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
      () => pendingOf(manager.current) != null,
      "bootstrap did not seed",
    );
    const seed = pendingOf(manager.current);
    // Reconnect read sees no head, so the same pending seed is requeued.
    relay.fetch = () => {
      throw new Error("relay down");
    };
    await act(async () => relay.reconnect());
    await flush();
    assert.equal(pendingOf(manager.current), seed, "seed not requeued");
    relay.fetch = () => [];
    relay.encryptGate = gate.promise;
    await tick(t, 2_000); // requeued debounce → prepublish [] → held encrypt
    await flush();
    relay.fetch = () => remote;
    await act(async () => relay.reconnect()); // records R mid-encrypt
    await flush();
    await act(async () => gate.resolve());
    await flush();
    if (!lane.published)
      assert.equal(relay.published.length, 0, "requeued seed overwrote head");
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
      () => pendingOf(manager.current) != null,
      "bootstrap did not seed",
    );
    relay.fetch = () => [relayEvent(pk, lane.dTag, 3000, lane.remote)];
    await act(async () => relay.reconnect()); // during the seed debounce
    await flush();
    await tick(t, 2_000);
    await flush();
    assert.equal(lane.ui(result), lane.adopted, "first head not applied");
    assertSeedYielded(lane, relay);
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
      () => pendingOf(manager.current) != null,
      "bootstrap did not seed",
    );
    await tick(t, 2_000);
    await until(() => relay.published.length === 1, "seed was not published");
    assert.deepEqual(relay.payload(), lane.seed);
  });
}

// ---------------------------------------------------------------------------
// Per-entry lanes against a replacement-aware relay: the head follows
// created_at, then lower ID (replaceable.rs), and later reads return only
// that head.  R sits 30 s ahead of a fixed clock.  A seed must never publish
// without the highest observed head, and once it has seen R the relay and a
// fresh device must both end with R ∪ S.
// ---------------------------------------------------------------------------
for (const [getLane, name, dTag, flag, Manager, ids] of [
  [
    () => stars,
    "useChannelStars",
    "channel-stars",
    "starred",
    "ChannelStarSyncManager",
    "starredChannelIds",
  ],
  [
    () => mutes,
    "useChannelMutes",
    "channel-mutes",
    "muted",
    "ChannelMuteSyncManager",
    "mutedChannelIds",
  ],
]) {
  const NOW = 1_800_000_000;
  const entry = (...keys) => ({
    version: 1,
    channels: Object.fromEntries(
      keys.map((k) => [k, { [flag]: true, updatedAt: NOW - 100 }]),
    ),
  });
  const keysOf = (event) =>
    Object.keys(JSON.parse(event.content).channels).sort().join();

  /**
   * `recovery` is what the recovery read returns ("R", "undecodable" or
   * nothing); `prepublish` is what the seed's pre-publish read sees.
   */
  async function run(t, { recovery, prepublish, signHead }) {
    const lane = getLane();
    const pk = `pk-union-${dTag}-${recovery}-${prepublish}-${!!signHead}`;
    t.mock.method(Date, "now", () => NOW * 1000);
    const R = relayEvent(pk, dTag, NOW + 30, entry("remote"), "0000-remote");
    if (recovery === "undecodable") R.content = "not json";
    let head = R;
    const boot = deferred();
    const read = deferred();
    const manager = captureManager(t, lane[Manager]);
    let inPreflight = false;
    const preflight = lane[Manager].prototype.fetchOwnBlobBeforePublish;
    t.mock.method(
      lane[Manager].prototype,
      "fetchOwnBlobBeforePublish",
      async function (...args) {
        inPreflight = true;
        try {
          return await preflight.apply(this, args);
        } finally {
          inPreflight = false;
        }
      },
    );
    const relay = setup(t, pk, (n) => {
      if (n === 1) return boot.promise;
      if (n === 2) return read.promise;
      if (inPreflight && prepublish === "absent") return [];
      if (inPreflight && prepublish === "throws") throw new Error("down");
      return [head];
    });
    relay.publish = async (event) => {
      if (
        event.created_at > head.created_at ||
        (event.created_at === head.created_at && event.id < head.id)
      )
        head = event;
    };
    const gate = signHead ? deferred() : null;
    if (gate) holdAt(relay, "sign", gate.promise);
    window.localStorage.setItem(
      lane.storageKey(pk),
      JSON.stringify(entry("seed")),
    );
    const first = renderHook(() => lane[name](pk, RELAY));
    await until(() => relay.fetches === 2, "mount reads not in flight");
    await act(async () => boot.resolve([]));
    await until(() => pendingOf(manager.current) != null, "no seed");
    await act(async () => read.resolve(recovery ? [R] : []));
    await flush();
    await tick(t, 2_000);
    await flush();
    if (gate) {
      // A newer head lands while the R ∪ S union is being signed.
      head = relayEvent(pk, dTag, NOW + 60, entry("remote", "newer"), "0-n");
      await act(async () => relay.reconnect());
      await flush();
      await act(async () => gate.resolve());
      await flush();
    }
    for (const ms of [2_000, 5_000, 10_000, 30_000]) {
      await tick(t, ms);
      await flush();
    }
    first.unmount();
    window.localStorage.clear(); // a fresh device: same identity, no cache
    const second = renderHook(() => lane[name](pk, RELAY));
    await flush();
    return {
      sent: relay.published.map(keysOf),
      head: head === R && recovery === "undecodable" ? "R" : keysOf(head),
      fresh: [...second.result.current[ids]].sort().join(),
    };
  }

  for (const [label, opts] of [
    ["prepublish returns R", { recovery: "R", prepublish: "R" }],
    ["prepublish is the first observer of R", { prepublish: "R" }],
    ["prepublish absent after R", { recovery: "R", prepublish: "absent" }],
    ["prepublish throws after R", { recovery: "R", prepublish: "throws" }],
  ]) {
    test(`${name} seed publishes its union with R when ${label}`, async (t) => {
      const { sent, head, fresh } = await run(t, opts);
      assert.deepEqual(sent, ["remote,seed"], "seed sent without R");
      assert.equal(head, "remote,seed", "relay head is not R ∪ S");
      assert.equal(fresh, "remote,seed", "fresh device misses R ∪ S");
    });
  }

  for (const prepublish of ["absent", "throws"]) {
    test(`${name} seed unaware of R never replaces it (prepublish ${prepublish})`, async (t) => {
      const { sent, head } = await run(t, { prepublish });
      assert.deepEqual(sent, ["seed"], "expected the pre-R seed publish");
      assert.equal(head, "remote", "a pre-R seed replaced R");
    });
  }

  test(`${name} undecodable head abandons the seed`, async (t) => {
    const { sent, head } = await run(t, {
      recovery: "undecodable",
      prepublish: "R",
    });
    assert.deepEqual(sent, [], "seed published over an undecodable head");
    assert.equal(head, "R");
  });

  test(`${name} newer head during sign rebuilds the seed union`, async (t) => {
    const { sent, head, fresh } = await run(t, {
      recovery: "R",
      prepublish: "R",
      signHead: true,
    });
    assert.deepEqual(sent, ["newer,remote,seed"], "stale union published");
    assert.equal(head, "newer,remote,seed");
    assert.equal(fresh, "newer,remote,seed");
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

// ---------------------------------------------------------------------------
// Per-entry seed jobs across overlapping heads and publications.  Heads are
// ordered as the relay orders them (created_at, then lower ID); a seed job
// publishes only for the current seed generation and canonical head, and
// completion retires only the generation it sent.
// ---------------------------------------------------------------------------
for (const [getLane, name, dTag, flag, Manager, ids, edit] of [
  [
    () => stars,
    "useChannelStars",
    "channel-stars",
    "starred",
    "ChannelStarSyncManager",
    "starredChannelIds",
    "starChannel",
  ],
  [
    () => mutes,
    "useChannelMutes",
    "channel-mutes",
    "muted",
    "ChannelMuteSyncManager",
    "mutedChannelIds",
    "muteChannel",
  ],
]) {
  const NOW = 1_800_000_000;
  const entries = (...keys) => ({
    version: 1,
    channels: Object.fromEntries(
      keys.map((k) => [k, { [flag]: true, updatedAt: NOW }]),
    ),
  });
  const keysOf = (event) =>
    event.content === "not json"
      ? "UNDECODABLE"
      : Object.keys(JSON.parse(event.content).channels).sort().join();

  /** Mounts a seed against R and hands `drive` the relay controls. */
  async function run(t, pk, drive) {
    const lane = getLane();
    t.mock.method(Date, "now", () => NOW * 1000);
    const ctl = {
      head: relayEvent(pk, dTag, NOW + 30, entries("remote"), "bbbb"),
      gate: deferred(),
      pre: null,
      holdFirstAck: false,
      inPreflight: false,
    };
    const boot = deferred();
    const recovery = deferred();
    const manager = captureManager(t, lane[Manager]);
    const preflight = lane[Manager].prototype.fetchOwnBlobBeforePublish;
    let preflights = 0;
    t.mock.method(
      lane[Manager].prototype,
      "fetchOwnBlobBeforePublish",
      async function (...args) {
        if (++preflights === 1 && ctl.pre) await ctl.pre.promise;
        ctl.inPreflight = true;
        try {
          return await preflight.apply(this, args);
        } finally {
          ctl.inPreflight = false;
        }
      },
    );
    const relay = setup(t, pk, (n) =>
      n === 1 ? boot.promise : n === 2 ? recovery.promise : [],
    );
    relayClient.subscribeLive = async (_, cb) => {
      ctl.live = (event) => act(async () => cb(event));
      return async () => {};
    };
    relay.publish = async (event) => {
      const h = ctl.head;
      if (
        event.created_at > h.created_at ||
        (event.created_at === h.created_at && event.id < h.id)
      )
        ctl.head = event;
      if (ctl.holdFirstAck && relay.published.length === 0)
        await ctl.gate.promise;
    };
    window.localStorage.setItem(
      lane.storageKey(pk),
      JSON.stringify(entries("seed")),
    );
    const first = renderHook(() => lane[name](pk, RELAY));
    await until(() => relay.fetches === 2, "mount reads not in flight");
    await act(async () => boot.resolve([]));
    await until(() => pendingOf(manager.current) != null, "no seed");
    await drive({ ctl, relay, recovery, first });
    relay.fetch = () => (ctl.inPreflight ? [] : [ctl.head]);
    for (const ms of [2_000, 5_000, 10_000]) {
      await tick(t, ms);
      await flush();
    }
    const pending = pendingOf(manager.current);
    first.unmount();
    window.localStorage.clear(); // a fresh device: same identity, no cache
    const second = renderHook(() => lane[name](pk, RELAY));
    await flush();
    return {
      head: keysOf(ctl.head),
      fresh: [...second.result.current[ids]].sort().join(),
      pending,
    };
  }

  const recoverR = async ({ ctl, recovery }) => {
    await act(async () => recovery.resolve([ctl.head]));
    await flush();
  };
  const next = (pk, at, id, ...keys) =>
    relayEvent(pk, dTag, NOW + at, entries(...keys), id);

  for (const boundary of ["encrypt", "sign"]) {
    test(`${name} seed folds a same-second lower-ID head during ${boundary}`, async (t) => {
      const pk = `pk-tie-${boundary}-${dTag}`;
      const out = await run(t, pk, async (c) => {
        holdAt(c.relay, boundary, c.ctl.gate.promise);
        await recoverR(c);
        await tick(t, 2_000);
        await flush();
        c.ctl.head = next(pk, 30, "aaaa", "remote", "tie");
        await c.ctl.live(c.ctl.head);
        await flush();
        await act(async () => c.ctl.gate.resolve());
        await flush();
      });
      assert.equal(out.head, "remote,seed,tie", "winning tie head lost");
      assert.equal(out.fresh, "remote,seed,tie");
    });
  }

  test(`${name} same-second undecodable head abandons the seed`, async (t) => {
    const pk = `pk-tie-undecodable-${dTag}`;
    const out = await run(t, pk, async (c) => {
      holdAt(c.relay, "sign", c.ctl.gate.promise);
      await recoverR(c);
      await tick(t, 2_000);
      await flush();
      c.ctl.head = next(pk, 30, "aaaa", "remote", "tie");
      c.ctl.head.content = "not json";
      await c.ctl.live(c.ctl.head);
      await flush();
      await act(async () => c.ctl.gate.resolve());
      await flush();
    });
    assert.equal(out.head, "UNDECODABLE", "seed published over unknown head");
    assert.equal(out.pending, null, "abandoned seed still pending");
  });

  test(`${name} seed timer queued before a preflight fold is obsolete`, async (t) => {
    const pk = `pk-gen-timer-${dTag}`;
    const out = await run(t, pk, async (c) => {
      c.ctl.pre = deferred();
      await recoverR(c);
      await tick(t, 2_000); // P1 held in preflight
      await flush();
      c.ctl.head = next(pk, 60, "bbbb2", "remote", "second");
      await c.ctl.live(c.ctl.head); // arms a timer for the B generation
      await flush();
      const C = next(pk, 90, "bbbb3", "remote", "second", "third");
      c.ctl.head = C;
      c.relay.fetch = () => [C];
      await act(async () => c.ctl.pre.resolve()); // P1's preflight folds C
      await flush();
    });
    assert.equal(out.head, "remote,second,seed,third", "older union won");
    assert.equal(out.fresh, "remote,second,seed,third");
    assert.equal(out.pending, null, "seed stranded");
  });

  test(`${name} older seed completion leaves a newer seed pending`, async (t) => {
    const pk = `pk-gen-ack-${dTag}`;
    const out = await run(t, pk, async (c) => {
      c.ctl.holdFirstAck = true;
      await recoverR(c);
      await tick(t, 2_000); // P1 submitted, its completion held
      await flush();
      c.ctl.head = next(pk, 60, "bbbb2", "remote", "second");
      await c.ctl.live(c.ctl.head);
      await flush();
      await act(async () => c.ctl.gate.resolve());
      await flush();
      c.ctl.head = next(pk, 90, "bbbb3", "remote", "second", "third");
      await c.ctl.live(c.ctl.head); // applyRemote → cancelPending*Publish
      await flush();
    });
    assert.equal(out.head, "remote,second,seed,third", "newer seed lost");
    assert.equal(out.fresh, "remote,second,seed,third");
    assert.equal(out.pending, null, "newer seed stranded");
  });

  for (const [variant, read] of [
    ["returns R", (c) => [c.ctl.head]],
    ["absent", () => []],
    [
      "throws",
      () => {
        throw new Error("read failed");
      },
    ],
  ]) {
    test(`${name} real edit over a pending seed keeps its union (preflight ${variant})`, async (t) => {
      const pk = `pk-gen-edit-${variant}-${dTag}`;
      const out = await run(t, pk, async (c) => {
        c.ctl.pre = deferred();
        await recoverR(c); // manager seed is R+S; React still holds only S
        await tick(t, 2_000); // seed job held in preflight
        await flush();
        await act(async () => c.first.result.current[edit]("user"));
        c.relay.fetch = () => read(c);
        await act(async () => c.ctl.pre.resolve());
        await flush();
        await tick(t, 2_000); // the edit's own debounce
        await flush();
      });
      assert.equal(out.head, "remote,seed,user", "edit dropped the seed union");
      assert.equal(out.fresh, "remote,seed,user");
      assert.equal(out.pending, null);
    });
  }
}

// Seed ownership: edit takeover, equal-union late ACK, generation-only fence.
for (const [getLane, name, dTag, flag, Manager, ids, edit] of [
  [
    () => stars,
    "useChannelStars",
    "channel-stars",
    "starred",
    "ChannelStarSyncManager",
    "starredChannelIds",
    "starChannel",
  ],
  [
    () => mutes,
    "useChannelMutes",
    "channel-mutes",
    "muted",
    "ChannelMuteSyncManager",
    "mutedChannelIds",
    "muteChannel",
  ],
]) {
  for (const mode of [
    "real-edit-absent",
    "real-edit-throws",
    "ack-identical-union",
    "ack-identical-union-r2",
    "generation-only-echo",
  ]) {
    test(`${name} ownership: ${mode}`, async (t) => {
      const lane = getLane(),
        NOW = 1800000000,
        pk = `ownership-${dTag}-${mode}`;
      t.mock.method(Date, "now", () => NOW * 1000);
      const entries = (...keys) => ({
        version: 1,
        channels: Object.fromEntries(
          keys.map((k) => [k, { [flag]: true, updatedAt: NOW }]),
        ),
      });
      const keys = (e) =>
        e ? Object.keys(JSON.parse(e.content).channels).sort().join() : "";
      let head = relayEvent(
        pk,
        dTag,
        NOW + 30,
        entries("remote"),
        "b".repeat(64),
      );
      const boot = deferred(),
        read = deferred(),
        gate = deferred();
      const manager = captureManager(t, lane[Manager]);
      const relay = setup(t, pk, (n) =>
        n === 1 ? boot.promise : n === 2 ? read.promise : [],
      );
      let live,
        preCount = 0,
        encrypts = 0,
        signs = 0,
        submitted = 0;
      relayClient.subscribeLive = async (_, cb) => {
        live = cb;
        return async () => {};
      };
      const pre = lane[Manager].prototype.fetchOwnBlobBeforePublish;
      t.mock.method(
        lane[Manager].prototype,
        "fetchOwnBlobBeforePublish",
        async function (...args) {
          if (++preCount === 1 && mode.startsWith("real-edit"))
            await gate.promise;
          return pre.apply(this, args);
        },
      );
      const invoke = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
        if (
          cmd === "nip44_encrypt_to_self" &&
          ++encrypts === 1 &&
          mode === "generation-only-echo"
        )
          await gate.promise;
        if (cmd === "sign_event") {
          const n = ++signs;
          const event = JSON.parse(await invoke(cmd, args));
          event.id = n.toString(16).padStart(64, "0");
          return JSON.stringify(event);
        }
        return invoke(cmd, args);
      };
      const sends = [];
      relay.publish = async (event) => {
        submitted++;
        sends.push({ keys: keys(event), at: event.created_at, id: event.id });
        if (
          !head ||
          event.created_at > head.created_at ||
          (event.created_at === head.created_at && event.id < head.id)
        )
          head = event;
        if (mode.startsWith("ack-identical-union") && submitted === 1)
          await gate.promise;
        if (mode === "generation-only-echo") live(event);
      };
      window.localStorage.setItem(
        lane.storageKey(pk),
        JSON.stringify(entries("seed")),
      );
      const first = renderHook(() => lane[name](pk, RELAY));
      await until(() => relay.fetches === 2, "mount reads");
      await act(async () => boot.resolve([]));
      await until(() => pendingOf(manager.current) != null, "seed");
      await act(async () => read.resolve(head ? [head] : []));
      await flush();
      await tick(t, 2000);
      await flush();
      if (mode.startsWith("real-edit")) {
        await act(async () => first.result.current[edit]("user"));
        await flush();
        relay.fetch = () => {
          if (mode.endsWith("throws")) throw new Error("read failed");
          return [];
        };
        await act(async () => gate.resolve());
        await flush();
      } else if (mode.startsWith("ack-identical-union")) {
        head = relayEvent(
          pk,
          dTag,
          NOW + 60,
          entries("remote"),
          "c".repeat(64),
        );
        await act(async () => live(head));
        await flush();
        await act(async () => gate.resolve());
        await flush();
      } else if (mode === "generation-only-echo") {
        await act(async () => first.result.current[edit]("user"));
        await flush();
        relay.fetch = () => (head ? [head] : []);
        await act(async () => gate.resolve());
        await flush();
      }
      if (mode === "ack-identical-union-r2") relay.fetch = () => [head];
      for (const ms of [2000, 5000, 10000, 30000]) {
        await tick(t, ms);
        await flush();
      }
      const pending = pendingOf(manager.current),
        m = manager.current;
      const output = {
        dTag,
        mode,
        sends,
        retained: keys(head),
        pending: pending ? Object.keys(pending.channels).sort().join() : null,
        seed: m.seedStore
          ? Object.keys(m.seedStore.channels).sort().join()
          : null,
        gen: m.seedGen,
        seedHead: m.seedHead,
        head: m.head,
      };
      first.unmount();
      window.localStorage.clear();
      relay.fetch = () => (head ? [head] : []);
      const second = renderHook(() => lane[name](pk, RELAY));
      await flush();
      output.fresh = [...second.result.current[ids]].sort().join();
      const want =
        mode.startsWith("real-edit") || mode === "generation-only-echo"
          ? "remote,seed,user"
          : "remote,seed";
      assert.equal(output.retained, want, "retained head lost intended union");
      assert.equal(output.fresh, want, "fresh device misses intended union");
      assert.equal(output.pending, null, "pending stranded");
    });
  }
}

// Canonical head content: successive edits, ACK-to-echo gap, tombstones.
for (const [getLane, name, dTag, flag, Manager, ids, edit, remove] of [
  [
    () => stars,
    "useChannelStars",
    "channel-stars",
    "starred",
    "ChannelStarSyncManager",
    "starredChannelIds",
    "starChannel",
    "unstarChannel",
  ],
  [
    () => mutes,
    "useChannelMutes",
    "channel-mutes",
    "muted",
    "ChannelMuteSyncManager",
    "mutedChannelIds",
    "muteChannel",
    "unmuteChannel",
  ],
]) {
  for (const mode of [
    "two-before-absent",
    "two-before-throws",
    "two-after-absent",
    "two-after-throws",
    "two-after-echo",
    "reconnect",
    "tombstone-tie",
    "tombstone-future",
  ]) {
    test(`${name} carried head content: ${mode}`, async (t) => {
      const lane = getLane(),
        NOW = 1800000000,
        pk = `focused-${dTag}-${mode}`;
      t.mock.method(Date, "now", () => NOW * 1000);
      const entries = (...keys) => ({
        version: 1,
        channels: Object.fromEntries(
          keys.map((k) => [k, { [flag]: true, updatedAt: NOW }]),
        ),
      });
      const payload = (e) => JSON.parse(e.content),
        visible = (hook) => [...hook.result.current[ids]].sort();
      const remote = entries("remote");
      if (mode === "tombstone-older")
        remote.channels.remote.updatedAt = NOW - 1;
      if (mode === "tombstone-future")
        remote.channels.remote.updatedAt = NOW + 30;
      let head = relayEvent(pk, dTag, NOW + 30, remote, "b".repeat(64));
      const boot = deferred(),
        read = deferred(),
        manager = captureManager(t, lane[Manager]);
      const relay = setup(t, pk, (n) =>
        n === 1 ? boot.promise : n === 2 ? read.promise : [],
      );
      let live,
        signs = 0;
      relayClient.subscribeLive = async (_, cb) => {
        live = cb;
        return async () => {};
      };
      const invoke = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
        const result = await invoke(cmd, args);
        if (cmd === "sign_event") {
          const event = JSON.parse(result);
          event.id = (++signs).toString(16).padStart(64, "0");
          return JSON.stringify(event);
        }
        return result;
      };
      const sends = [];
      relay.publish = async (event) => {
        sends.push({
          payload: payload(event),
          at: event.created_at,
          id: event.id,
        });
        if (
          event.created_at > head.created_at ||
          (event.created_at === head.created_at && event.id < head.id)
        )
          head = event;
      };
      window.localStorage.setItem(
        lane.storageKey(pk),
        JSON.stringify(entries("seed")),
      );
      const first = renderHook(() => lane[name](pk, RELAY));
      await until(() => relay.fetches === 2, "mount reads");
      await act(async () => boot.resolve([]));
      await until(() => pendingOf(manager.current) != null, "seed");
      await act(async () => read.resolve([head]));
      await flush();
      assert.deepEqual(
        visible(first),
        ["seed"],
        "R must not already be in React",
      );
      assert.deepEqual(
        Object.keys(pendingOf(manager.current).channels).sort(),
        ["remote", "seed"],
      );
      relay.fetch = () => {
        if (mode.endsWith("throws")) throw new Error("review read failure");
        return mode.endsWith("readable") ? [head] : [];
      };
      await act(async () =>
        first.result.current[mode.startsWith("tombstone") ? remove : edit](
          mode.startsWith("tombstone") ? "remote" : "user",
        ),
      );
      await flush();
      const firstPending = structuredClone(pendingOf(manager.current));
      const output = {
        dTag,
        mode,
        firstPending,
        reactAfterEdit: visible(first),
      };
      if (mode.startsWith("two-after")) {
        await tick(t, 2000);
        await flush();
        output.firstRetained = payload(head);
      }
      if (mode === "two-after-echo") {
        await act(async () => live(head));
        await flush();
      }
      if (mode.startsWith("two-")) {
        await act(async () => first.result.current[edit]("second"));
        await flush();
        output.secondPending = structuredClone(pendingOf(manager.current));
      }
      if (mode === "reconnect") {
        await act(async () => relay.reconnect());
        await flush();
        output.requeued = pendingOf(manager.current) !== null;
        output.seed = manager.current.seedStore;
      }
      await tick(t, 2000);
      await flush();
      output.beforeDelivery = {
        ui: visible(first),
        cache: JSON.parse(window.localStorage.getItem(lane.storageKey(pk))),
        pending: pendingOf(manager.current),
      };
      output.retained = payload(head);
      output.retainedAt = head.created_at;
      output.sends = sends;
      if (mode.startsWith("two-")) {
        relay.fetch = () => [head];
        await tick(t, 5000);
        await flush();
      } // later recovery read
      output.afterDelivery = {
        ui: visible(first),
        cache: JSON.parse(window.localStorage.getItem(lane.storageKey(pk))),
      };
      first.unmount();
      window.localStorage.clear();
      relay.fetch = () => [head];
      const fresh = renderHook(() => lane[name](pk, RELAY));
      await flush();
      output.fresh = visible(fresh);
      const want = entries(
        "remote",
        "seed",
        ...(mode.startsWith("tombstone") ? [] : ["user"]),
        ...(mode.startsWith("two-") ? ["second"] : []),
      );
      if (mode.startsWith("tombstone"))
        want.channels.remote =
          mode === "tombstone-future"
            ? remote.channels.remote
            : { [flag]: false, updatedAt: NOW };
      assert.deepEqual(
        output.retained,
        want,
        "retained payload lost the carried union or conflict result",
      );
      assert.deepEqual(
        output.fresh,
        Object.keys(want.channels)
          .filter((k) => want.channels[k][flag])
          .sort(),
        "fresh-device visible set",
      );
      assert.equal(output.beforeDelivery.pending, null);
      assert.ok(output.retainedAt > NOW + 30, "publish must beat observed R");
      if (mode.startsWith("two-")) {
        assert.deepEqual(
          output.afterDelivery.ui,
          ["remote", "second", "seed", "user"],
          "later recovery lost R",
        );
        assert.deepEqual(output.afterDelivery.cache, want);
      }
      if (mode === "reconnect") {
        assert.equal(output.requeued, true);
        assert.equal(output.seed, null);
      }
    });
  }
}

// Content dedup quiesces under slow ACKs.
for (const [getLane, dTag, flag, Manager, subscribe] of [
  [
    () => stars,
    "channel-stars",
    "starred",
    "ChannelStarSyncManager",
    "subscribeToStars",
  ],
  [
    () => mutes,
    "channel-mutes",
    "muted",
    "ChannelMuteSyncManager",
    "subscribeToMutes",
  ],
]) {
  for (const delay of [100, 3000])
    test(`${dTag} own echo before a ${delay}ms ACK settles`, async (t) => {
      const lane = getLane(),
        NOW = 1800000000,
        pk = `own-delay-${dTag}-${delay}`;
      let elapsed = 0;
      t.mock.method(Date, "now", () => NOW * 1000 + elapsed);
      const store = {
        version: 1,
        channels: { same: { [flag]: true, updatedAt: NOW } },
      };
      const relay = setup(t, pk);
      let head = null,
        live,
        signs = 0;
      const sends = [];
      relayClient.subscribeLive = async (_, cb) => {
        live = cb;
        return async () => {};
      };
      const invoke = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
        const result = await invoke(cmd, args);
        if (cmd !== "sign_event") return result;
        const e = JSON.parse(result);
        e.id = (++signs).toString(16).padStart(64, "0");
        return JSON.stringify(e);
      };
      relay.publish = async (event) => {
        sends.push({ at: event.created_at, elapsed });
        head = event;
        live(event);
        await new Promise((r) => window.setTimeout(r, delay));
      };
      window.localStorage.setItem(lane.storageKey(pk), JSON.stringify(store));
      const captured = captureManager(t, lane[Manager]);
      const hook = renderHook(() =>
        lane[dTag === "channel-stars" ? "useChannelStars" : "useChannelMutes"](
          pk,
          RELAY,
        ),
      );
      await flush();
      const m = captured.current;
      relay.fetch = () => (head ? [head] : []);
      for (let i = 0; i < 200; i++) {
        elapsed += 100;
        await tick(t, 100);
        await flush(2);
      }
      hook.unmount();
      // One seed publish; its echo makes headStore equal the seed, so the rearmed
      // continuation dedups instead of publishing again.
      assert.equal(
        sends.length,
        1,
        "identical own echoes perpetuate seed publications",
      );
      assert.equal(m.seedStore, null);
      assert.equal(pendingOf(m), null);
    });
}

for (const [getLane, dTag, flag, Manager, subscribe] of [
  [
    () => stars,
    "channel-stars",
    "starred",
    "ChannelStarSyncManager",
    "subscribeToStars",
  ],
  [
    () => mutes,
    "channel-mutes",
    "muted",
    "ChannelMuteSyncManager",
    "subscribeToMutes",
  ],
]) {
  test(`${dTag} identical peer seeds with delayed completions settle`, async (t) => {
    const lane = getLane(),
      NOW = 1800000000,
      pk = `peer-acks-${dTag}`;
    let now = NOW;
    t.mock.method(Date, "now", () => now * 1000);
    const store = {
      version: 1,
      channels: { same: { [flag]: true, updatedAt: NOW } },
    };
    const relay = setup(t, pk);
    let head = null,
      signs = 0;
    const callbacks = [],
      jobs = [];
    relayClient.subscribeLive = async (_, cb) => {
      callbacks.push(cb);
      return async () => {};
    };
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
      const result = await invoke(cmd, args);
      if (cmd !== "sign_event") return result;
      const e = JSON.parse(result);
      e.id = (++signs).toString(16).padStart(64, "0");
      return JSON.stringify(e);
    };
    relay.publish = async (event) => {
      const gate = deferred();
      jobs.push({ event, gate });
      if (
        !head ||
        event.created_at > head.created_at ||
        (event.created_at === head.created_at && event.id < head.id)
      )
        head = event;
      await gate.promise;
    };
    const a = new lane[Manager](pk, RELAY),
      b = new lane[Manager](pk, RELAY);
    t.after(() => {
      a.destroy();
      b.destroy();
      for (const j of jobs) j.gate.resolve();
    });
    await a[subscribe](() => {});
    await b[subscribe](() => {});
    await a.bootstrap(store);
    await tick(t, 1);
    await b.bootstrap(structuredClone(store));
    relay.fetch = () => (head ? [head] : []);
    await tick(t, 1999);
    await flush();
    assert.equal(jobs.length, 1);
    // A's accepted event reaches B while A's publish promise is still pending.
    callbacks[1](jobs[0].event);
    await flush();
    let stalled = false;
    for (let i = 1; i <= 8; i++) {
      now += 2;
      await tick(t, 2000);
      await flush();
      if (jobs.length === i) {
        stalled = true;
        break;
      }
      assert.equal(jobs.length, i + 1, "exactly one alternating continuation");
      // B/A's accepted event reaches the other seed owner before its old completion.
      callbacks[(i + 1) % 2](jobs[i].event);
      await flush();
      await act(async () => jobs[i - 1].gate.resolve());
      await flush();
    }
    const output = {
      dTag,
      stalled,
      publications: jobs.map((j) => ({
        at: j.event.created_at,
        payload: JSON.parse(j.event.content),
      })),
      pendingA: pendingOf(a),
      pendingB: pendingOf(b),
    };
    for (const j of jobs) j.gate.resolve();
    await flush();
    for (let i = 0; i < 6; i++) {
      now += 2;
      await tick(t, 2000);
      await flush();
      for (const j of jobs) j.gate.resolve();
      await flush();
    }
    output.afterPromptAcks = {
      count: jobs.length,
      pendingA: pendingOf(a),
      pendingB: pendingOf(b),
    };
    assert.equal(pendingOf(a), null);
    assert.equal(pendingOf(b), null);
    assert.ok(
      stalled,
      "identical peer payloads keep generating alternating publications",
    );
    assert.ok(jobs.length <= 2, "identical peer content republished");
  });
}

for (const [getLane, dTag, flag, Manager, publish, subscribe] of [
  [
    () => stars,
    "channel-stars",
    "starred",
    "ChannelStarSyncManager",
    "publishStars",
    "subscribeToStars",
  ],
  [
    () => mutes,
    "channel-mutes",
    "muted",
    "ChannelMuteSyncManager",
    "publishMutes",
    "subscribeToMutes",
  ],
]) {
  test(`${dTag} undecoded newer head is not represented by older head content`, async (t) => {
    const lane = getLane();
    const NOW = 1800000000;
    const pk = `stale-head-store-${dTag}`;
    t.mock.method(Date, "now", () => NOW * 1000);
    const mine = {
      version: 1,
      channels: { mine: { [flag]: true, updatedAt: NOW } },
    };
    const relay = setup(t, pk);
    let head = null;
    let live;
    relayClient.subscribeLive = async (_, cb) => {
      live = cb;
      return async () => {};
    };
    const foreign = relayEvent(
      pk,
      dTag,
      NOW + 60,
      { version: 1, channels: {} },
      "f".repeat(64),
    );
    const decode = deferred();
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
      if (
        cmd === "nip44_decrypt_from_self" &&
        args.ciphertext === foreign.content
      )
        await decode.promise;
      return invoke(cmd, args);
    };
    relay.publish = async (e) => {
      if (!head || e.created_at > head.created_at) head = e;
    };
    relay.fetch = () => [];
    const m = new lane[Manager](pk, RELAY);
    t.after(() => {
      decode.resolve();
      m.destroy();
    });
    await m[subscribe](() => {});
    m[publish](mine); // our head: headStore = mine
    await tick(t, 2000);
    await flush();
    head = foreign;
    live(foreign); // newer raw head; its decode is held
    await flush();
    m[publish](structuredClone(mine));
    await tick(t, 2000);
    await flush();
    assert.equal(
      relay.published.length,
      2,
      "stale head content suppressed the publish",
    );
    assert.deepEqual(Object.keys(JSON.parse(head.content).channels), ["mine"]);
    assert.ok(head.created_at > NOW + 60);
    assert.equal(pendingOf(m), null);
  });
}
