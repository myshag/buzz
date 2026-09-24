import { relayClient } from "@/shared/api/relayClient";
import {
  nip44DecryptFromSelf,
  nip44EncryptToSelf,
  signRelayEvent,
} from "@/shared/api/tauri";
import type { RelayEvent } from "@/shared/api/types";
import { KIND_CHANNEL_MUTES } from "@/shared/constants/kinds";
import {
  mergeStores,
  parseMutePayload,
  type ChannelMuteStore,
} from "./channelMutesStorage";
import {
  advanceWatermark,
  readWatermark,
  runBootstrap,
  type FetchResult,
} from "./sidebarSyncWatermark";

const D_TAG = "channel-mutes";
const BLOB_TYPE = D_TAG;
const DEBOUNCE_MS = 2_000;

export type RemoteMutes = {
  store: ChannelMuteStore;
  createdAt: number;
  eventId: string;
};

async function decryptAndParse(event: RelayEvent): Promise<RemoteMutes | null> {
  try {
    const plaintext = await nip44DecryptFromSelf(event.content);
    const store = parseMutePayload(JSON.parse(plaintext));
    if (!store) return null;
    return { store, createdAt: event.created_at, eventId: event.id };
  } catch {
    return null;
  }
}

/** A relay head's identity, ordered as the relay picks its winner. */
type HeadId = { createdAt: number; id: string };

const headOf = (event: RelayEvent): HeadId => ({
  createdAt: event.created_at,
  id: event.id,
});

/** `a` beats `b`: later `created_at`, then lower ID (replaceable.rs). */
const beats = (a: HeadId, b: HeadId | null): boolean =>
  b === null ||
  a.createdAt > b.createdAt ||
  (a.createdAt === b.createdAt && a.id < b.id);

export class ChannelMuteSyncManager {
  private pubkey: string;
  private relayUrl: string;
  private debounceTimer: number | null = null;
  private lastRemoteCreatedAt: number;
  private pendingStore: ChannelMuteStore | null = null;
  private lastPublishedStore: ChannelMuteStore | null = null;
  /** The canonical relay head observed so far. */
  private head: HeadId | null = null;
  /**
   * The bootstrap seed, queued because the relay had no head, unioned with
   * every canonical head decoded since (`seedHead`).  Non-null exactly while
   * the seed is the pending work.  `seedGen` advances on every seed change;
   * a seed job publishes only while its generation is current and its
   * folded head is the canonical head.
   */
  private seedStore: ChannelMuteStore | null = null;
  private seedHead: HeadId | null = null;
  private seedGen = 0;
  private destroyed = false;

  constructor(pubkey: string, relayUrl: string) {
    this.pubkey = pubkey;
    this.relayUrl = relayUrl;
    this.lastRemoteCreatedAt = readWatermark(pubkey, BLOB_TYPE, relayUrl);
  }

  async fetchRemoteMutes(): Promise<FetchResult<RemoteMutes>> {
    try {
      const events = await relayClient.fetchEvents({
        kinds: [KIND_CHANNEL_MUTES],
        authors: [this.pubkey],
        "#d": [D_TAG],
        limit: 1,
      });
      if (events.length === 0 || events[0].pubkey !== this.pubkey) {
        return { status: "absent" };
      }
      const event = events[0];
      this.recordRemoteHead(event);
      const result = await decryptAndParse(event);
      this.foldIntoSeed(headOf(event), result?.store ?? null);
      if (!result) {
        return { status: "failed", createdAt: event.created_at };
      }
      return {
        status: "found",
        data: result,
        createdAt: result.createdAt,
        eventId: result.eventId,
      };
    } catch {
      return { status: "failed" };
    }
  }

  private recordRemoteHead(event: RelayEvent): void {
    if (event.created_at > this.lastRemoteCreatedAt) {
      this.lastRemoteCreatedAt = event.created_at;
    }
    advanceWatermark(this.pubkey, BLOB_TYPE, this.relayUrl, event.created_at);
    if (beats(headOf(event), this.head)) this.head = headOf(event);
  }

  /**
   * Folds the canonical head into a pending seed, as a new generation that
   * re-arms the seed job, so the seed never publishes without it.  A head
   * that cannot be decoded cannot be folded, so the seed is abandoned rather
   * than published over it; its entries stay in the local cache only.
   */
  private foldIntoSeed(head: HeadId, remote: ChannelMuteStore | null): void {
    if (this.seedStore === null || this.head?.id !== head.id) return;
    if (this.seedHead?.id === head.id) return;
    this.seedGen++;
    if (remote === null) {
      this.clearTimer();
      this.pendingStore = this.seedStore = null;
      return;
    }
    this.seedHead = head;
    this.seedStore = mergeStores(this.seedStore, remote);
    this.arm(this.seedStore, this.seedGen);
  }

  /** Remote applies supersede real edits; a seed already holds the head. */
  cancelPendingMutePublish(): void {
    if (this.seedStore === null) this.clearTimer();
  }

