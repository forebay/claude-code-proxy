import type { CatalogEventAnswer, CatalogEventArgument, CatalogModel, CatalogProvider, CatalogTimer, Handle, LogLine, Provider, Routing, RoutingEnums, RoutingProfile, Slot } from "./services.js";

/** What routing reads of the providers as the catalog stands. */
export interface Snapshot {
  readonly names: string[];
  readonly byName: ReadonlyMap<string, Provider>;
  readonly catalog: readonly CatalogProvider[];
  readonly slots: readonly Slot[];
  readonly entries: readonly CatalogModel[];
}

export interface CatalogOptions {
  readonly providers: () => Provider[];
  readonly routing: Routing;
  readonly enums: RoutingEnums;
  readonly profile: RoutingProfile;
  readonly settings: unknown;
  readonly writeLog: (lines: readonly LogLine[]) => void;
  readonly now: () => number;
}

type EventFacts = Omit<CatalogEventArgument, "catalog" | "now">;

function messageOf(error: unknown): string {
  const { detail } = error as { detail?: unknown };
  if (typeof detail === "string") return detail;
  return error instanceof Error ? error.message : String(error);
}

function isOutOfMemory(error: unknown, enums: RoutingEnums): boolean {
  return (error as { status?: unknown }).status === enums.weivel_status.WEIVEL_STATUS_OUT_OF_MEMORY;
}

function timerKey(kind: number, round: number): string {
  return `${kind}:${round}`;
}

/**
 * The providers' models, kept by forebay-library's catalog object: this performs the asks it names, sets and clears
 * the timers it names and parks each request on the round it names until it lists that round as released.
 */
export class Catalog {
  readonly #options: CatalogOptions;
  readonly #handle: Handle;
  readonly #timers = new Map<string, NodeJS.Timeout>();
  readonly #parked = new Map<number, (() => void)[]>();
  readonly #names = new WeakMap<Provider, string>();
  #byName = new Map<string, Provider>();
  #named = 0;
  #released = false;

  private constructor(options: CatalogOptions, handle: Handle) {
    this.#options = options;
    this.#handle = handle;
  }

  static async opened(options: CatalogOptions): Promise<Catalog> {
    const { catalog, timers } = await options.routing.catalog_open({ argument: { now: options.now(), profile: options.profile, settings: options.settings } });
    const opened = new Catalog(options, catalog);
    opened.#timed(timers);
    return opened;
  }

  /** The snapshot a request reads, once it reported READ and waited on the round C named. */
  async current(): Promise<Snapshot> {
    await this.#requested(this.#options.enums.forebay_catalog_event_kind.FOREBAY_CATALOG_READ);
    return this.#read();
  }

  /** The snapshot after a step found no model, once it reported NO_MODEL and waited on the round C named. */
  async refreshed(): Promise<Snapshot> {
    await this.#requested(this.#options.enums.forebay_catalog_event_kind.FOREBAY_CATALOG_NO_MODEL);
    return this.#read();
  }

