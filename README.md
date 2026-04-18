# Collectivus

Zero-dependency OTLP/HTTP JSON collector that writes to JSONL files.

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

- `POST /v1/traces` - Receive trace data
- `POST /v1/metrics` - Receive metrics data
- `POST /v1/logs` - Receive log data

## Output

Data is written to JSONL files in the output directory:

```
otel-data/
├── traces.jsonl
├── metrics.jsonl
└── logs.jsonl
```

Each line is a JSON object representing the received payload.

## Verification

```bash
# Start the collector
node bin/cli.js

# Send test data
curl -X POST localhost:4318/v1/traces -H 'Content-Type: application/json' -d '{"test": true}'

# Check output
cat otel-data/traces.jsonl
```

## License

MIT
