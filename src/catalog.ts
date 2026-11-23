import { CATALOG_ACTION, CATALOG_EVENT, LOG_LEVEL } from "./kinds.js";
import type { CatalogAnswer, CatalogArgument, CatalogProvider, LogLine, Provider, Routing, RoutingProfile, Slot } from "./services.js";

/** What routing reads of the providers as of their last answers. */
export interface Snapshot {
  readonly names: string[];
  readonly byName: ReadonlyMap<string, Provider>;
  readonly catalog: CatalogProvider[];
  readonly slots: readonly Slot[];
}

export interface CatalogOptions {
  readonly providers: () => Provider[];
  readonly routing: Routing;
  readonly profile: RoutingProfile;
  readonly settings: unknown;
  readonly refreshEveryMilliseconds: number;
  readonly writeLog: (lines: readonly LogLine[]) => void;
  readonly now: () => number;
}

/**
 * One round of asks: the implementations it asked, its budget timer, whether it closed or a newer round superseded
 * it, and when its close and re-derivation are done.
 */
interface Round {
  readonly asked: readonly Provider[];
  budget?: NodeJS.Timeout;
  closed: boolean;
  superseded: boolean;
  readonly done: Promise<void>;
  finish(): void;
}

type EventFacts = Pick<CatalogArgument, "failed" | "round_closed" | "message" | "unasked" | "changed">;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSameList(left: readonly Provider[], right: readonly Provider[]): boolean {
  return left.length === right.length && left.every((provider, index) => provider === right[index]);
}

function newRound(asked: readonly Provider[]): Round {
  let finish = (): void => undefined;
  const done = new Promise<void>((resolve) => (finish = resolve));
  return { asked, closed: false, superseded: false, done, finish };
}

/**
 * The providers' models, kept as `routing.catalog` decides one event at a time: this holds only the timer, the asks,
 * the models each implementation answered and the facts of the rounds.
 */
export class Catalog {
  readonly #options: CatalogOptions;
  readonly #answers = new Map<Provider, CatalogProvider>();
  readonly #timer: NodeJS.Timeout;
  #round: Round | undefined;
  #lastAsked = 0;
  #slots: readonly Slot[] = [];
  #stopped = false;

  constructor(options: CatalogOptions) {
    this.#options = options;
    this.#timer = setInterval(() => this.#logged(this.#happened(CATALOG_EVENT.PERIOD)), options.refreshEveryMilliseconds);
    this.#timer.unref();
  }

  /** The snapshot a request reads, once it reported READ and waited as C answered. */
  async current(): Promise<Snapshot> {
    const changed = isSameList(this.#options.providers(), this.#round?.asked ?? []) ? 0 : 1;
    await this.#happened(CATALOG_EVENT.READ, { changed });
    return this.#snapshot();
  }

  /** The snapshot after a step found no model, as the round C answers for it leaves it. */
  async refreshed(): Promise<Snapshot> {
    await this.#happened(CATALOG_EVENT.NO_MODEL);
    return this.#snapshot();
  }

  stop(): void {
    this.#stopped = true;
    clearInterval(this.#timer);
    if (this.#round !== undefined) this.#ended(this.#round);
  }

  #snapshot(): Snapshot {
    const entries = (this.#round?.asked ?? []).flatMap((provider) => {
      const answer = this.#answers.get(provider);
      return answer === undefined ? [] : [[answer.provider, provider, answer] as const];
    });
    return {
      names: entries.map(([name]) => name),
      byName: new Map(entries.map(([name, provider]) => [name, provider])),
      catalog: entries.map(([, , answer]) => answer),
      slots: this.#slots,
    };
  }

  /**
   * C's answer to an event of `round`, or undefined once stopped or when C refused it, which is logged and ends
   * `round` alone.
   */
  async #decided(event: number, round: Round | undefined, facts: EventFacts = {}): Promise<CatalogAnswer | undefined> {
    if (this.#stopped) return undefined;
    const current = this.#round;
    const argument = { event, now: this.#options.now(), asked: current === undefined ? 0 : 1, last_asked: this.#lastAsked, asking: current !== undefined && !current.closed ? 1 : 0, ...facts };
    try {
      const answer = await this.#options.routing.catalog({ argument });
      this.#options.writeLog(answer.log);
      return answer;
    } catch (error) {
      this.#warn(error);
      if (round !== undefined) this.#ended(round);
      return undefined;
    }
  }

  #warn(error: unknown): void {
    const { detail } = error as { detail?: unknown };
    this.#options.writeLog([{ level: LOG_LEVEL.WARN, message: typeof detail === "string" ? detail : messageOf(error) }]);
  }

  #logged(work: Promise<unknown>): void {
    work.catch((error: unknown) => this.#warn(error));
  }

  /** @implNote A superseded round ends with the round that superseded it, whose waiters its own waiters became. */
  #ended(round: Round): void {
    clearTimeout(round.budget);
    if (round.superseded) return;
    round.closed = true;
    round.finish();
  }

