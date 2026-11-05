The front door for the Anthropic Messages API. It is a weivel plugin that provides the `front-door`
capability, and the shared host's session host calls it: the host owns the listener, routing, retries
and streaming, and this plugin owns only what is specific to the Anthropic wire format.

## Structure

- `src/profile.ts`: the routing profile (tiers, tier pattern, environment prefix, limits, upstream).
- `src/decode-request.ts`: routes `POST /v1/messages` through `anthropic-translator`; answers an
  Anthropic-shaped 400 for a body that is not a Messages request, and a pass-through for every other
  method or path, which the host forwards to the upstream untouched.
- `src/encode.ts`: encodes an IR response or one IR stream event back to the Anthropic wire format.
- `src/rate-limit-reply.ts`: the Anthropic-shaped 429 the host answers when every route is limited.
- `src/plugin.ts`: provides the capability; the `upstream` setting (default `https://api.anthropic.com`) is read from the plugin's configuration.

## Testing

`npm test` builds, type-checks and runs vitest. The rate limit vectors under `test/vectors/rate-limit`
were captured from the original implementation; every answer is also checked against the front-door
contract schema, and the plugin is bundled with the host's `bundlePlugin` and run from the bundle alone.
