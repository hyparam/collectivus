# Collectivus

This file provides guidance when working with code in this repository.

## Commands

- `npm test`: run Vitest suite once
- `npx vitest run test/server.test.js`: run a single test file
- `npx vitest run -t "pattern"`: run tests matching a name
- `npm run lint` / `npm run lint:fix`: ESLint (flat config, `eslint.config.js`)
- `npm run typecheck`: `tsc` with `checkJs` over `src` and `test` (no emit; JSDoc types)
- `npm start`: run the CLI locally (`node bin/cli.js`)

## Conventions

- Avoid JavaScript classes unless the value owns lifecycle, resource, timer, event, or mutable protocol state. Prefer plain serializable config objects plus functions for file-backed or stateless behavior.
- Do NOT use `@typedef` or inline `import('...').Foo` in JSDoc. Instead, put the type in a `.d.ts` file and pull it in with a top-of-file `@import`.
- No emdashes anywhere.

## Architecture

Two listeners in one process: an OTLP/HTTP JSON receiver and a recording reverse-proxy for LLM APIs. The core uses Node built-ins only (`http`, `https`, `zlib`, `fs`); the optional upload subsystem under `src/upload/` is the one scoped exception. ESM (`"type": "module"`). Types come from JSDoc checked by TS; types live in `.d.ts` files and are pulled in via top-of-file `@import`; no `@typedef`, no inline `import('...').Foo`.

Runtime is configured from a single JSON file (or http(s) URL) passed via `--config`. CLI flags only select the config; everything else (listeners, sinks, upload, roles, central-server) is config-driven. `--print-config` and `--strict` aid debugging. Bare `collectivus` on a TTY launches `src/cli/init.js` (interactive walkthrough → writes `~/.hyp/collectivus.json`, sink `~/.hyp/collectivus/`, and optionally chains into `install`).

### Roles

`config.role` is one of `standalone` (default), `gateway`, or `server`. The role gates which listener factories `buildConfigListeners` registers in `src/cli.js`:

- **standalone**: OTLP receiver + recording proxy write locally; optional upload runs in-process. The original single-tenant shape.
- **gateway**: adds an `IdentityClient` (JWT bootstrap/refresh against `central_server.url`) and a `ConfigClient` background poll. The poll emits `'config-changed'` which `runLifecycle` routes through `src/gateway/hot_reload.js` to start/stop just the affected listener sections without restarting the process. The gateway's `Recorder`/collector sink can be the `ShippingSink` (`src/gateway/shipping_sink.js`), which batches rows by signal and POSTs them to the central server's `/v1/ingest/<signal>` endpoint.
- **server**: runs the control-plane HTTP listener (`src/server/control_plane.js`) instead of (or alongside) OTLP/proxy. It mounts identity (`/v1/identity/bootstrap|refresh`), NDJSON ingest (`/v1/ingest/<signal>`), and config-vending endpoints, backed by `BootstrapStore`, `ConfigRegistry` (one JSON per `gateway_id` under `<data_dir>/configs/`), `Ingest` (writes `<sink_dir>/<gateway_id>/<signal>/<UTC-date>.jsonl`), token-bucket rate limiters, and SigV4-free bearer auth. `gateway_id` is taken from the JWT `sub` and validated against the shared `GATEWAY_ID_PATTERN` (email-shaped) before joining filesystem paths.

### Sink layout

All three roles write recordings under one shape: `<sink.dir>/<gateway_id>/<signal>/<UTC-date>.jsonl`. The first-level `gateway_id` partition resolves differently per role:

- **standalone**: from top-level `config.gateway_id` if set, else `os.userInfo().username` sanitized through `GATEWAY_ID_PATTERN` (`_unknown` fallback). Resolved once at boot in `src/cli.js` via `resolveStandaloneGatewayId` (`src/gateway_id.js`) and threaded into the Collector and FileSink factories. `config.gateway_id` is rejected for non-standalone roles.
- **gateway**: from the JWT subject (`identityClient.identity.gateway_id`).
- **server**: per-request from each ingest's authenticated JWT `sub`.

Two sibling subtrees live alongside the per-signal directories:

- `<sink.dir>/<gateway_id>/proxy/<UTC-date>.jsonl`: proxy exchanges + SSE events (one row per line, daily rotation on UTC midnight). Mirrors the server's `proxy` ingest signal.
- `<sink.dir>/<gateway_id>/raw/<signal>/<UTC-date>.jsonl`: raw OTLP envelopes preserved for debugging — one envelope per line. The upload pipeline does not drain this subtree.

### Layers

