The proxy Claude Code talks to. It is a weivel plugin that listens on `127.0.0.1` and asks forebay-library's C for
every decision: whether a request is admitted, what it is, how its body reads, which provider serves it, what to do
when one fails and how each reply is written. The plugin holds only the I/O and the order of the calls.

It reaches C only through its host: it consumes the `routing` and `anthropic` services and the `forebay.provider`
capability by id through its context, and reads its settings and writes its log through `weivel.config` and
`weivel.log`. It never loads a library itself.

## Structure

- `src/plugin.ts`: activation; listens where `routing.port` answers for the `proxy.port` setting, and on a failed
  listen is refused with `routing.port`'s own refusal, which the run publishes as the plugin's refusal.
- `src/serve.ts`: one request: `routing.arrival`, then `anthropic.route_request`; the model routes are answered from
  the catalog's entries, which `routing.catalog_read` answers, and `anthropic.model_listing` or `model_lookup`, a
  messages body is decoded by `anthropic.decode_request`, and every other request is walked as a pass-through with
  the key headers the route names.
- `src/walk.ts`: the loop, `routing.step` until it answers done, performing each step and reporting how it went.
- `src/relay.ts`: a provider's stream through `anthropic.stream_encode`, one encoder per provider, and the error event
  C names when it fails after bytes went out; the stream is freed through the provider's `release_stream` when it
  offers one, a client going away included.
- `src/pass-through.ts`: `routing.pass_through` and `reply_headers`, and `routing.failure` for an unreachable upstream.
- `src/catalog.ts`: the providers' models, kept by forebay-library's catalog object, which holds the rounds and the
  models; it reports each event through `routing.catalog_event`, performs the asks and sets the timers C names, parks
  each request on the round C names, and reads the entries through `routing.catalog_read`.
- `src/settings.ts`: each setting whole through `weivel.config`'s `get_tree`, and the settings file C names to the
  user from its `settings_file`.
- `src/zone.ts`: the machine's zone offset and short name at an instant, from `Intl`, which C names a reset in.

## Configuration

`plugin.json`'s `config.defaults` hold `upstream`, `proxy.port` (34567) and the placeholder credential, and the
routing profile under `routing`: the tier source provider, tier order and fallback, the tier pattern, the native
model pattern, the default limits and the login command the no-model reply names. A stored model map goes under
`routing.modelMap`, each slot a list of `{provider, model}`.

## Testing

`npm test` builds forebay-library's `forebay_library` and spisor/library's `runtime` with CMake into `native/`
(`scripts/native.ts`), builds and type-checks, and runs vitest. `test/proxy.test.ts` lays out a temporary home with
the four `SPISOR_*` places under it, installs the proxy and the test provider of `test/fixtures/provider/` into it,
runs `runtime` under weivel/typescript's `startHost` in process, and sends each case as a real HTTP request to the
listening proxy; `test/fixtures/upstream.ts` is the local upstream a pass-through reaches.

The siblings are pinned in `repo.json` under `siblings/`, each nested one at the path its parent's build reads:
`typescript` with its `core`, `standard` and `conformance`, `forebay-library` with its `library`, `core`, `standard`
and `c`, and `library` with its `core`, `standard` and `c`. `siblings/typescript` is installed and built first
(`npm ci` and `npm run build` there), which needs CMake and a C compiler as the two native builds here do.
