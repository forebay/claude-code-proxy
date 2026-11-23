/**
 * The shapes weivel/typescript's binding gives the definitions this plugin calls: each operation one async method
 * taking its input parameters by name and answering its answer struct without its sizes, counts and storage, a NULL
 * text left out and a NULL array answered empty. Only the members this plugin reads or writes are named.
 */

export interface Pair {
  readonly name: string;
  readonly value: string;
}

export interface Handle {
  release(): void;
}

export interface CatalogModel {
  readonly id: string;
  readonly name?: string | null;
  readonly has_context?: number;
  readonly context?: number;
  readonly has_output?: number;
  readonly output?: number;
}

export interface CatalogProvider {
  readonly provider: string;
  readonly models?: readonly CatalogModel[];
  readonly has_ranking?: number;
  readonly ranking?: readonly string[];
  readonly default_model?: string | null;
}

export interface RoutingProfile {
  readonly tier_source_provider: unknown;
  readonly tier_order: unknown;
  readonly tier_fallback: unknown;
  readonly tier_regex: unknown;
  readonly native_model_pattern: unknown;
  readonly default_context: unknown;
  readonly default_output: unknown;
}

export interface Slot {
  readonly slot: string;
  readonly chain: readonly unknown[];
}

export interface LogLine {
  readonly level: number;
  readonly message: string;
}

export interface Report {
  readonly kind: number;
  readonly after_bytes?: number;
  readonly message?: string | null;
  readonly status?: number;
  readonly headers?: readonly Pair[];
  readonly has_retry_after?: number;
  readonly retry_after_milliseconds?: number;
  readonly now?: number;
}

export interface StepArgument {
  readonly providers: readonly string[];
  readonly walk?: Handle;
  readonly profile: RoutingProfile;
  readonly slots: readonly Slot[];
  readonly catalog: readonly CatalogProvider[];
  readonly model?: string | null;
  readonly pass_through: number;
  readonly refreshed: number;
  readonly login_command: unknown;
  readonly settings_file: unknown;
  readonly report?: Report;
}

export interface StepAnswer {
  readonly kind: number;
  readonly provider?: string;
  readonly model?: string;
  readonly reply_kind: number;
  readonly status: number;
  readonly message?: string;
  readonly headers: readonly Pair[];
  readonly has_reset_at: number;
  readonly reset_at: number;
  readonly error_type?: string;
  readonly log: readonly LogLine[];
  readonly walk?: Handle;
}

export interface ArrivalAnswer {
  readonly kind: number;
  readonly status: number;
  readonly content_type?: string;
  readonly body?: string;
  readonly reply_kind: number;
  readonly message?: string;
}

export interface LimitsAnswer {
  readonly max_request_bytes: number;
  readonly too_large_status: number;
  readonly too_large_message: string;
  readonly refresh_every_milliseconds: number;
  readonly too_large_reply_kind: number;
}

export interface FailureAnswer {
  readonly reply_kind: number;
  readonly status: number;
  readonly message: string;
  readonly log: readonly LogLine[];
}

export interface CatalogTimer {
  readonly change: number;
  readonly kind: number;
  readonly round: number;
  readonly due: number;
}

export interface CatalogOpenAnswer {
  readonly catalog: Handle;
  readonly timers: readonly CatalogTimer[];
}

export interface CatalogEventArgument {
  readonly catalog: Handle;
  readonly kind: number;
  readonly now: number;
  readonly implementations?: readonly string[];
  readonly round?: number;
  readonly implementation?: string;
  readonly models?: CatalogProvider;
  readonly failed?: number;
  readonly message?: string;
  readonly timer?: number;
}

export interface CatalogEventAnswer {
  readonly wait_round: number;
  readonly ask_round: number;
  readonly asks: readonly string[];
  readonly timers: readonly CatalogTimer[];
  readonly released: readonly number[];
  readonly log: readonly LogLine[];
}

export interface CatalogReadAnswer {
  readonly implementations: readonly string[];
  readonly providers: readonly CatalogProvider[];
  readonly slots: readonly Slot[];
  readonly entries: readonly CatalogModel[];
}

