# Collectivus

![collectivus](collectivus.jpg)

[![npm](https://img.shields.io/npm/v/collectivus)](https://www.npmjs.com/package/collectivus)
[![minzipped](https://img.shields.io/bundlephobia/minzip/collectivus)](https://www.npmjs.com/package/collectivus)
[![workflow status](https://github.com/hyparam/collectivus/actions/workflows/ci.yml/badge.svg)](https://github.com/hyparam/collectivus/actions)
[![mit license](https://img.shields.io/badge/License-MIT-orange.svg)](https://opensource.org/licenses/MIT)
[![dependencies](https://img.shields.io/badge/Dependencies-0-blueviolet)](https://www.npmjs.com/package/collectivus?activeTab=dependencies)

Collectivus is an OTLP collector and pass-through LLM proxy in pure Node.js. Two listeners in one process record everything to local JSONL: an OpenTelemetry receiver that normalizes traces, metrics, and logs by signal and service, and a transparent reverse proxy for LLM APIs that captures every request and SSE event. Pick one or run both.

- **OTLP receiver**: traces, metrics, and logs over HTTP, normalized to JSONL
- **LLM proxy**: transparent pass-through for Anthropic Messages and OpenAI-compatible APIs, full request/response capture
- **Zero dependencies**: Node built-ins only, single binary, instant startup

## Installation

```bash
npm install collectivus
```

## Quick start: record claude-code

The fastest path is the interactive walkthrough. Run `collectivus` with no
arguments and choose Standalone, Gateway, or Central server. Standalone keeps
config and recordings on this machine; Gateway pulls config from a central
server; Central server vendors per-gateway config and receives shipped ingest.
The walkthrough also asks where to write recordings and whether to install as
a daemon and attach Claude Code when the selected mode uses a local proxy:

```bash
npx collectivus
```

By default it writes the config to `~/.hyp/collectivus.json`, the sink to
`~/.hyp/collectivus/`, and (if you opt in) installs a LaunchAgent / systemd
user unit that boots at login.

Or write a config by hand:

```bash
# 1. Save examples/claude-code.json (proxy on 127.0.0.1:8787 → api.anthropic.com)
npx collectivus --config examples/claude-code.json

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
  "sink": { "type": "file", "dir": "./collectivus-data" }
}
```

| Block | Purpose |
|-------|---------|
| `version` | Schema version. Required. Currently `1`. |
| `otel`    | Enable the OTLP receiver. Omit to disable. |
| `proxy`   | Enable the LLM proxy. Omit to disable. Requires `sink`. |
| `sink`    | Root directory for JSONL recordings. Proxy rows land under `<sink.dir>/<gateway_id>/proxy/`; OTLP rows land under `<sink.dir>/<gateway_id>/<signal>/`. Required when `otel` or `proxy` is set. The walkthrough defaults this to `~/.hyp/collectivus/`. |
| `upload`  | Optional. Enables the daily S3 parquet drain. See [S3 upload](#s3-upload). |

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
npx collectivus --config collectivus.json --print-config
```

### v1 schema

`version: 1` introduces array-shape `upstreams`, an optional `upload` block,
and makes `sink` mandatory whenever `otel` or `proxy` is set. v0 configs
(missing the `version` field) hard-fail with a clear error — the walkthrough
writes v1 only.

## Config vending (multi-host deployments)

For fleets of gateways behind a single audit/storage backend, run one
collectivus host as the central server (`role: "server"`) and point each
managed host at it as a gateway (`role: "gateway"`). The central server vendors
per-gateway configs over `GET /v1/config` (with `If-None-Match` / `ETag`) and
accepts ingest from each gateway. Gateways pull their config every
`central_server.poll_interval_seconds` (default 30, range 5–3600) and
hot-reload only the listener whose section changed.

Operator workflow on the server host:

```bash
# 1. Issue a one-shot bootstrap token for a new gateway. Hand the printed token
#    to the gateway operator over a secure channel — it can be redeemed exactly
#    once.
collectivus config bootstrap-token issue gw-prod-1 --server-config /etc/collectivus-server.json
# → bt_abc123...

# 2. Register the per-gateway config the gateway will pull. Validated server-
#    side; an invalid file is rejected before any bytes hit disk.
collectivus config set gw-prod-1 --server-config /etc/collectivus-server.json --file gw-prod-1.json

# 3. Operator inspection / cleanup tools.
collectivus config get gw-prod-1 --server-config /etc/collectivus-server.json
collectivus config list --server-config /etc/collectivus-server.json
collectivus config delete gw-prod-1 --server-config /etc/collectivus-server.json
```

These commands are local operator tools for the central server host. They read
the server config only to find the same on-disk config registry and bootstrap
token store used by the running central server.

Gateway side, with the token pasted into `central_server.identity.bootstrap_token`:

```jsonc
// /etc/collectivus.json (gateway)
{
  "version": 1,
  "role": "gateway",
  "central_server": {
    "url": "https://collectivus.internal:8788",
    "identity": { "bootstrap_token": "bt_abc123..." }
  }
}
```

```bash
collectivus --config /etc/collectivus.json
# → exchanges the bootstrap token for a 30-day JWT, persists it to
#   ~/.hyp/collectivus/identity.json, then begins polling /v1/config.
```

Once the gateway has a JWT, the bootstrap token can be removed from the config
— refresh against the central server takes over until the JWT itself rotates.

The interactive walkthrough builds all three roles: Standalone, Gateway, and
Central server.

## S3 upload

Collectivus always writes raw JSONL to your local sink directory. When the
`upload` block is configured, a daily scheduler drains the previous day's
JSONL into Parquet partitions in S3. Object keys are Hive-partitioned:

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

Credentials are never stored in the config. They are resolved at daemon
start from the environment:

- `AWS_ACCESS_KEY_ID` (required)
- `AWS_SECRET_ACCESS_KEY` (required)
- `AWS_SESSION_TOKEN` (optional, for temporary credentials)
- `AWS_REGION` (optional; the `upload.region` config field overrides this)

When `upload` is set in the config but `AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY` are missing from the environment, the daemon
fails fast at startup rather than at the first daily tick.

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
npx collectivus --config collectivus.json &
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
collectivus attach --config collectivus.json --client codex
collectivus detach --client codex
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

## CLI

```text
collectivus --config <path>                  Run with config file
collectivus --config <path> --print-config   Validate + print resolved config
collectivus export --config <path> [...]     Convert recorded JSONL to local Parquet (one-shot)
collectivus --help                           Show usage
```

`SIGINT` and `SIGTERM` trigger graceful shutdown: stop accepting new requests,
drain in-flight, fsync sinks, exit 0.

### Export to Parquet on demand

`collectivus export` walks the configured sink dir and converts what it finds
into local Parquet. Runs once and exits — independent of the daily upload
scheduler, and includes today's open files (which the upload pipeline
deliberately skips).

Two sinks are drained:

| Source | Destination |
| --- | --- |
| `<sink.dir>/<gateway_id>/proxy/<date>.jsonl` (proxy recorder) | `<out>/proxy/exchanges.parquet`, `<out>/proxy/stream_events.parquet` |
| `<sink.dir>/<gateway_id>/<signal>/<date>.jsonl` (OTLP) | `<out>/<gateway_id>/<signal>/date=<YYYY-MM-DD>/data.parquet` |

The two proxy row kinds (`exchange` and `stream_event`) get their own typed
schemas. Headers are JSON columns; bodies are preserved as strings.

```text
collectivus export --config <path> [--out <dir>] [--date YYYY-MM-DD]
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
collectivus install --config /path/to/collectivus.json
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
collectivus install --config /path/to/collectivus.json
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
| `collectivus install --config <path> [--yes\|--no]` | Install LaunchAgent and (optionally) attach Claude Code |
| `collectivus uninstall` | Stop and remove the LaunchAgent; revert any attached clients (Claude Code, Codex) |
| `collectivus attach (--config <path> \| --port <n>) [--client claude\|codex\|all]` | Route Claude Code and/or Codex through the proxy without touching the daemon |
| `collectivus detach [--client claude\|codex\|all]` | Revert Claude Code and/or Codex without uninstalling the daemon |
| `collectivus status` | Print daemon (loaded / PID) and Claude Code (attached) state |
| `collectivus export --config <path> [...]` | Convert recorded JSONL to local Parquet without invoking the upload scheduler |

If stdin is not a TTY, `install` refuses to guess: pass `--yes` to attach
Claude Code unattended, or `--no` to skip the attach step.

### Status

```bash
collectivus status
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

> On Linux, `collectivus status` does not yet report systemd unit state.
> Use `systemctl --user status com.hyparam.collectivus.service` for the
> daemon view; `collectivus status` will still report Claude Code attach
> state correctly.

### Reverting

```bash
collectivus detach [--client claude|codex|all]   # un-route, leave daemon running
collectivus uninstall                            # remove daemon and revert attached clients
```

All revert paths are idempotent and tolerate already-reverted state.