  private clearTimer(): void {
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  getPendingMuteStore(): ChannelMuteStore | null {
    return this.pendingStore;
  }

  publishMutes(store: ChannelMuteStore): void {
    if (store === this.seedStore) {
      this.arm(store, this.seedGen); // reconnect requeue keeps provenance
      return;
    }
    // A real edit supersedes the seed: any seed job becomes obsolete.
    if (this.seedStore !== null) {
      this.seedStore = null;
      this.seedGen++;
    }
    this.arm(store, null);
  }

  /** `gen` is the seed generation a seed job was armed with; null for edits. */
  private arm(store: ChannelMuteStore, gen: number | null): void {
    this.pendingStore = store;
    this.clearTimer();
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      void this.doPublish(store, gen);
    }, DEBOUNCE_MS);
  }

  private async fetchOwnBlobBeforePublish(
    store: ChannelMuteStore,
  ): Promise<ChannelMuteStore> {
    try {
      const events = await relayClient.fetchEvents({
        kinds: [KIND_CHANNEL_MUTES],
        authors: [this.pubkey],
        "#d": [D_TAG],
        limit: 1,
      });
      if (events.length === 0 || events[0].pubkey !== this.pubkey) return store;
      const event = events[0];
      // Record the raw head before decrypt on the pre-publish path too.
      this.recordRemoteHead(event);
      const remote = await decryptAndParse(event);
      this.foldIntoSeed(headOf(event), remote?.store ?? null);
      if (!remote) return store;
      return mergeStores(store, remote.store);
    } catch {
      return store;
    }
  }

  private isIdenticalToLastPublished(store: ChannelMuteStore): boolean {
    if (!this.lastPublishedStore) return false;
    const lastKeys = Object.keys(this.lastPublishedStore.channels);
    const currentKeys = Object.keys(store.channels);
    if (lastKeys.length !== currentKeys.length) return false;
    for (const key of currentKeys) {
      const last = this.lastPublishedStore.channels[key];
      const current = store.channels[key];
      if (
        !last ||
        last.muted !== current.muted ||
        last.updatedAt !== current.updatedAt
      )
        return false;
    }
    return true;
  }

  private async doPublish(
    store: ChannelMuteStore,
    gen: number | null,
  ): Promise<void> {
    // A seed job whose generation was superseded, or whose folded head is no
    // longer canonical, exits silently: the fold that superseded it owns the
    // re-armed seed and its pending state.
    const stale = () =>
      gen !== null &&
      (gen !== this.seedGen || this.seedHead?.id !== this.head?.id);
    try {
      const merged = await this.fetchOwnBlobBeforePublish(store);
      // Guard: manager may have been destroyed while fetchOwnBlobBeforePublish
      // was awaited (community switch during in-flight fetch). If so, abort
      // before touching the relay.
      if (this.destroyed || stale()) return;
      if (this.isIdenticalToLastPublished(merged)) {
        this.settle(store, gen);
        return;
      }
      const payload = {
        version: 1,
        channels: merged.channels,
      };
      const ciphertext = await nip44EncryptToSelf(JSON.stringify(payload));
      const createdAt = Math.max(
        Math.floor(Date.now() / 1_000),
        this.lastRemoteCreatedAt + 1,
      );
      const event = await signRelayEvent({
        kind: KIND_CHANNEL_MUTES,
        content: ciphertext,
        createdAt,
        tags: [
          ["d", D_TAG],
          ["t", D_TAG], // relay discoverability; not used in our filters
        ],
      });
      if (this.destroyed || stale()) return;
      await relayClient.publishEvent(
        event,
        "Timed out publishing channel mutes.",
        "Failed to publish channel mutes.",
      );
      this.recordRemoteHead(event);
      this.lastPublishedStore = merged;
      this.settle(store, gen);
      // A newer seed generation (folded while this was in flight) must also
      // carry our own published head.
      this.foldIntoSeed(headOf(event), merged);
    } catch (error) {
      console.warn("[channelMutesSync] publish failed:", error);
    }
  }

  /** Retires only the pending work (and seed generation) this job owned. */
  private settle(store: ChannelMuteStore, gen: number | null): void {
    if (gen !== null && gen === this.seedGen) this.seedStore = null;
    if (this.pendingStore === store) this.pendingStore = null;
  }

  async subscribeToMutes(
    onUpdate: (remote: RemoteMutes) => void,
  ): Promise<() => Promise<void>> {
    return relayClient.subscribeLive(
      {
        kinds: [KIND_CHANNEL_MUTES],
        authors: [this.pubkey],
        "#d": [D_TAG],
        limit: 0,
      },
      (event: RelayEvent) => {
        if (event.pubkey !== this.pubkey) return;
        // Record the raw head before decrypt so an undecryptable live event
        // still advances the watermark and blocks future seed-publish.
        this.recordRemoteHead(event);
        void decryptAndParse(event).then((result) => {
          if (this.destroyed) return;
          this.foldIntoSeed(headOf(event), result?.store ?? null);
          if (result) {
            onUpdate(result);
          }
        });
      },
    );
  }

  /**
   * Fetches the remote blob on first mount, records the remote head, and
   * delegates the seed/hold/apply-remote decision to `runBootstrap`.
   */
  async bootstrap(localStore: ChannelMuteStore) {
    const fetchResult = await this.fetchRemoteMutes();
    return runBootstrap({
      fetchResult,
      lastHead: this.lastRemoteCreatedAt,
      localStore,
      isLocalNonEmpty: (s) => Object.keys(s.channels).length > 0,
      publishFn: (s) => {
        this.seedStore = s;
        this.seedHead = null;
        this.seedGen++;
        this.arm(s, this.seedGen);
      },
    });
  }

  destroy(): void {
    // Cancel any pending publish and mark this manager as destroyed so any
    // in-flight doPublish() calls abort before reaching relayClient.
    // Pending debounce-window changes are intentionally dropped: flushing
    // could publish relay A's state to relay B via the shared relayClient
    // singleton. Local entries survive because the apply/publish paths merge
    // per-entry via mergeStores, so no local work is permanently lost.
    this.destroyed = true;
    this.clearTimer();
    this.pendingStore = this.seedStore = null;
  }
}
