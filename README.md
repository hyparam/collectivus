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

## License

MIT
