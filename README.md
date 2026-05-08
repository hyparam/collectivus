# Collectivus

Zero-dependency OTLP/HTTP collector that writes to JSONL files.

## Installation

```bash
npm install collectivus
```

## Usage

### CLI

```bash
# Start with defaults (port 4318, output ./otel-data)
npx collectivus

# Custom port and output directory
npx collectivus --port 8080 --output /var/log/otel
```

Configuration can also be supplied via environment variables, which is
convenient when wrapping the CLI in a process manager (launchd, systemd,
etc.) that passes config via `EnvironmentVariables`:

- `COLLECTIVUS_PORT` — listen port (default `4318`)
- `COLLECTIVUS_OUTPUT_DIR` — JSONL output directory (default `./otel-data`)

Argv takes precedence over environment variables when both are set.

The CLI handles `SIGINT` and `SIGTERM` for graceful shutdown.

### Programmatic

```javascript
import { Collector } from 'collectivus'

const collector = new Collector({
  port: 4318,
  outputDir: './otel-data'
})

await collector.start()
console.log('Collector running')

// To stop
await collector.stop()
```

## Endpoints

- `POST /v1/traces` - Receive trace data (`application/json` and `application/x-protobuf`)
- `POST /v1/metrics` - Receive metrics data (`application/json` and `application/x-protobuf`)
- `POST /v1/logs` - Receive log data (`application/json` and `application/x-protobuf`)

## Output

Data is written to JSONL files in the output directory:

```
otel-data/
├── traces/
│   └── YYYY-MM-DD.jsonl
├── metrics/
│   └── YYYY-MM-DD.jsonl
├── logs/
│   └── YYYY-MM-DD.jsonl
├── services/
│   └── <service.name>/
│       ├── traces-YYYY-MM-DD.jsonl
│       ├── metrics-YYYY-MM-DD.jsonl
│       └── logs-YYYY-MM-DD.jsonl
└── logs-by-service/
    └── <service.name>/
        └── YYYY-MM-DD.jsonl
```

Each line in `traces/`, `metrics/`, and `logs/` is the raw received payload. The `services/` tree is the normalized browse view: one JSON row per log record, span, or metric data point, partitioned by `service.name`. `logs-by-service/` is retained as a legacy compatibility mirror for normalized logs.

## Verification

```bash
# Start the collector
node bin/cli.js

# Send test data
curl -X POST localhost:4318/v1/traces -H 'Content-Type: application/json' -d '{"test": true}'

# Check output
cat otel-data/traces/$(date -u +%F).jsonl
```

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