export interface Routing {
  step(input: { argument: StepArgument }): Promise<StepAnswer>;
  limits(input: Record<string, never>): Promise<LimitsAnswer>;
  pass_through(input: {
    argument: { upstream: unknown; url: string; headers: readonly Pair[]; body_length: number; placeholder_authorization: unknown };
  }): Promise<{ target: string; headers: readonly Pair[] }>;
  reply_headers(input: { argument: { headers: readonly Pair[]; rewritten: number } }): Promise<{ headers: readonly Pair[] }>;
  arrival(input: { argument: { path: string; headers: readonly Pair[]; port: number } }): Promise<ArrivalAnswer>;
  port(input: { argument: { value: unknown; settings_file: unknown; failure?: { in_use: number; detail: string } } }): Promise<{ port: number; address: string }>;
  failure(input: { argument: { reason: number; upstream?: unknown; detail: string } }): Promise<FailureAnswer>;
  catalog_open(input: { argument: { now: number; profile: RoutingProfile; settings: unknown } }): Promise<CatalogOpenAnswer>;
  catalog_event(input: { argument: CatalogEventArgument }): Promise<CatalogEventAnswer>;
  catalog_read(input: { argument: { catalog: Handle } }): Promise<CatalogReadAnswer>;
}

/** Bytes C wrote and the status, content type and headers it answers they go out in. */
export interface Body {
  readonly bytes: Uint8Array;
  readonly status: number;
  readonly headers: readonly Pair[];
}

export interface DecodedRequest {
  readonly request?: { readonly model: string } & Record<string, unknown>;
  readonly forwarded_headers: readonly Pair[];
  readonly reply_kind: number;
  readonly status: number;
  readonly message?: string;
}

export interface RateLimitArgument {
  readonly upstream_headers: readonly Pair[];
  readonly has_reset_at: number;
  readonly reset_at: number;
  readonly now: number;
  readonly offset_minutes: number;
  readonly zone_en_us: string;
  readonly zone_en_gb: string;
}

export interface Reply {
  readonly status: number;
  readonly headers: readonly Pair[];
  readonly body: string;
}

export interface Anthropic {
  route_request(input: { argument: { method: string; path: string } }): Promise<{ kind: number; model_id?: string }>;
  decode_request(input: { argument: { bytes: Uint8Array; headers: readonly Pair[] } }): Promise<DecodedRequest>;
  encode_response(input: { argument: { response: unknown } }): Promise<Body>;
  stream_encoder_open(input: Record<string, never>): Promise<Handle>;
  stream_encode(input: { argument: { encoder: Handle; events: readonly unknown[] } }): Promise<Body>;
  stream_encode_finish(input: { argument: { encoder: Handle; events: readonly unknown[] } }): Promise<Body>;
  error_envelope(input: { argument: { reply_kind: number; message: string } }): Promise<Body>;
  model_listing(input: { argument: { models: readonly CatalogModel[] } }): Promise<Body>;
  model_lookup(input: { argument: { models: readonly CatalogModel[]; id: string } }): Promise<Body>;
  rate_limit_reply(input: { argument: RateLimitArgument }): Promise<Reply>;
}

export interface ProviderHandleAnswer {
  readonly kind: number;
  readonly response?: unknown;
  readonly failure?: { readonly status: number; readonly headers?: readonly Pair[]; readonly body?: string | null; readonly has_retry_after?: number; readonly retry_after_milliseconds?: number };
  readonly stream?: unknown;
  readonly message?: string | null;
}

export interface ProviderNextAnswer {
  readonly kind: number;
  readonly event?: unknown;
  readonly failure?: string | null;
}

/**
 * The `forebay.provider` contract as a provided implementation offers it, in the binding's shapes; `release_stream`
 * is a release, which an implementation may leave out, and which the consumer calls whenever it is offered.
 */
export interface Provider {
  models(input: Record<string, never>): Promise<{ provider: CatalogProvider }>;
  handle(input: { argument: { request: unknown; headers: readonly Pair[] } }): Promise<ProviderHandleAnswer>;
  next(input: { stream: unknown }): Promise<ProviderNextAnswer>;
  release_stream?(input: { stream: unknown }): unknown;
}

export interface Config {
  get_tree(input: { key: string }): Promise<unknown>;
  settings_file(input: Record<string, never>): Promise<{ path: string } | symbol>;
}

export interface Log {
  write(input: { level: number; message: string }): Promise<void>;
}
