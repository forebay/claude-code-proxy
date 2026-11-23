import { CATALOG_EVENT, CATALOG_TIMER, CATALOG_TIMER_CHANGE, LOG_LEVEL, STATUS } from "./kinds.js";
import type { CatalogEventAnswer, CatalogEventArgument, CatalogModel, CatalogProvider, CatalogTimer, Handle, LogLine, Provider, Routing, RoutingProfile, Slot } from "./services.js";

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

function isOutOfMemory(error: unknown): boolean {
  return (error as { status?: unknown }).status === STATUS.OUT_OF_MEMORY;
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
  readonly #byName = new Map<string, Provider>();
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
    await this.#requested(CATALOG_EVENT.READ);
    return this.#read();
  }

  /** The snapshot after a step found no model, once it reported NO_MODEL and waited on the round C named. */
  async refreshed(): Promise<Snapshot> {
    await this.#requested(CATALOG_EVENT.NO_MODEL);
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

  /** The names of the implementations offered now, in order, each named once for as long as it lives. */
  #offered(): string[] {
    return this.#options.providers().map((provider) => {
      let name = this.#names.get(provider);
      if (name === undefined) {
        name = `implementation-${this.#byName.size + 1}`;
        this.#names.set(provider, name);
        this.#byName.set(name, provider);
      }
      return name;
    });
  }

  async #read(): Promise<Snapshot> {
    if (this.#released) throw new Error("the catalog was released, so the proxy is stopping");
    const read = await this.#options.routing.catalog_read({ argument: { catalog: this.#handle } });
    const providers = read.providers.map((answer, index) => [answer.provider, this.#byName.get(read.implementations[index]!)!] as const);
    return { names: providers.map(([name]) => name), byName: new Map(providers), catalog: read.providers, slots: read.slots, entries: read.entries };
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
    const waited = answer.wait_round === 0 ? undefined : this.#waitedOn(answer.wait_round);
    this.#acted(answer);
    await waited;
  }

  #event(facts: EventFacts): Promise<CatalogEventAnswer> {
    return this.#options.routing.catalog_event({ argument: { catalog: this.#handle, now: this.#options.now(), ...facts } });
  }

  #waitedOn(round: number): Promise<void> {
    return new Promise((resume) => {
      const waiters = this.#parked.get(round) ?? [];
      waiters.push(resume);
      this.#parked.set(round, waiters);
    });
  }

  #acted(answer: CatalogEventAnswer): void {
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
      if (change !== CATALOG_TIMER_CHANGE.SET) continue;
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
    const facts = kind === CATALOG_TIMER.PERIOD ? { implementations: this.#offered() } : {};
    try {
      this.#acted(await this.#event({ kind: CATALOG_EVENT.TIMER, timer: kind, round, ...facts }));
    } catch (error) {
      this.#warn(error);
      if (isOutOfMemory(error)) setImmediate(() => void this.#fired(kind, round));
    }
  }

  /** @implNote A refused ANSWERED is only logged: its round closes at its own round close timer. */
  async #asked(round: number, implementation: string): Promise<void> {
    let facts: EventFacts;
    try {
      const { provider } = await this.#byName.get(implementation)!.models({});
      facts = { kind: CATALOG_EVENT.ANSWERED, round, implementation, models: provider };
    } catch (error) {
      facts = { kind: CATALOG_EVENT.ANSWERED, round, implementation, failed: 1, message: messageOf(error) };
    }
    if (this.#released) return;
    try {
      this.#acted(await this.#event(facts));
    } catch (error) {
      this.#warn(error);
    }
  }

  #warn(error: unknown): void {
    this.#options.writeLog([{ level: LOG_LEVEL.WARN, message: messageOf(error) }]);
  }
}
