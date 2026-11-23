import { CATALOG_ACTION, CATALOG_EVENT } from "./kinds.js";
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

/** One round of asks: the implementations it asked, whether it closed, and when its close and re-derivation are done. */
interface Round {
  readonly asked: readonly Provider[];
  closed: boolean;
  readonly done: Promise<void>;
  finish(): void;
}

type EventFacts = Pick<CatalogArgument, "failed" | "round_closed" | "message" | "unasked">;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSameList(left: readonly Provider[], right: readonly Provider[]): boolean {
  return left.length === right.length && left.every((provider, index) => provider === right[index]);
}

function newRound(asked: readonly Provider[]): Round {
  let finish = (): void => undefined;
  const done = new Promise<void>((resolve) => (finish = resolve));
  return { asked, closed: false, done, finish };
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
    this.#timer = setInterval(() => void this.#happened(CATALOG_EVENT.PERIOD).catch(() => undefined), options.refreshEveryMilliseconds);
    this.#timer.unref();
  }

  /** The snapshot, once the round a change of the implementations started or joined has closed. */
  async current(): Promise<Snapshot> {
    if (!isSameList(this.#options.providers(), this.#round?.asked ?? [])) await this.#happened(CATALOG_EVENT.PROVIDERS_CHANGED);
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
    this.#round?.finish();
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

  async #decided(event: number, facts: EventFacts = {}): Promise<CatalogAnswer | undefined> {
    if (this.#stopped) return undefined;
    const round = this.#round;
    const argument = { event, now: this.#options.now(), asked: round === undefined ? 0 : 1, last_asked: this.#lastAsked, asking: round !== undefined && !round.closed ? 1 : 0, ...facts };
    const answer = await this.#options.routing.catalog({ argument });
    this.#options.writeLog(answer.log);
    return answer;
  }

  async #happened(event: number): Promise<void> {
    const answer = await this.#decided(event);
    if (answer?.action === CATALOG_ACTION.ASK) await this.#asked(answer.budget_milliseconds);
    else if (answer?.action === CATALOG_ACTION.WAIT) await this.#round?.done;
  }

  #asked(budgetMilliseconds: number): Promise<void> {
    const providers = this.#options.providers();
    for (const known of [...this.#answers.keys()]) if (!providers.includes(known)) this.#answers.delete(known);
    const round = newRound(providers);
    this.#round = round;
    this.#lastAsked = this.#options.now();
    const budget = setTimeout(() => void this.#closed(round), budgetMilliseconds);
    budget.unref();
    void Promise.all(providers.map((provider) => this.#askedOne(round, provider))).then(() => this.#closed(round));
    return round.done.finally(() => clearTimeout(budget));
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
    const answer = await this.#decided(CATALOG_EVENT.ANSWERED, facts).catch(() => undefined);
    if (answer === undefined || answer.drop === 1) return;
    if (models !== undefined) this.#answers.set(provider, models);
    else if (answer.keep_last !== 1) this.#answers.delete(provider);
    if (answer.rederive === 1) await this.#rederived();
  }

  async #closed(round: Round): Promise<void> {
    if (round.closed) return;
    round.closed = true;
    try {
      const answer = await this.#decided(CATALOG_EVENT.ROUND_CLOSED);
      if (answer?.rederive === 1) await this.#rederived();
    } finally {
      round.finish();
    }
  }

  async #rederived(): Promise<void> {
    if (this.#stopped) return;
    try {
      const map = await this.#options.routing.model_map({ argument: { profile: this.#options.profile, settings: this.#options.settings, providers: this.#snapshot().catalog } });
      this.#slots = map.slots;
    } catch (error) {
      const answer = await this.#decided(CATALOG_EVENT.DERIVE_FAILED, { message: messageOf(error) });
      if (answer !== undefined && answer.keep_last !== 1) this.#slots = [];
    }
  }
}