  release(): void {
    if (this.#released) return;
    this.#released = true;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    for (const waiters of this.#parked.values()) waiters.forEach((resume) => resume());
    this.#parked.clear();
    this.#handle.release();
  }

  /**
   * The names of the implementations offered now, in order, each named once for as long as it lives.
   * @implNote Only the implementations offered now are held by name, so one that left can be collected.
   */
  #offered(): string[] {
    const offered = this.#options.providers().map((provider) => {
      let name = this.#names.get(provider);
      if (name === undefined) {
        this.#named += 1;
        name = `implementation-${this.#named}`;
        this.#names.set(provider, name);
      }
      return [name, provider] as const;
    });
    this.#byName = new Map(offered);
    return offered.map(([name]) => name);
  }

  async #read(): Promise<Snapshot> {
    if (this.#released) throw new Error("the catalog was released, so the proxy is stopping");
    const read = await this.#options.routing.catalog_read({ argument: { catalog: this.#handle } });
    const names = read.providers.map((answer) => answer.provider);
    const byName = new Map<string, Provider>();
    read.implementations.forEach((implementation, index) => {
      const provider = this.#byName.get(implementation);
      if (provider !== undefined) byName.set(names[index]!, provider);
    });
    return { names, byName, catalog: read.providers, slots: read.slots, entries: read.entries };
  }

  async #requested(kind: number): Promise<void> {
    if (this.#released) return;
    let answer: CatalogEventAnswer;
    try {
      answer = await this.#event({ kind, implementations: this.#offered() });
    } catch (error) {
      this.#warn(error);
      return;
    }
    if (this.#released) return;
    const waited = answer.wait_round === 0 ? undefined : this.#waitedOn(answer.wait_round);
    this.#acted(answer);
    await waited;
  }

  #event(facts: EventFacts): Promise<CatalogEventAnswer> {
    return this.#options.routing.catalog_event({ argument: { catalog: this.#handle, now: this.#options.now(), ...facts } });
  }

  #waitedOn(round: number): Promise<void> {
    if (this.#released) return Promise.resolve();
    return new Promise((resume) => {
      const waiters = this.#parked.get(round) ?? [];
      waiters.push(resume);
      this.#parked.set(round, waiters);
    });
  }

  #acted(answer: CatalogEventAnswer): void {
    if (this.#released) return;
    this.#options.writeLog(answer.log);
    this.#timed(answer.timers);
    for (const implementation of answer.asks) void this.#asked(answer.ask_round, implementation);
    for (const round of answer.released) {
      this.#parked.get(round)?.forEach((resume) => resume());
      this.#parked.delete(round);
    }
  }

  #timed(timers: readonly CatalogTimer[]): void {
    for (const { change, kind, round, due } of timers) {
      const key = timerKey(kind, round);
      clearTimeout(this.#timers.get(key));
      this.#timers.delete(key);
      if (change !== this.#options.enums.forebay_catalog_timer_change.FOREBAY_CATALOG_SET) continue;
      const timer = setTimeout(() => {
        this.#timers.delete(key);
        void this.#fired(kind, round);
      }, Math.max(0, due - this.#options.now()));
      timer.unref();
      this.#timers.set(key, timer);
    }
  }

  /**
   * @implNote Only an OUT_OF_MEMORY is reported again, at once: nothing else would close the round or re-set the
   * period. Any other refusal is the host's misuse, logged once.
   */
  async #fired(kind: number, round: number): Promise<void> {
    if (this.#released) return;
    const facts = kind === this.#options.enums.forebay_catalog_timer_kind.FOREBAY_CATALOG_PERIOD ? { implementations: this.#offered() } : {};
    let answer: CatalogEventAnswer;
    try {
      answer = await this.#event({ kind: this.#options.enums.forebay_catalog_event_kind.FOREBAY_CATALOG_TIMER, timer: kind, round, ...facts });
    } catch (error) {
      this.#warn(error);
      if (isOutOfMemory(error, this.#options.enums)) setImmediate(() => void this.#fired(kind, round));
      return;
    }
    if (!this.#released) this.#acted(answer);
  }

  /** @implNote A refused ANSWERED is only logged: its round closes at its own round close timer. */
  async #asked(round: number, implementation: string): Promise<void> {
    let facts: EventFacts;
    try {
      const { provider } = await this.#byName.get(implementation)!.models({});
      facts = { kind: this.#options.enums.forebay_catalog_event_kind.FOREBAY_CATALOG_ANSWERED, round, implementation, models: provider };
    } catch (error) {
      facts = { kind: this.#options.enums.forebay_catalog_event_kind.FOREBAY_CATALOG_ANSWERED, round, implementation, failed: 1, message: messageOf(error) };
    }
    if (this.#released) return;
    let answer: CatalogEventAnswer;
    try {
      answer = await this.#event(facts);
    } catch (error) {
      this.#warn(error);
      return;
    }
    if (!this.#released) this.#acted(answer);
  }

  #warn(error: unknown): void {
    try {
      this.#options.writeLog([{ level: this.#options.enums.forebay_log_level.FOREBAY_LOG_WARN, message: messageOf(error) }]);
    } catch {
      // A warning that cannot be written must not turn a handled refusal into an unhandled rejection.
    }
  }
}
