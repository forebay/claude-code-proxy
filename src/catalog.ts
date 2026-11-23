import type { CatalogProvider, LimitsAnswer, Provider, Routing, RoutingProfile, Slot } from "./services.js";

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
  readonly settings: Record<string, unknown>;
  readonly limits: LimitsAnswer;
  readonly warn: (message: string) => void;
  readonly now: () => number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withinBudget(work: Promise<unknown>, milliseconds: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const spent = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
  return Promise.race([work.then(() => undefined), spent]).finally(() => clearTimeout(timer));
}

/**
 * The providers' models, asked of every implementation the proxy sees, within the budget C sets, again whenever the
 * set of implementations changes, at most once per C's interval when a request finds no model, and every period C
 * names. A provider that fails an ask keeps the models it answered last.
 */
export class Catalog {
  readonly #options: CatalogOptions;
  readonly #answers = new Map<Provider, CatalogProvider>();
  #asked: Provider[] = [];
  #slots: readonly Slot[] = [];
  #lastAsked = Number.NEGATIVE_INFINITY;
  #shared: Promise<void> | undefined;
  readonly #timer: NodeJS.Timeout;

  constructor(options: CatalogOptions) {
    this.#options = options;
    this.#timer = setInterval(() => void this.#askAll(), options.limits.refresh_every_milliseconds);
    this.#timer.unref();
  }

  /** The snapshot, asking first when an implementation joined or left since the last ask. */
  async current(): Promise<Snapshot> {
    const providers = this.#options.providers();
    const changed = providers.length !== this.#asked.length || providers.some((provider, index) => provider !== this.#asked[index]);
    if (changed) await this.#askAll();
    return this.#snapshot();
  }

  /** Asks again for a request that found no model, unless an ask was made within C's interval. */
  async refresh(): Promise<Snapshot> {
    if (this.#shared === undefined && this.#options.now() - this.#lastAsked >= this.#options.limits.rederive_interval_milliseconds) {
      await this.#askAll();
    } else if (this.#shared !== undefined) {
      await this.#shared;
    }
    return this.#snapshot();
  }

  stop(): void {
    clearInterval(this.#timer);
  }

  #snapshot(): Snapshot {
    const entries = this.#asked.flatMap((provider) => {
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

  #askAll(): Promise<void> {
    this.#shared ??= this.#ask().finally(() => (this.#shared = undefined));
    return this.#shared;
  }

  async #ask(): Promise<void> {
    const providers = this.#options.providers();
    this.#asked = providers;
    this.#lastAsked = this.#options.now();
    for (const known of [...this.#answers.keys()]) if (!providers.includes(known)) this.#answers.delete(known);
    let late = false;
    const asked = Promise.all(providers.map((provider) => this.#askOne(provider, () => late)));
    await withinBudget(asked, this.#options.limits.models_budget_milliseconds);
    late = true;
    await this.#rederive();
  }

  async #askOne(provider: Provider, isLate: () => boolean): Promise<void> {
    try {
      const answer = await provider.models({});
      this.#answers.set(provider, answer.provider);
      if (isLate()) await this.#rederive();
    } catch (error) {
      this.#options.warn(`a provider answered no models: ${messageOf(error)}`);
    }
  }

  async #rederive(): Promise<void> {
    try {
      const map = await this.#options.routing.model_map({ argument: { profile: this.#options.profile, settings: this.#options.settings, providers: this.#snapshot().catalog } });
      this.#slots = map.slots ?? [];
    } catch (error) {
      this.#options.warn(`the model map could not be derived, so routing keeps the last one: ${messageOf(error)}`);
    }
  }
}
