const NOT_FORWARDED = new Set([
  "authorization",
  "x-api-key",
  "host",
  "content-length",
  "accept-encoding",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * The client's headers a provider may send on to the upstream: lower cased, without the credentials the provider
 * replaces, the headers the transport sets itself and the hop by hop headers.
 */
export function forwardableHeaders(headers: Record<string, string>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lowered = name.toLowerCase();
    if (!NOT_FORWARDED.has(lowered)) kept[lowered] = value;
  }
  return kept;
}
