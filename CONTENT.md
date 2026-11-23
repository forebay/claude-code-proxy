The proxy Claude Code talks to. It is a weivel plugin that listens on `127.0.0.1` and asks forebay-library's C for
every decision: whether a request is admitted, what it is, how its body reads, which provider serves it, what to do
when one fails and how each reply is written. The plugin holds only the I/O and the order of the calls.

It reaches C only through its host: it consumes the `routing` and `anthropic` services and the `forebay.provider`
capability by id through its context, and reads its settings, folders and log through `weivel.config`,
`weivel.paths` and `weivel.log`. It never loads a library itself.

## Structure

- `src/plugin.ts`: activation; listens where `routing.port` answers for the `proxy.port` setting, and on a failed
  listen is refused with `routing.port`'s own refusal, written to the log.
- `src/serve.ts`: one request: `routing.arrival`, then `anthropic.route_request`; the model routes are answered from
  `routing.model_entries` and `anthropic.model_listing` or `model_lookup`, a messages body is decoded by
  `anthropic.decode_request`, and every other request is walked as a pass-through.
- `src/walk.ts`: the loop, `routing.step` until it answers done, performing each step and reporting how it went.
- `src/relay.ts`: a provider's stream through `anthropic.stream_encode`, and the error event C names when it fails
  after bytes went out.
- `src/pass-through.ts`: `routing.pass_through` and `reply_headers`, and `routing.failure` for an unreachable upstream.
- `src/catalog.ts`: the providers' models, asked within the budget and intervals `routing.limits` answers, and the
  model map `routing.model_map` derives from them and the stored settings.
- `src/settings.ts`: the settings as one record; a list is declared as a record keyed by position, since
  `weivel.config` offers no list kind.
- `src/zone.ts`: the machine's zone offset and short name at an instant, from `Intl`, which C names a reset in.

## Configuration

`plugin.json`'s `config.defaults` hold `upstream`, `proxy.port` (34567) and the placeholder credential, and the
routing profile under `routing`: the tier source provider, tier order and fallback, the tier pattern, the native
model pattern, the default limits and the login command the no-model reply names. A stored model map goes under
`routing.modelMap`, each chain a record keyed by position.

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
