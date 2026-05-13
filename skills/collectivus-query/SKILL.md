---
name: collectivus-query
description: Inspect local Collectivus recordings with the ctvs query CLI. Use when the user asks about recorded logs, traces, metrics, LLM proxy exchanges, query cache freshness, or wants SQL over local Collectivus data.
---

# Collectivus Query

Use `ctvs query` to inspect local Collectivus recordings. It reads local JSONL recordings and an explicit local Parquet cache; it does not query S3.

## Workflow

1. Run `ctvs query doctor` or `ctvs query status` first to verify the recording root and cache state.
2. If the command cannot find the intended config, discover the service config once with `ctvs status`, a LaunchAgent/systemd unit, or the user, then reuse `--config <path>` only for that setup.
3. Cache freshness is handled asymmetrically:
   - **Stale partitions are queried by default** and the CLI prints a `warning: querying stale data; …` line to stderr. Read stderr alongside stdout, and surface any stale warning to the user so they know the data may be outdated (and can rerun with `--refresh always` to update).
   - **Missing partitions still error.** Run the exact `ctvs query refresh …` command the CLI prints, or rerun the target query with `--refresh always`.
   - Pass `--strict-freshness` only when the user explicitly needs the pre-1.7 strict mode (e.g., scheduled checks that must never read stale data); it turns stale partitions back into a hard error.
4. Prefer structured output for analysis: use `--format json` for follow-up reasoning, `--format markdown` when showing a table to the user, and `--limit` to keep output bounded.
5. Use high-level query commands before custom SQL. Switch to `ctvs query sql` only when the built-in commands cannot answer the question.

## Common Commands

These commands assume the service uses the default config path. Add `--config <path>` only when the installed gateway or OTEL collector uses a non-default config.

```bash
ctvs query status
ctvs query catalog --format json
ctvs query logs --since 1h --format json
ctvs query traces slow --limit 20 --format json
ctvs query metrics list --format json
ctvs query metrics series <metric-name> --format json
ctvs query proxy get <exchange-id> --format json
ctvs query proxy events <exchange-id> --format json
ctvs query errors --since 24h --format json
```

## Guardrails

- Do not assume the cache auto-refreshes. Query commands default to `--refresh never`, and stale partitions return data with a stderr warning rather than refreshing themselves.
- Always read stderr. A successful exit code does not mean the data is fresh — a `warning: querying stale data; …` line on stderr means stdout reflects outdated Parquet, and the user should be told before drawing conclusions.
- Do not paste `--config` into every command by habit. Use it when discovery shows the service is not using `~/.hyp/collectivus.json`.
- Do not read arbitrary Parquet files directly for `ctvs query sql`; the CLI only allows logical tables.
- Keep SQL read-only and use only logical datasets: `logs`, `traces`, `metrics`, `proxy_exchanges`, and `proxy_stream_events`.
- Use UTC dates with `--date YYYY-MM-DD`.
- Use `--service`, `--gateway-id`, `--from`, `--to`, or `--since` to narrow broad investigations.

## Reference

For full command details, datasets, and example SQL, read [references/query-cli.md](references/query-cli.md).
