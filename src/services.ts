/**
 * The shapes weivel/typescript's binding gives the definitions this plugin calls: each operation one async method
 * taking its input parameters by name and answering its answer struct without its sizes, counts and storage. Only
 * the members this plugin reads or writes are named.
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
  readonly tier_source_provider: string | null;
  readonly tier_order: readonly string[];
  readonly tier_fallback: readonly string[];
  readonly tier_regex: string | null;
  readonly native_model_pattern: string | null;
  readonly default_context: number;
  readonly default_output: number;
}

export interface Slot {
  readonly slot: string;
  readonly chain?: readonly unknown[];
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
  readonly login_command: string;
  readonly settings_file: string;
  readonly report?: Report;
}

export interface StepAnswer {
  readonly kind: number;
  readonly provider?: string;
  readonly model?: string;
  readonly reply_kind?: number;
  readonly status?: number;
  readonly message?: string;
  readonly headers?: readonly Pair[];
  readonly has_reset_at?: number;
  readonly reset_at?: number;
  readonly error_type?: string;
  readonly log?: readonly LogLine[];
  readonly walk?: Handle;
}

export interface ArrivalAnswer {
  readonly kind: number;
  readonly status?: number;
  readonly content_type?: string;
  readonly body?: string;
  readonly reply_kind?: number;
  readonly message?: string;
}

export interface LimitsAnswer {
  readonly max_request_bytes: number;
  readonly too_large_status: number;
  readonly too_large_message: string;
  readonly models_budget_milliseconds: number;
  readonly rederive_interval_milliseconds: number;
  readonly refresh_every_milliseconds: number;
}

export interface FailureAnswer {
  readonly reply_kind: number;
  readonly status: number;
  readonly message: string;
  readonly log?: readonly LogLine[];
}

export interface Routing {
  model_map(input: { argument: { profile: RoutingProfile; settings: unknown; providers: readonly CatalogProvider[] } }): Promise<{ slots?: readonly Slot[] }>;
  model_entries(input: { argument: { profile: RoutingProfile; catalog: readonly CatalogProvider[] } }): Promise<{ entries?: readonly CatalogModel[] }>;
  step(input: { argument: StepArgument }): Promise<StepAnswer>;
  limits(input: Record<string, never>): Promise<LimitsAnswer>;
  pass_through(input: {
    argument: { upstream: string; url: string; headers: readonly Pair[]; body_length: number; placeholder_authorization: string | null };
  }): Promise<{ target: string; headers?: readonly Pair[] }>;
  reply_headers(input: { argument: { headers: readonly Pair[]; rewritten: number } }): Promise<{ headers?: readonly Pair[] }>;
  arrival(input: { argument: { path: string; headers: readonly Pair[]; port: number } }): Promise<ArrivalAnswer>;
  port(input: { argument: { value: unknown; settings_file: string; failure?: { in_use: number; detail: string } } }): Promise<{ port: number; address: string }>;
  failure(input: { argument: { reason: number; upstream?: string; detail: string } }): Promise<FailureAnswer>;
}

export interface Body {
  readonly bytes?: Uint8Array;
}

export interface DecodedRequest {
  readonly request?: { readonly model: string } & Record<string, unknown>;
  readonly forwarded_headers?: readonly Pair[];
  readonly reply_kind?: number;
  readonly status?: number;
  readonly message?: string;
}

export interface RateLimitArgument {
  readonly upstream_headers: readonly Pair[];
  readonly has_reset_at: number;
  readonly reset_at: number;
  readonly now: number;
  readonly offset_minutes: number;
  readonly zone: string;
}

export interface Reply {
  readonly status: number;
  readonly headers?: readonly Pair[];
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
  model_lookup(input: { argument: { models: readonly CatalogModel[]; id: string } }): Promise<{ found: number; bytes?: Uint8Array }>;
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

/** The `forebay.provider` contract as a provided implementation offers it, in the binding's shapes. */
export interface Provider {
  models(input: Record<string, never>): Promise<{ provider: CatalogProvider }>;
  handle(input: { argument: { request: unknown; headers: readonly Pair[] } }): Promise<ProviderHandleAnswer>;
  next(input: { stream: unknown }): Promise<ProviderNextAnswer>;
}

export interface SettingValue {
  readonly kind: number;
  readonly boolean?: number;
  readonly number?: number;
  readonly text?: string | null;
}

export interface Config {
  get(input: { key: string }): Promise<{ value: SettingValue } | symbol>;
  all(input: Record<string, never>): Promise<{ settings?: readonly { key: string; value: SettingValue }[] }>;
}

export interface Paths {
  config(input: Record<string, never>): Promise<string>;
}

export interface Log {
  write(input: { level: number; message: string }): Promise<void>;
}