  async #happened(event: number, facts: EventFacts = {}): Promise<void> {
    const round = this.#round;
    const answer = await this.#decided(event, round, facts);
    if (answer?.action === CATALOG_ACTION.ASK) await this.#asked(answer.budget_milliseconds);
    else if (answer?.action === CATALOG_ACTION.WAIT) await this.#round?.done;
  }

  #asked(budgetMilliseconds: number): Promise<void> {
    const providers = this.#options.providers();
    for (const known of [...this.#answers.keys()]) if (!providers.includes(known)) this.#answers.delete(known);
    const round = newRound(providers);
    this.#superseded(round);
    this.#round = round;
    this.#lastAsked = this.#options.now();
    round.budget = setTimeout(() => this.#logged(this.#closed(round)), budgetMilliseconds);
    round.budget.unref();
    this.#logged(Promise.all(providers.map((provider) => this.#askedOne(round, provider))).then(() => this.#closed(round)));
    return round.done;
  }

  /** Marks the open round, if any, superseded by `newer`: its timer stops, and its waiters wait for `newer`. */
  #superseded(newer: Round): void {
    const older = this.#round;
    if (older === undefined || older.closed) return;
    clearTimeout(older.budget);
    older.superseded = true;
    void newer.done.then(() => older.finish());
  }

  async #askedOne(round: Round, provider: Provider): Promise<void> {
    let models: CatalogProvider | undefined;
    let message: string | undefined;
    try {
      models = (await provider.models({})).provider;
    } catch (error) {
      message = messageOf(error);
    }
    const unasked = this.#round?.asked.includes(provider) === true ? 0 : 1;
    const facts = { failed: models === undefined ? 1 : 0, round_closed: round.closed ? 1 : 0, unasked, ...(message === undefined ? {} : { message }) };
    const answer = await this.#decided(CATALOG_EVENT.ANSWERED, round, facts);
    if (answer === undefined || answer.drop === 1) return;
    if (models !== undefined) this.#answers.set(provider, models);
    else if (answer.keep_last !== 1) this.#answers.delete(provider);
    if (answer.rederive === 1) await this.#rederived(round);
  }

  async #closed(round: Round): Promise<void> {
    if (round.closed || round.superseded) return;
    round.closed = true;
    try {
      const answer = await this.#decided(CATALOG_EVENT.ROUND_CLOSED, round);
      if (answer?.rederive === 1) await this.#rederived(round);
    } finally {
      this.#ended(round);
    }
  }

  async #rederived(round: Round): Promise<void> {
    if (this.#stopped) return;
    try {
      const map = await this.#options.routing.model_map({ argument: { profile: this.#options.profile, settings: this.#options.settings, providers: this.#snapshot().catalog } });
      this.#slots = map.slots;
    } catch (error) {
      const answer = await this.#decided(CATALOG_EVENT.DERIVE_FAILED, round, { message: messageOf(error) });
      if (answer !== undefined && answer.keep_last !== 1) this.#slots = [];
    }
  }
}
