import type { RateLimitReplyArgument, WireReply } from "@forebay/host";
import { resetTime } from "./reset-time.js";

const DROPPED_HEADERS = ["content-encoding", "content-length", "x-hub-rate-limited", "x-hub-retry-after-ms"];
const RESET_HEADERS = ["anthropic-ratelimit-unified-5h-reset", "anthropic-ratelimit-unified-reset"];
const FALLBACK_RETRY_AFTER_SECONDS = 60;
const WHOLE_NUMBER = /^[+-]?\d+$/;

function copiedHeaders(upstreamHeaders: Record<string, string>): Record<string, string> {
  const headers = { ...upstreamHeaders };
  for (const name of DROPPED_HEADERS) delete headers[name];
  return headers;
}

function resetMilliseconds(value: string | undefined): number {
  const text = value?.trim();
  return text !== undefined && WHOLE_NUMBER.test(text) ? Number(text) * 1000 : 0;
}

function reconciledReset(headers: Record<string, string>, resetAt: number): number {
  return RESET_HEADERS.reduce((latest, name) => Math.max(latest, resetMilliseconds(headers[name])), resetAt);
}

function messageFor(reset: number, now: number, timeZone: string): string {
  const prefix = "You've hit your usage limit \u00b7";
  return reset > now ? `${prefix} resets at ${resetTime(reset, timeZone)}` : `${prefix} try again later`;
}

function retryAfterSeconds(reset: number, now: number): number {
  return reset > now ? Math.round((reset - now) / 1000) : FALLBACK_RETRY_AFTER_SECONDS;
}

/** Answers what the upstream's own 429 said, with the reset reconciled and the retry-after recomputed from the clock. */
export function rateLimitReply(argument: RateLimitReplyArgument): WireReply {
  const { now, timeZone } = argument;
  const headers = copiedHeaders(argument.upstreamHeaders);
  const reset = reconciledReset(headers, Math.max(argument.resetAt ?? 0, 0));
  headers["content-type"] = "application/json";
  headers["retry-after"] = String(retryAfterSeconds(reset, now));
  headers["anthropic-ratelimit-unified-status"] ??= "rejected";
  headers["anthropic-ratelimit-unified-reset"] ??= String(Math.floor((reset > 0 ? reset : now) / 1000));
  const error = { type: "rate_limit_error", message: messageFor(reset, now, timeZone) };
  return { status: 429, headers, body: JSON.stringify({ type: "error", error }) };
}
