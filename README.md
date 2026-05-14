# Collectivus

![collectivus](collectivus.jpg)

[![npm](https://img.shields.io/npm/v/collectivus)](https://www.npmjs.com/package/collectivus)
[![minzipped](https://img.shields.io/bundlephobia/minzip/collectivus)](https://www.npmjs.com/package/collectivus)
[![workflow status](https://github.com/hyparam/collectivus/actions/workflows/ci.yml/badge.svg)](https://github.com/hyparam/collectivus/actions)
[![mit license](https://img.shields.io/badge/License-MIT-orange.svg)](https://opensource.org/licenses/MIT)
[![dependencies](https://img.shields.io/badge/Dependencies-0-blueviolet)](https://www.npmjs.com/package/collectivus?activeTab=dependencies)
[![container](https://img.shields.io/badge/container-ghcr.io%2Fhyparam%2Fcollectivus-blue)](https://github.com/orgs/hyparam/packages/container/package/collectivus)

Collectivus is an OTLP collector and pass-through LLM proxy in pure Node.js. Two listeners in one process record everything to local JSONL: an OpenTelemetry receiver that normalizes traces, metrics, and logs by signal and service, and a transparent reverse proxy for LLM APIs that captures every request and SSE event. Pick one or run both.

- **OTLP receiver**: traces, metrics, and logs over HTTP, normalized to JSONL
- **LLM proxy**: transparent pass-through for Anthropic Messages and OpenAI-compatible APIs, full request/response capture
- **Zero dependencies**: Node built-ins only, single binary, instant startup

## Installation

```bash
npm install collectivus
```

Or run the container image published from this repo:

```bash
docker pull ghcr.io/hyparam/collectivus:latest
docker run --rm ghcr.io/hyparam/collectivus:latest --help
```

The image entrypoint is the `ctvs` CLI. Choose what the container runs by
passing the same arguments you would pass to `ctvs`:

```bash
# Central server, gateway, or standalone: selected by role in the config file.
docker run --rm ghcr.io/hyparam/collectivus:latest --config /config/collectivus.json

# Same, but with config JSON injected as an environment variable.
docker run --rm -e COLLECTIVUS_CONFIG_JSON ghcr.io/hyparam/collectivus:latest \
  --config-env COLLECTIVUS_CONFIG_JSON

# Hosted-discovery rendezvous server: selected by the rendezvous subcommand.
docker run --rm ghcr.io/hyparam/collectivus:latest rendezvous --help
```

To run Central server and rendezvous on the same host, run two containers from
the same image with separate commands, ports, and data volumes.

### Self-hosting

The repo ships a reference [`docker-compose.yml`](docker-compose.yml) and a
matching [`.env.example`](.env.example) that bring up the central server and
rendezvous together so the `ctvs invite create` → `ctvs join` flow works end
to end:

```bash
cp .env.example .env
# fill in three high-entropy secrets (openssl rand -hex 32) and two public URLs:
#   COLLECTIVUS_ADMIN_TOKEN, COLLECTIVUS_IDENTITY_SECRET,
#   COLLECTIVUS_RENDEZVOUS_REGISTRATION_TOKEN, COLLECTIVUS_RENDEZVOUS_URL,
#   COLLECTIVUS_PUBLIC_URL
docker compose up -d
```

See [`docs/self-hosting-docker.md`](docs/self-hosting-docker.md) for the full
walkthrough — TLS termination (Caddy / nginx / Traefik), token rotation,
volume backup, and a troubleshooting checklist.

### AWS ECS (optional)

An AWS CDK app under [`infra/aws/`](infra/aws/) deploys the same two services
as ECS Fargate tasks behind ALBs, backed by encrypted EFS state and a private
S3 archive bucket. The compose path above is the supported default; reach for
the CDK app only if you already have an AWS deployment target.

## Quick start: record claude-code

The fastest path is the interactive walkthrough. Run `ctvs` with no
arguments and choose Standalone or Central server. Standalone keeps config and
recordings on this machine; Central server vendors per-gateway config and
receives shipped ingest.
For Standalone, the walkthrough also asks where to write recordings and
whether to install as a daemon and attach Claude Code:

```bash
npx -p collectivus ctvs
```

By default it writes the config to `~/.hyp/collectivus.json`, the sink to
`~/.hyp/collectivus/`, and (if you opt in) installs a LaunchAgent / systemd
user unit that boots at login.

Or write a config by hand:

```bash
# 1. Save examples/claude-code.json (proxy on 127.0.0.1:8787 → api.anthropic.com)
npx -p collectivus ctvs --config examples/claude-code.json

# 2. In another terminal:
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude

# 3. Run a prompt, then watch the recording:
tail -f "collectivus-data/$USER/proxy/$(date -u +%F).jsonl"
```

Full step-by-step: [`docs/walkthrough-claude-code.md`](docs/walkthrough-claude-code.md).

## Configuration

Pass a JSON config with `--config <path>` (a local path or url). The schema:

```json
{
  "version": 1,
  "otel":  { "listen": "0.0.0.0:4318" },
  "proxy": {
    "listen": "127.0.0.1:8787",
    "upstreams": [
      {
        "name": "anthropic",
        "base_url": "https://api.anthropic.com",
        "match": { "path_prefix": "/v1/messages" }
      }
    ],
    "redact_headers": ["authorization", "x-api-key", "anthropic-api-key", "cookie", "set-cookie"]
  },
  "sink": { "type": "file", "dir": "./collectivus-data" },
  "query": { "parquet": { "enabled": true } }
}
```

| Block | Purpose |
|-------|---------|
| `version` | Schema version. Required. Currently `1`. |
| `otel`    | Enable the OTLP receiver. Omit to disable. |
| `proxy`   | Enable the LLM proxy. Omit to disable. Requires `sink` in Standalone mode. |
| `sink`    | Root directory for Standalone JSONL recordings. Proxy rows land under `<sink.dir>/<gateway_id>/proxy/`; OTLP rows land under `<sink.dir>/<gateway_id>/<signal>/`. Required when `otel` or `proxy` is set in Standalone mode. Accepted but unused in Gateway mode. |
| `central_server` | Gateway-mode Central server URL, identity settings, config poll interval, and optional `outbox_dir`. Gateway rows are first fsynced to this durable local outbox, then shipped to Central ingest. |
| `upload`  | Optional. Enables the daily S3 parquet drain. See [S3 upload](#s3-upload). |
| `query`   | Optional. Configures the local `ctvs query` Parquet cache. `query.parquet.enabled` defaults to `true`; `query.parquet.dir` defaults to `<recording-root>/.collectivus-query/parquet`. |

Add an `upload` block to drain JSONL to S3 once a day:

```json
{
  "version": 1,
  "proxy": { "listen": "127.0.0.1:8787", "upstreams": [] },
  "sink":   { "type": "file", "dir": "./collectivus-data" },
  "upload": {
    "bucket": "my-collectivus-archive",
    "prefix": "collectivus",
    "region": "us-east-1",
    "time":   "00:10",
    "signals": ["logs", "traces", "metrics"]
  }
}
```

`--print-config` loads, validates, and pretty-prints the resolved config:

```bash
npx -p collectivus ctvs --config collectivus.json --print-config
```

### v1 schema

`version: 1` introduces array-shape `upstreams`, an optional `upload` block,
and makes `sink` mandatory whenever `otel` or `proxy` is set in Standalone
mode. v0 configs (missing the `version` field) hard-fail with a clear error —
the walkthrough writes v1 only.

## Config vending (multi-host deployments)

For fleets of gateways behind a single audit/storage backend, run one
collectivus host as the central server (`role: "server"`) and point each
managed host at it as a gateway (`role: "gateway"`). The central server vendors
per-gateway configs over `GET /v1/config` (with `If-None-Match` / `ETag`) and
accepts ingest from each gateway. Gateways pull their config every
`central_server.poll_interval_seconds` (default 30, range 5–3600) and
hot-reload only the listener whose section changed.

Run `npx collectivus` interactively and choose Central server to write a
server config. That flow asks for `server.public_url`, which should be the URL
gateways can actually reach (for ECS/Docker, usually the load balancer URL).
Start the server with either npm or a container:

```bash
npx -p collectivus ctvs --config /etc/collectivus-server.json
# or after npm install -g collectivus:
ctvs --config /etc/collectivus-server.json
# or in Docker/ECS, mount the config + data_dir and pass:
docker run --rm -p 8788:8788 \
  -v /host/config:/config:ro \
  -v collectivus-server-data:/data \
  ghcr.io/hyparam/collectivus:latest \
  --config /config/collectivus-server.json
```

When using the container, set `server.data_dir`,
`server.identity_issuer.bootstrap_store_path`, and any ingest `sink_dir` under
the mounted `/data` volume, and make sure that volume is writable by UID 1000
(`node` inside the image).

Gateway mode treats Central server as the canonical recording store. Proxy and
OTLP rows are written first to a durable delivery outbox under
`central_server.outbox_dir` (default: `<dirname(identity.json)>/outbox`) and
then shipped to `POST /v1/ingest/<signal>`. The outbox is a transient retry
spool, not a local queryable archive; deleted gateway configs stop old JWTs
from ingesting or refreshing.

Operator workflow on the server host:

```bash
# 1. Issue a one-shot bootstrap token for a new gateway. If server.public_url is
#    set, stderr also prints the one-line gateway setup command.
ctvs config bootstrap-token issue gw-prod-1 --server-config /etc/collectivus-server.json
# stdout → bt_abc123...
# stderr → npx collectivus --config-endpoint='https://collectivus.internal:8788/v1/bootstrap-config?token=bt_abc123...'

# 2. Register the per-gateway config the gateway will pull. Validated server-
#    side; an invalid file is rejected before any bytes hit disk.
ctvs config set gw-prod-1 --server-config /etc/collectivus-server.json --file gw-prod-1.json

# 3. Operator inspection / cleanup tools.
ctvs config get gw-prod-1 --server-config /etc/collectivus-server.json
ctvs config list --server-config /etc/collectivus-server.json
ctvs config delete gw-prod-1 --server-config /etc/collectivus-server.json
```

These commands are local operator tools for the central server host. They read
the server config only to find the same on-disk config registry and bootstrap
token store used by the running central server.

When the Central server config is injected through an environment variable
(for example Docker/ECS with `--config-env COLLECTIVUS_SERVER_CONFIG`), use the
matching operator flag:

```bash
ctvs config bootstrap-token issue gw-prod-1 \
  --server-config-env COLLECTIVUS_SERVER_CONFIG
```

Gateway side, run the setup command printed by the token issuer:

```bash
npx collectivus --config-endpoint='https://collectivus.internal:8788/v1/bootstrap-config?token=bt_abc123...'
# → fetches the registered gateway config with the bootstrap token overlaid,
#   exchanges the token for a 30-day JWT, persists it to
#   ~/.hyp/collectivus/identity.json, then begins polling /v1/config.
```

The config endpoint does not consume the token; the token is consumed only when
the gateway posts to `/v1/identity/bootstrap`. Once the gateway has a JWT, the
persisted identity handles refresh until the JWT itself rotates.

### Hosted discovery rendezvous

For private Central server URLs that are hard to type or distribute, you can
run a hosted-discovery rendezvous service. Rendezvous stores only
`sha256(join_code)`, the Central server connect URL, gateway id, expiry, and
optional display metadata; it never stores plaintext join codes, configs,
telemetry, JWTs, issuer secrets, or bootstrap tokens. With rendezvous, the
short join key is not the bootstrap token; Central mints a fresh one-shot
bootstrap token after the key is resolved.

Start rendezvous with a shared registration bearer token:

```bash
ctvs rendezvous --listen 0.0.0.0:8789 --data-dir ~/.hyp/collectivus/rendezvous \
  --registration-token "$COLLECTIVUS_RENDEZVOUS_REGISTRATION_TOKEN"
```

The same service can run directly from the GHCR image:

```bash
docker volume create collectivus-rendezvous
docker run --rm -p 8789:8789 \
  -e COLLECTIVUS_RENDEZVOUS_REGISTRATION_TOKEN="$COLLECTIVUS_RENDEZVOUS_REGISTRATION_TOKEN" \
  -v collectivus-rendezvous:/data \
  ghcr.io/hyparam/collectivus:latest \
  rendezvous --listen 0.0.0.0:8789 --data-dir /data/rendezvous
```

Then issue a short join key and register its hash with rendezvous in one step:

```bash
ctvs config bootstrap-token issue acme-gateway \
  --server-config /etc/collectivus-server.json \
  --rendezvous https://join.collectivus.example \
  --max-uses 25
```

`--rendezvous-token` can be passed explicitly; otherwise the operator CLI reads
`COLLECTIVUS_RENDEZVOUS_REGISTRATION_TOKEN`. The short join key prints on
stdout for scripts. `--max-uses` defaults to 1; values greater than 1 enroll
gateways as `<gateway-id>-1`, `<gateway-id>-2`, and so on. `--ttl-seconds`
controls the key expiry. Stderr prints the gateway command:

```bash
npx collectivus join <join-code> --rendezvous https://join.collectivus.example
```

When invoked through `npx`, `ctvs join` submits the join code in a POST body,
resolves the Central server URL, asks that server to mint a one-shot bootstrap
token for this enrollment, runs `npm install -g collectivus`, exchanges the
bootstrap token for a long-lived JWT, writes the authenticated Central-vended config to
`~/.hyp/collectivus.json`, and installs the background daemon against that
config. The JWT is persisted to `~/.hyp/collectivus/identity.json` before the
daemon starts. If the vended config has a proxy listener, `join` also points
Claude Code at that local proxy. A globally installed `ctvs join` still runs the
gateway in the foreground for debugging.

Security note: in v1, rendezvous does not pin or cryptographically verify the
Central server URL it returns. This is appropriate when gateways can reach the
Central server only through private/VPC networking or constrained egress. If a
gateway can reach arbitrary internet destinations, a compromised rendezvous
server could return a fake Central URL that the gateway would trust.

The interactive walkthrough builds Standalone and Central server configs.
Gateway hosts use the one-line setup command printed by the Central server
bootstrap-token issuer.

## S3 upload

Standalone and Central server modes write JSONL to their configured local
recording root. When the `upload` block is configured, a daily scheduler drains
the previous day's JSONL into Parquet partitions in S3. Object keys are
Hive-partitioned:

```
<prefix>/<gateway_id>/<signal>/date=<YYYY-MM-DD>/data.parquet
```

This is useful for long-term retention, columnar queries with
Athena / DuckDB / Snowflake, and offsite backup of recordings that would
otherwise live only on the daemon host. The local JSONL is the source of
truth; the S3 drain is additive and idempotent (a per-(gateway_id, signal,
date) ledger and a HEAD check on the destination key prevent duplicate
uploads).

| Field         | Required | Default     | Notes                                         |
|---------------|----------|-------------|-----------------------------------------------|
| `bucket`      | yes      | —           | Destination S3 bucket name.                   |
| `prefix`      | no       | `collectivus` | Key prefix under the bucket.               |
| `region`      | no       | `AWS_REGION` env, or `us-east-1` | AWS region. |
| `time`        | no       | `00:10`     | Daily run time, `HH:MM` UTC.                  |
| `signals`     | no       | all three   | Subset of `logs`, `traces`, `metrics`.        |
| `catchupDays` | no       | `30`        | Look back this many days for unuploaded JSONL. |
| `endpoint`    | no       | —           | Custom S3-compatible endpoint (e.g. MinIO).   |

### Credentials

Credentials are never stored in the config. They are resolved at daemon start
from one of these sources:

- `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` for local/dev or explicit
  static credentials.
- ECS task-role credentials exposed through
  `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` or
  `AWS_CONTAINER_CREDENTIALS_FULL_URI`.
- `AWS_CONTAINER_AUTHORIZATION_TOKEN` or
  `AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE` when the container credential
  endpoint requires an auth token.
- `AWS_SESSION_TOKEN` (optional, for temporary credentials)
- `AWS_REGION` (optional; the `upload.region` config field overrides this)

When `upload` is set in the config but no supported AWS credential source is
available, the daemon fails fast at startup rather than at the first daily tick.

## OTLP receiver

The OTLP receiver accepts JSON and protobuf payloads on the standard endpoints:

- `POST /v1/traces`
- `POST /v1/metrics`
- `POST /v1/logs`

Output layout under `sink.dir`:

```
collectivus-data/
└── <gateway_id>/
    ├── raw/
    │   ├── traces/<UTC-date>.jsonl       # raw export envelope
    │   ├── metrics/<UTC-date>.jsonl
    │   └── logs/<UTC-date>.jsonl
    ├── traces/<UTC-date>.jsonl           # one row per span
    ├── metrics/<UTC-date>.jsonl          # one row per data point
    └── logs/<UTC-date>.jsonl             # one row per log record
```

Each normalized row includes the source `service.name`, while files are
partitioned by `gateway_id`, signal, and date.

### Verify the OTLP receiver

```bash
npx -p collectivus ctvs --config collectivus.json &
curl -X POST localhost:4318/v1/traces \
  -H 'Content-Type: application/json' \
  -d '{"resourceSpans":[]}'
```

## LLM proxy mode

The proxy is a transparent reverse proxy for Anthropic's Messages API. With
`ANTHROPIC_BASE_URL=http://127.0.0.1:8787`, every claude-code call routes
through collectivus, gets forwarded to `https://api.anthropic.com`, and is
recorded to JSONL.

Two row kinds in `<sink.dir>/<gateway_id>/proxy/<UTC-date>.jsonl`:

**Per stream event** (one per SSE event for streamed responses):

```json
{
  "exchange_id": "01HX...",
  "kind": "stream_event",
  "t_ms": 137,
  "event": "content_block_delta",
  "data": "{\"type\":\"content_block_delta\",\"delta\":{\"text\":\"...\"}}"
}
```

**Per exchange** (always emitted, after the response completes):

```json
{
  "exchange_id": "01HX...",
  "kind": "exchange",
  "ts_start": "...",
  "ts_end":   "...",
  "duration_ms": 14444,
  "upstream": "anthropic",
  "client":  { "ip": "127.0.0.1", "user_agent": "claude-code/..." },
  "request": {
    "method": "POST",
    "path":   "/v1/messages",
    "headers": { "x-api-key": "REDACTED:abcd", "...": "..." },
    "body":    "{...}"
  },
  "response": { "status": 200, "headers": {}, "body": null },
  "stream_event_count": 47,
  "error": null
}
```

For non-streaming responses, only the `kind: "exchange"` row is written, with
`response.body` populated.

### Header redaction

Request and response headers in `proxy.redact_headers` are rewritten as
`REDACTED:<last 4 chars>`. The default list (`authorization`, `x-api-key`,
`anthropic-api-key`, `cookie`, `set-cookie`) is always applied — you can
extend it but not shrink it.

Bodies are never auto-redacted: full visibility is the intended behavior.

### Auth

Pass-through. The client's `x-api-key` is forwarded to upstream verbatim;
collectivus does not hold a credential.

### Codex

Codex can route through the same proxy by configuring a Codex model provider.
Use an OpenAI upstream whose path prefix matches `/v1/responses`:

```json
{
  "version": 1,
  "proxy": {
    "listen": "127.0.0.1:8787",
    "upstreams": [
      {
        "name": "openai",
        "base_url": "https://api.openai.com",
        "match": { "path_prefix": "/v1" }
      }
    ]
  },
  "sink": { "type": "file", "dir": "./collectivus-data" }
}
```

Attach or detach Codex explicitly:

```bash
ctvs attach --config collectivus.json --client codex
ctvs detach --client codex
```

This writes a managed provider to `~/.codex/config.toml` using Codex's
documented `model_provider` / `model_providers.<id>` configuration format:

```toml
model_provider = "collectivus"

[model_providers.collectivus]
name = "Collectivus OpenAI Proxy"
base_url = "http://127.0.0.1:8787/v1"
requires_openai_auth = true
wire_api = "responses"
supports_websockets = false
```

`supports_websockets = false` keeps Codex on HTTP/SSE requests, which is the
proxy path collectivus records today. See OpenAI's Codex docs for the
underlying [configuration file](https://developers.openai.com/codex/config-basic#codex-configuration-file)
and [provider fields](https://developers.openai.com/codex/config-reference#model_providers).

## Local query

`ctvs query` reads local recordings only. It never contacts S3 and it does not
auto-refresh its Parquet cache unless you ask for that explicitly.

```bash
ctvs query refresh --config collectivus.json
ctvs query logs --config collectivus.json --since 1h
ctvs query traces slow --config collectivus.json --limit 20
ctvs query metrics series latency.ms --config collectivus.json
ctvs query proxy get <conversation-id> --config collectivus.json --format json
ctvs query sql "select serviceName, count(*) as logs from logs group by serviceName"
```

Cache files are written under
`<recording-root>/.collectivus-query/parquet/<dataset>/gateway_id=<id>/date=<YYYY-MM-DD>/data.parquet`
with `data.parquet.meta.json` sidecars.

Freshness is treated asymmetrically (since v1.7.0):

| Partition state | Behavior |
| --- | --- |
| `fresh` | Query proceeds silently. |
| `stale` (Parquet exists, may be outdated) | Query proceeds; a `warning: querying stale data; …` line is written to stderr. Stdout is unchanged. |
| `missing` (no Parquet at all) | Query exits with the exact `ctvs query refresh …` command to run. |

Use `--refresh always` to force a refresh before the query runs. Use
`--strict-freshness` to restore the pre-1.7 behavior where stale partitions
are a hard error (useful in CI / scheduled jobs that must never read
outdated data).

> **Migration note (v1.7.0).** Stale partitions no longer exit non-zero
> by default — scripts that depended on that exit code must add
> `--strict-freshness`. Stdout formats (table, json, jsonl, markdown) are
> unchanged; the new warning is written only to stderr. `missing`
> partitions still error.

Logical datasets are `logs`, `traces`, `metrics`, and `proxy_messages`. `ctvs query schema <dataset>` prints the static schema, and `ctvs query catalog` shows which datasets have source and cached rows.

### Conversation log model

Recorded LLM proxy traffic is exposed as a single logical dataset, `proxy_messages`. Each row is one content part — a text block, reasoning block, tool call, tool result, image, file, or error — so a single assistant turn that contains text + a tool call + more text becomes three rows. The grain is per-part on purpose: callers can filter, count, and join parts without unpacking nested JSON, and downstream analytics (`SUM(usage)`, conversation walks, tool-call/result joins) become single-table SQL.

Rows are globally deduplicated by `message_id` — a 16-character hex prefix of `sha256(conversation_id : role : canonicalJson(content))`. Identical content in the same conversation always produces the same id, so the user-history blocks that Anthropic replays on every request are written once. The walker also tracks `previous_message_id` across exchanges so callers can reconstruct conversation order even after dedup.

`conversation_id` is resolved tiered — Claude Code's `metadata.user_id.session_id` when present, otherwise a stable 16-hex hash of the first user message's content, otherwise a hash of `exchange_id` (so even single-shot malformed exchanges get a deterministic id). `conversation_source` is `claude_code` when the recorded user-agent starts with `claude-cli/`, else `api`.

JSON columns (`attributes`, `status`, `tools`, `tool_args`) carry sparse structured data; scalars are accessed with `JSON_VALUE(<col>, '$.path')`. `attributes` holds request settings, per-message `usage` (assistant only) and `timing.latency_ms`; `status` holds `tool_status` on tool results, `finish_reason` on the last assistant part, and `error_code` / `error_message` on error parts. JSONL capture is unchanged — the dataset is purely a derived projection over the recorded `exchange` and `stream_event` rows.

For the full per-column derivation table see [skills/collectivus-query/references/query-cli.md](skills/collectivus-query/references/query-cli.md).

### LLM skill

Install the bundled `collectivus-query` skill so Claude Code and Codex know how
to inspect local recordings with `ctvs query`:

```bash
ctvs skills install --client all
```

The skill assumes the default `~/.hyp/collectivus.json` config unless the agent
discovers a non-default service config from `ctvs status` or the service unit.

## CLI

```text
ctvs --config <path>                         Run with config file
ctvs --config <path> --print-config          Validate + print resolved config
ctvs query <command> [...]                   Query local recordings
ctvs export --config <path> [...]            Convert recorded JSONL to local Parquet (one-shot)
ctvs --help                                  Show usage
```

`SIGINT` and `SIGTERM` trigger graceful shutdown: stop accepting new requests,
drain in-flight, fsync sinks, exit 0.

### Export to Parquet on demand

`ctvs export` walks the configured sink dir and converts what it finds
into local Parquet. Runs once and exits — independent of the daily upload
scheduler, and includes today's open files (which the upload pipeline
deliberately skips).

Two sinks are drained:

| Source | Destination |
| --- | --- |
| `<sink.dir>/<gateway_id>/proxy/<date>.jsonl` (proxy recorder) | `<out>/proxy/messages.parquet` |
| `<sink.dir>/<gateway_id>/<signal>/<date>.jsonl` (OTLP) | `<out>/<gateway_id>/<signal>/date=<YYYY-MM-DD>/data.parquet` |

Proxy export walks each gateway's days chronologically so the conversation
walker can dedupe `message_id`s across day boundaries, then concatenates the
result into a single `messages.parquet` file. The per-day `kind: "exchange"` /
`kind: "stream_event"` JSONL rows on disk are unchanged — only the Parquet
projection was reshaped.

```text
ctvs export --config <path> [--out <dir>] [--date YYYY-MM-DD]
                            [--gateway-id <id>] [--signal logs|traces|metrics]
```

`--date`, `--gateway-id`, and `--signal` only filter the OTLP path; proxy
JSONL is always drained when present.

## Programmatic use

```javascript
import { Collector } from 'collectivus'

const collector = new Collector({ port: 4318, outputDir: './otel-data' })
await collector.start()
// ...
await collector.stop()
```

The proxy is config-driven only — programmatic embedding of the proxy is not
yet a supported public API.

## Install as a daemon (macOS, Linux)

Keep collectivus running across reboots by registering it with the system
process supervisor — a user LaunchAgent on macOS, a systemd user unit on
Linux — and (optionally) route [Claude Code](https://docs.claude.com/en/docs/claude-code/overview)
through the proxy in the same step.

### Quickstart (macOS)

```bash
npm install -g collectivus
ctvs install --config /path/to/collectivus.json
# Configure Claude Code to use this proxy? [Y/n] y
# ✓ Daemon installed (LaunchAgent: com.hyparam.collectivus)
# ✓ Claude Code attached (~/.claude/settings.json)
# Logs: ~/.hyp/collectivus/collectivus.log
```

The LaunchAgent is set with `RunAtLoad=true` and `KeepAlive=true`, so the
daemon starts at login and launchd restarts it if it exits. Logs land in
`~/.hyp/collectivus/`:

- `collectivus.log` — stdout
- `collectivus.err.log` — stderr

### Quickstart (Linux, systemd)

```bash
npm install -g collectivus
ctvs install --config /path/to/collectivus.json
# ✓ Daemon installed (systemd unit: com.hyparam.collectivus.service)
# ✓ Claude Code attached (~/.claude/settings.json)
```

On Linux, `install` writes a systemd user unit to
`~/.config/systemd/user/com.hyparam.collectivus.service`, runs
`systemctl --user daemon-reload`, then `enable` and `restart`. The unit is
configured with `Restart=always`, `RestartSec=5`, and
`WantedBy=default.target` so systemd starts it at login and respawns it on
exit. Logs are written via `StandardOutput=append:` /
`StandardError=append:` to the directory you pass as `logDir` (the CLI
defaults to `~/.hyp/collectivus`).

> **Linger required for non-login boots.** User-level systemd services run
> only while the user has a session. To keep the daemon up across reboots
> when you are not logged in (e.g. a headless server), enable lingering
> once:
>
> ```bash
> sudo loginctl enable-linger "$USER"
> ```
>
> Without this, the unit stops when your last login session ends and only
> restarts when you log back in.

System-level systemd units (root-owned, in `/etc/systemd/system/`) and
non-systemd init systems (Alpine's OpenRC, Void's runit, etc.) are not
supported in this build.

### Why a global install

`install` requires a global binary (`npm install -g collectivus`) so the
LaunchAgent's `ProgramArguments` can point at a stable path. Running
`install` via `npx` is rejected with a clear error, because `npx` resolves
the binary into a per-invocation cache that is not stable across runs.

### Subcommands

| Command | Purpose |
|---------|---------|
| `ctvs install --config <path> [--yes\|--no]` | Install LaunchAgent and (optionally) attach Claude Code |
| `ctvs uninstall` | Stop and remove the LaunchAgent; revert any attached clients (Claude Code, Codex) |
| `ctvs attach (--config <path> \| --port <n>) [--client claude\|codex\|all]` | Route Claude Code and/or Codex through the proxy without touching the daemon |
| `ctvs detach [--client claude\|codex\|all]` | Revert Claude Code and/or Codex without uninstalling the daemon |
| `ctvs status` | Print daemon (loaded / PID) and Claude Code (attached) state |
| `ctvs export --config <path> [...]` | Convert recorded JSONL to local Parquet without invoking the upload scheduler |
| `ctvs query <command> [...]` | Query local recordings through the explicit Parquet cache |
| `ctvs skills install [--client claude\|codex\|all]` | Install the bundled Collectivus query LLM skill |

If stdin is not a TTY, `install` refuses to guess: pass `--yes` to attach
Claude Code unattended, or `--no` to skip the attach step.

### Status

```bash
ctvs status
# Daemon
#   Status: loaded (PID 12345)
#   Plist: /Users/you/Library/LaunchAgents/com.hyparam.collectivus.plist
#   Config: /path/to/collectivus.json
#   Logs:
#     stdout: /Users/you/Library/Logs/Collectivus/collectivus.log
#     stderr: /Users/you/Library/Logs/Collectivus/collectivus.err.log
#
# Claude Code
#   Status: attached
#   Attached at: 2026-05-07T16:30:00.000Z
#   Port: 8787
#   Marker version: 1.1.0
#   Settings: /Users/you/.claude/settings.json
```

> On Linux, `ctvs status` does not yet report systemd unit state.
> Use `systemctl --user status com.hyparam.collectivus.service` for the
> daemon view; `ctvs status` will still report Claude Code attach
> state correctly.

### Reverting

```bash
ctvs detach [--client claude|codex|all]          # un-route, leave daemon running
ctvs uninstall                                   # remove daemon and revert attached clients
```

All revert paths are idempotent and tolerate already-reverted state.
