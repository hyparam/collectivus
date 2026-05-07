# Collectivus

OTLP collector and pass-through LLM proxy that records every request and
response to JSONL.

Two listeners in one Node process:

- **OTLP receiver** — accepts OpenTelemetry traces, metrics, and logs over
  HTTP, normalizes them, and writes JSONL by signal and by service.
- **LLM proxy** — pass-through reverse proxy for the Anthropic Messages API,
  capturing each request and every SSE event to a single `proxy.jsonl` file.

Pick one or run both. Zero runtime dependencies.

## Installation

```bash
npm install collectivus
```

## Quick start: record claude-code

```bash
# 1. Save examples/claude-code.json (proxy on 127.0.0.1:8787 → api.anthropic.com)
npx collectivus --config examples/claude-code.json

# 2. In another terminal:
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude

# 3. Run a prompt, then watch the recording:
tail -f collectivus-data/proxy.jsonl
```

Full step-by-step: [`docs/walkthrough-claude-code.md`](docs/walkthrough-claude-code.md).

## Configuration

Pass a JSON config with `--config <path>`. The schema:

```json
{
  "otel":  { "listen": "0.0.0.0:4318" },
  "proxy": {
    "listen": "127.0.0.1:8787",
    "upstreams": {
      "anthropic": {
        "base_url": "https://api.anthropic.com",
        "match": { "path_prefix": "/v1/messages" }
      }
    },
    "redact_headers": ["authorization", "x-api-key", "anthropic-api-key", "cookie", "set-cookie"]
  },
  "sink": { "type": "file", "dir": "./collectivus-data" }
}
```

| Block | Purpose |
|-------|---------|
| `otel`  | Enable the OTLP receiver. Omit to disable. |
| `proxy` | Enable the LLM proxy. Omit to disable. Requires `sink`. |
| `sink`  | Where the proxy writes `proxy.jsonl`. (OTLP output also lands under `sink.dir` when set.) |

`--print-config` loads, validates, and pretty-prints the resolved config:

```bash
npx collectivus --config collectivus.json --print-config
```

## OTLP receiver

The OTLP receiver accepts JSON and protobuf payloads on the standard endpoints:

- `POST /v1/traces`
- `POST /v1/metrics`
- `POST /v1/logs`

Output layout under `sink.dir` (or the legacy `--output` directory):

```
collectivus-data/
├── traces/<UTC-date>.jsonl       # raw export envelope
├── metrics/<UTC-date>.jsonl
├── logs/<UTC-date>.jsonl
├── services/<service.name>/
│   ├── traces-<UTC-date>.jsonl   # one row per span
│   ├── metrics-<UTC-date>.jsonl  # one row per data point
│   └── logs-<UTC-date>.jsonl     # one row per log record
└── logs-by-service/<service.name>/<UTC-date>.jsonl   # legacy mirror
```

Each row in `services/` is a normalized JSON object — span, data point, or
log record — partitioned by `service.name`.

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

Two row kinds in `<sink.dir>/proxy.jsonl`:

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

## CLI

```text
collectivus --config <path>                  Run with config file
collectivus --config <path> --print-config   Validate + print resolved config
collectivus [--port <n>] [--output <dir>]    Legacy OTLP-only mode
collectivus                                  Legacy default (OTLP, port 4318, ./otel-data)
collectivus --help                           Show usage
```

`SIGINT` and `SIGTERM` trigger graceful shutdown: stop accepting new requests,
drain in-flight, fsync sinks, exit 0.

### Legacy mode

The bare `npx collectivus` and `--port` / `--output` invocations still launch
the OTLP receiver only. Two environment variables match the old flags:

- `COLLECTIVUS_PORT` — listen port (default `4318`)
- `COLLECTIVUS_OUTPUT_DIR` — output directory (default `./otel-data`)

Argv overrides env vars. Bare invocation now prints a deprecation hint
pointing at `--config`.

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
# Logs: ~/Library/Logs/Collectivus/collectivus.log
```

The LaunchAgent is set with `RunAtLoad=true` and `KeepAlive=true`, so the
daemon starts at login and launchd restarts it if it exits. Logs land in
`~/Library/Logs/Collectivus/`:

- `collectivus.log` — stdout
- `collectivus.err.log` — stderr

### Quickstart (Linux, systemd)

```bash
npm install -g collectivus
collectivus install --config /path/to/collectivus.json
# ✓ Daemon installed (LaunchAgent: com.hyparam.collectivus)
# ✓ Claude Code attached (~/.claude/settings.json)
```

On Linux, `install` writes a systemd user unit to
`~/.config/systemd/user/com.hyparam.collectivus.service`, runs
`systemctl --user daemon-reload`, then `enable` and `restart`. The unit is
configured with `Restart=always`, `RestartSec=5`, and
`WantedBy=default.target` so systemd starts it at login and respawns it on
exit. Logs are written via `StandardOutput=append:` /
`StandardError=append:` to the directory you pass as `logDir` (the CLI
defaults to `~/Library/Logs/Collectivus`, mirroring the macOS layout).

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
| `collectivus uninstall [--detach]` | Stop and remove the LaunchAgent; pass `--detach` to also revert Claude Code |
| `collectivus attach (--config <path> \| --port <n>)` | Route Claude Code through the proxy without touching the daemon |
| `collectivus detach` | Revert Claude Code without uninstalling the daemon |
| `collectivus status` | Print daemon (loaded / PID) and Claude Code (attached) state |

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
collectivus detach                 # un-route Claude Code, leave daemon running
collectivus uninstall              # prompt to detach if attached
collectivus uninstall --detach     # remove daemon AND un-route Claude Code
```

All revert paths are idempotent and tolerate already-reverted state.

### What gets written to `~/.claude/settings.json`

`attach` (and `install --yes`) edit settings.json to add two keys:

```jsonc
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787"
  },
  "_collectivus": {
    "attached_at": "2026-05-07T16:30:00.000Z",
    "version": "1.1.0",
    "port": 8787
  }
}
```

The `_collectivus` marker records what we wrote so `detach` can revert
cleanly. `detach` removes both keys, **but only when** `ANTHROPIC_BASE_URL`
still matches the recorded port — a manually overridden value is left in
place with a warning. All other keys in settings.json are preserved.

The file is written atomically (temp file + rename) so a crash mid-write
leaves the previous file intact, and `attach` refuses to overwrite a file
that changed on disk between read and write.

`settings.json` containing JSONC-style comments is rejected rather than
silently rewritten as plain JSON.

## License

MIT
