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