1. `src/server.js`: pure `http.createServer` factory for the OTLP receiver. POST only, routes `/v1/traces|metrics|logs`, JSON content-type, `Content-Encoding` accepts `identity`/`gzip`/`deflate`. Responses mirror OTLP partial-success per signal. OTLP normalization is split into `src/otlp/{traces,metrics,logs,datapoints,common}.js`.
2. `src/collector.js`: `Collector` wraps the OTLP server. Requires `gatewayId` in its constructor; writes raw envelopes to `<outputDir>/<gatewayId>/raw/<signal>/<UTC-date>.jsonl` and normalized per-record rows to `<outputDir>/<gatewayId>/<signal>/<UTC-date>.jsonl`. Same shape as the server-role ingest layout.
3. `src/proxy.js`: recording reverse-proxy. Matches against configured upstreams (Anthropic / OpenAI / Gemini / custom), forwards, and records exchanges + SSE events via `src/recorder.js` to whichever `Sink` is wired (default `src/sinks/file.js` → `<sink.dir>/<gatewayId>/proxy/<UTC-date>.jsonl` with daily rotation; gateway role uses `ShippingSink`).
4. `src/cli.js`: top-level CLI. Parses args, loads config (file or URL), pre-flights AWS creds if upload is set, eagerly acquires gateway identity, then `runLifecycle` starts a section-keyed `Map` of listener factories in dependency order and tears them down on SIGINT/SIGTERM. Hot-reload events are serialized onto a single chain to avoid interleaved stop/start.
5. `src/cli/{install,uninstall,attach,detach,status,init,export,config}.js`: subcommands dispatched from `bin/cli.js`. `install` writes a launchd LaunchAgent (macOS) or systemd user unit (Linux) via `src/daemon/`. `uninstall` auto-detaches any attached clients. `status` reports daemon state, config path, sink stats, attach state, and installed version. `export` converts recorded JSONL → Parquet locally (one-shot; doesn't trigger upload). `config` is the operator CLI for server-role per-gateway configs (`set|get|list|delete|bootstrap-token`).
6. `src/claude-code/settings.js` and `src/codex/{settings,config-file,toml-config,errors}.js`: surgically edit `~/.claude/settings.json` (JSON) and Codex's `config.toml` (TOML) to point clients at the local proxy. Both stamp a managed marker so `detach` can restore cleanly.
7. `src/update.js`: daily self-update tick scheduled by `src/cli.js` whenever any listener is running. Polls the npm registry; if a newer `collectivus` is published and the process is supervised (launchd/systemd), runs `npm install -g` and SIGTERMs itself so the supervisor respawns on new code. Failures are swallowed and retried tomorrow.

The OTLP `signal` string is derived by stripping `/v1/` from the URL path so it matches the output subdirectory (`traces`, `metrics`, `logs`). Keep that invariant if you add routes.

Error codes in OTLP responses follow gRPC status codes (3 = InvalidArgument, 5 = NotFound, 12 = Unimplemented).

## Upload subsystem (`src/upload/`)

Opt-in via the `upload` config block. When enabled, an in-process daily timer converts the previous UTC day's normalized JSONL into Parquet and PUTs it to S3 at `s3://<bucket>/<prefix>/<gateway_id>/<signal>/date=YYYY-MM-DD/data.parquet`. Standalone and server modes share the partition layout (`['gateway_id', 'signal']`); the only difference is the source directory. Local files are kept after upload.

- `hyparquet-writer` is an `optionalDependency`, lazy-loaded inside `src/upload/parquet.js`. Base installs without uploads stay zero-dep at runtime.
- S3 is signed by hand (SigV4 in `src/upload/connectors/s3.js`); no AWS SDK. Endpoint override via `upload.endpoint` for MinIO / S3-compatible servers.
- Idempotency: an append-only ledger at `<outputDir>/.upload-ledger.jsonl` plus a HEAD-based fallback that reconstructs ledger state if it is lost.
- Schema: open-ended attribute bags (resource, attributes, scope.attributes, metadata, log body) are stored as `JSON` BasicType columns. Closed-shape arrays/structs (events, links, status, exemplars, quantileValues, bucketCounts, explicitBounds, positive, negative) are also `JSON` for v0; when `hyparquet-writer` ships variant or nested-list typing, swap column types in `src/upload/schema.js`; the row coercer can keep passing structured values.

Config keys (under `upload`): `bucket`, `prefix` (default `collectivus`), `region`, `time` (HH:MM UTC, default `00:10`), `signals` (`logs,traces,metrics`), `catchupDays` (default 7), `endpoint`. AWS credentials still come from standard env (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`) and are pre-flighted at boot.

### Iceberg upload mode (`src/upload/iceberg/`)

Setting `upload.iceberg` in the config switches the upload pipeline from "one Parquet object per (gateway_id, signal, day)" to "one long-lived Iceberg table per (gateway_id, signal), partitioned by date". Local JSONL retention is unchanged; the same daily ledger drives idempotency.

- `src/upload/iceberg/index.js`: the iceberg counterpart of `uploadPending`. Discovers the same per-day jobs, lazily creates the table on first append per (gateway_id, signal), then calls `icebergAppend`.
- `src/upload/iceberg/resolver.js`: bridges the existing `StorageConnector` to icebird's `Resolver` interface (writer/reader/deleter). Translates every URL form icebird emits (`s3://`, `s3a://`, virtual-hosted https) to a connector key. Forwards `If-None-Match: *` from icebird's `WriterOptions` so atomic metadata commits work end-to-end.
- `src/upload/iceberg/schema.js`: derives the Iceberg schema and partition spec from the existing per-signal column lists. JSON-shaped attribute bags (resource, attributes, body, events, status, ...) become `variant` (format-version 3); the partition column is a synthetic required `date` populated from the job's date.
- `icebird` is an `optionalDependency` (paired with `hyparquet-writer`); it is lazy-imported only when iceberg mode is on.

`fileCatalog({ resolver, conditionalCommits: true })` makes the metadata writes safe under concurrent writers (412/409 surface from the connector and icebird's commit-retry layer reloads + re-stages). Idempotency at the (gateway_id, signal, date) granularity is still enforced by the shared ledger; re-running a tick on already-committed data is a no-op.

## Testing

Vitest. `test/server.test.js` exercises the OTLP HTTP layer end-to-end on an ephemeral port. `test/server/` covers the control-plane (auth, identity, config registry, ingest, backpressure). `test/gateway/` covers identity client, config-pull, hot reload, and the shipping sink. `test/cli/` covers each subcommand; `test/e2e/config_vending.test.js` exercises the gateway↔server round-trip. `test/upload/` uses a memory connector (`src/upload/connectors/memory.js`) and a local stub HTTP server for the SigV4 connector test. `test/{codex,claude-code,sinks,daemon}/` cover their respective modules.
