# Collectivus Query CLI Reference

`ctvs query` reads local Collectivus recordings. It materializes JSONL source files into a local Parquet cache under:

```text
<recording-root>/.collectivus-query/parquet/<dataset>/gateway_id=<id>/date=<YYYY-MM-DD>/data.parquet
```

The cache is explicit. Query commands do not refresh it unless `--refresh always` is passed.

Freshness is asymmetric (since v1.7.0):

- `fresh` — query proceeds silently.
- `stale` (Parquet exists but may be outdated) — query proceeds and writes a `warning: querying stale data; N partition(s) outdated [...] — run '...' to update` line to stderr. Stdout is unchanged.
- `missing` (no Parquet at all) — query exits with the exact `ctvs query refresh ...` command to run.

Pass `--strict-freshness` to restore the pre-1.7 behavior where stale partitions are a hard error.

Commands default to `~/.hyp/collectivus.json`. If the running gateway or OTEL collector was installed with another config, discover it once with `ctvs status` or the service definition, then add `--config <path>` to the examples below.

## Shared Options

- `--config <path|url>`: Collectivus config. Defaults to `~/.hyp/collectivus.json`.
- `--parquet-dir <dir>`: Override the query cache directory.
- `--from <timestamp>` / `--to <timestamp>`: Inclusive timestamp bounds.
- `--since <duration>`: Relative lower bound such as `15m`, `2h`, or `7d`.
- `--date <YYYY-MM-DD>`: Restrict to one UTC date partition.
- `--gateway-id <id>`: Restrict to one gateway id.
- `--service <name>`: Restrict `serviceName` for logs, traces, and metrics.
- `--limit <n>`: Maximum rows to render. Default `100`, maximum `1000`.
- `--format <fmt>`: `table`, `json`, `jsonl`, or `markdown`.
- `--refresh <mode>`: `never` or `always`. Default `never`.
- `--strict-freshness`: Treat stale partitions as a hard error (pre-1.7 behavior). Off by default.

## Commands

- `ctvs query doctor`: Check config, recording root, source files, and cache freshness.
- `ctvs query status`: Inspect source partitions and cache freshness.
- `ctvs query catalog`: List logical datasets, columns, source partitions, and cached row counts.
- `ctvs query schema <dataset>`: Print static schema for a logical dataset.
- `ctvs query refresh [dataset] [--force]`: Materialize local JSONL into query-cache Parquet.
- `ctvs query sample <dataset>`: Show sample rows.
- `ctvs query sql <select-sql>`: Run read-only SQL over logical datasets.
- `ctvs query logs [count|tail]`: List logs, count logs, or tail live JSONL without requiring cache.
- `ctvs query traces [slow|errors]`: List traces, slow traces, or error spans.
- `ctvs query trace <trace-id>`: Show spans for one trace.
- `ctvs query metrics <list|series|latest|summary> [metric-name]`: Inspect metrics.
- `ctvs query proxy [get|events|stats|tail] [exchange-id]`: Inspect LLM proxy exchanges and stream events.
- `ctvs query activity`: Combined recent activity from logs, traces, metrics, and proxy exchanges.
- `ctvs query service <service-name>`: Service-focused summary across logs, traces, and metrics.
- `ctvs query errors`: Recent log, trace, and proxy errors.

## Logical Datasets

- `logs`: OTLP log records. Common columns include `gateway_id`, `date`, `timestamp`, `observedTimestamp`, `severityNumber`, `severityText`, `serviceName`, `body`, `traceId`, `spanId`, `resource`, `scope`, and `attributes`.
- `traces`: OTLP spans. Common columns include `gateway_id`, `date`, `traceId`, `spanId`, `parentSpanId`, `name`, `kind`, `startTimestamp`, `endTimestamp`, `durationMs`, `status`, `serviceName`, `resource`, `scope`, and `attributes`.
- `metrics`: OTLP metric points. Common columns include `gateway_id`, `date`, `metricName`, `metricType`, `timestamp`, `startTimestamp`, `serviceName`, `value`, `valueInt`, `count`, `sum`, `unit`, `resource`, `scope`, and `attributes`.
- `proxy_exchanges`: One row per recorded LLM proxy exchange. Common columns include `gateway_id`, `date`, `exchangeId`, `tsStart`, `tsEnd`, `durationMs`, `upstream`, `requestMethod`, `requestPath`, `responseStatus`, `streamEventCount`, and `error`.
- `proxy_stream_events`: One row per streaming event. Common columns include `gateway_id`, `date`, `exchangeId`, `tMs`, `event`, and `data`.

Run `ctvs query schema <dataset> --format json` for the exact columns in the installed version.

## Example SQL

```bash
ctvs query sql "select serviceName, count(*) as logs from logs group by serviceName order by logs desc" --format json
ctvs query sql "select upstream, responseStatus, count(*) as exchanges from proxy_exchanges group by upstream, responseStatus order by exchanges desc" --format markdown
ctvs query sql "select traceId, name, durationMs from traces order by durationMs desc limit 20" --refresh always --format json
```

SQL must be a read-only `select` over the logical datasets above.
