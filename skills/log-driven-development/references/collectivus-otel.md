# Collectivus OTEL Instrumentation

Collectivus accepts OTLP/HTTP JSON and protobuf payloads on the standard endpoints:

```text
POST http://127.0.0.1:4318/v1/traces
POST http://127.0.0.1:4318/v1/metrics
POST http://127.0.0.1:4318/v1/logs
```

For normal OpenTelemetry SDKs, prefer the base endpoint:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT="http://127.0.0.1:4318"
export OTEL_SERVICE_NAME="<app-or-package>-dev"
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment=development"
```

Use signal-specific endpoints only when the SDK expects a complete URL:

```bash
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT="http://127.0.0.1:4318/v1/traces"
export OTEL_EXPORTER_OTLP_METRICS_ENDPOINT="http://127.0.0.1:4318/v1/metrics"
export OTEL_EXPORTER_OTLP_LOGS_ENDPOINT="http://127.0.0.1:4318/v1/logs"
```

## What To Instrument

Add automatic instrumentation when the stack has a maintained OpenTelemetry package, then add manual spans/logs around the app-specific edges automatic instrumentation cannot see.

Instrument:

- Process start, config load, migrations, seed/setup, and shutdown.
- HTTP handlers, route loaders/actions, RPC handlers, CLI commands, workers, queue consumers, cron jobs, and background tasks.
- Database/cache/file/network calls, retries, timeouts, rate limits, and fallback paths.
- Domain state transitions, validation decisions, permission checks, and feature flags.
- Smoke-test steps and assertions: `smoke_start`, `smoke_step`, `smoke_assertion`, `smoke_end`.
- Error paths with `error_kind`, `error_message`, and `recoverable` attributes.

Use attributes such as `dev_run_id`, `smoke_name`, `smoke_step`, `component`, `operation`, `status`, `domain_id`, `request_id`, and `trace_source`. Prefer bounded values; hash or truncate large values.

## Signal Choice

- Use traces for causality and latency: one span per unit of work, nested around calls and decisions.
- Use logs for discrete events, inputs/outputs summaries, branch choices, and assertions.
- Use metrics for counters and distributions that matter across runs: request counts, errors, retry counts, queue depth, token counts, LLM latency, smoke assertion counts.

For development, err on the side of too many spans and logs. Keep the switch local:

```bash
export COLLECTIVUS_DEV_TELEMETRY=1
export DEV_RUN_ID="smoke-$(date -u +%Y%m%dT%H%M%SZ)-$$"
```

## Manual OTLP/JSON Fallback

If the target app cannot reasonably add an SDK, emit OTLP/JSON directly. Keep this fallback small, non-blocking where possible, and dev-only.

Minimal log export:

```json
{
  "resourceLogs": [{
    "resource": { "attributes": [
      { "key": "service.name", "value": { "stringValue": "example-dev" } }
    ] },
    "scopeLogs": [{
      "scope": { "name": "log-driven-development" },
      "logRecords": [{
        "timeUnixNano": "1710000000000000000",
        "severityText": "INFO",
        "body": { "stringValue": "smoke_step" },
        "attributes": [
          { "key": "dev_run_id", "value": { "stringValue": "smoke-20260518T120000Z-123" } },
          { "key": "smoke_step", "value": { "stringValue": "create-record" } },
          { "key": "status", "value": { "stringValue": "ok" } }
        ]
      }]
    }]
  }]
}
```

Minimal trace export:

```json
{
  "resourceSpans": [{
    "resource": { "attributes": [
      { "key": "service.name", "value": { "stringValue": "example-dev" } }
    ] },
    "scopeSpans": [{
      "scope": { "name": "log-driven-development" },
      "spans": [{
        "traceId": "0123456789abcdef0123456789abcdef",
        "spanId": "0123456789abcdef",
        "name": "smoke.create-record",
        "kind": 1,
        "startTimeUnixNano": "1710000000000000000",
        "endTimeUnixNano": "1710000000100000000",
        "attributes": [
          { "key": "dev_run_id", "value": { "stringValue": "smoke-20260518T120000Z-123" } },
          { "key": "component", "value": { "stringValue": "records" } }
        ],
        "status": { "code": 1 }
      }]
    }]
  }]
}
```

Collectivus normalizes OTLP attributes into JSON objects in query tables. Custom snake_case keys can be queried directly with `JSON_VALUE(attributes, '$.dev_run_id')`.

## Queryable Output

OTLP rows land under the configured recording root and are queryable as:

- `logs`: `timestamp`, `severityText`, `serviceName`, `body`, `traceId`, `spanId`, `resource`, `scope`, `attributes`.
- `traces`: `startTimestamp`, `endTimestamp`, `durationMs`, `serviceName`, `name`, `traceId`, `spanId`, `status`, `resource`, `scope`, `attributes`.
- `metrics`: `timestamp`, `serviceName`, `metricName`, `metricType`, `value`, `valueInt`, `count`, `sum`, `unit`, `attributes`.

Use `ctvs query schema <table> --format markdown` when column names matter.
