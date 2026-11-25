import { afterEach, describe, expect, it, vi } from "vitest";
import { Catalog } from "../src/catalog.js";
import type { CatalogEventAnswer, LogLine, Provider, Routing, RoutingEnums, RoutingProfile } from "../src/services.js";

interface Pending {
  resolve(answer: CatalogEventAnswer): void;
}

/** Settles with "settled" once `work` settles, or "hung" when it is still pending after a few turns of the loop. */
async function settledOrHung(work: Promise<unknown>): Promise<string> {
  const turns = new Promise<string>((resolve) => setImmediate(() => setImmediate(() => resolve("hung"))));
  return Promise.race([work.then(() => "settled", () => "settled"), turns]);
}

/**
 * A routing whose catalog events stay in flight until the test answers them, which no real call does: the native
 * catalog answers within the call, so only a fake can hold a release between an event and its answer.
 */
function heldRouting(pending: Pending[], handleReleases: { count: number }): Routing {
  return {
    catalog_open: async () => ({ catalog: { release: () => (handleReleases.count += 1) }, timers: [] }),
    catalog_event: () => new Promise<CatalogEventAnswer>((resolve) => pending.push({ resolve })),
    catalog_read: async () => ({ implementations: [], providers: [], slots: [], entries: [] }),
  } as unknown as Routing;
}

/** The fake routing's own enums, which its answers are written in. */
const ENUMS: RoutingEnums = {
  forebay_catalog_event_kind: { FOREBAY_CATALOG_READ: 1, FOREBAY_CATALOG_NO_MODEL: 2, FOREBAY_CATALOG_ANSWERED: 3, FOREBAY_CATALOG_TIMER: 4 },
  forebay_catalog_timer_kind: { FOREBAY_CATALOG_ROUND_CLOSE: 1, FOREBAY_CATALOG_PERIOD: 2 },
  forebay_catalog_timer_change: { FOREBAY_CATALOG_SET: 1 },
  forebay_log_level: { FOREBAY_LOG_WARN: 2 },
  weivel_status: { WEIVEL_STATUS_OUT_OF_MEMORY: 4 },
} as Partial<RoutingEnums> as RoutingEnums;

const ASKING_ANSWER: CatalogEventAnswer = {
  wait_round: 1,
  ask_round: 1,
  asks: ["implementation-1"],
  timers: [{ change: ENUMS.forebay_catalog_timer_change.FOREBAY_CATALOG_SET, kind: ENUMS.forebay_catalog_timer_kind.FOREBAY_CATALOG_ROUND_CLOSE, round: 1, due: 2_000 }],
  released: [],
  log: [],
};

afterEach(() => {
  vi.useRealTimers();
});

describe("the catalog's I/O around its release", () => {
  it("lets a request whose READ was in flight at the release read now, setting no timer and starting no ask", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending: Pending[] = [];
    const handleReleases = { count: 0 };
    let asks = 0;
    const provider = { models: async () => ((asks += 1), { provider: { provider: "alpha" } }) } as unknown as Provider;
    const logged: LogLine[] = [];
    const catalog = await Catalog.opened({ providers: () => [provider], routing: heldRouting(pending, handleReleases), enums: ENUMS, profile: {} as RoutingProfile, settings: {}, writeLog: (lines) => logged.push(...lines), now: () => 0 });

    const reading = catalog.current();
    catalog.release();
    pending[0]!.resolve(ASKING_ANSWER);

    expect(await settledOrHung(reading)).toBe("settled");
    await expect(reading).rejects.toThrow("the catalog was released");
    expect(asks).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(handleReleases.count).toBe(1);
  });
});
