---
name: ctvs-gascity
description: Query the gascity event log and session-reconciler segments registered by `ctvs init gascity` in this workspace. Use when the user asks about gc agents, beads, orders, mail, sessions, or session-reconciler decisions.
---

# Gascity Query

This workspace has been registered with the `ctvs query` cache via `ctvs init gascity`. Two collection tables are available alongside the built-in datasets:

- **`events`** — one row per gascity event from `.gc/events.jsonl` (bead lifecycle, order execution, mail, sessions, controller events). Single source file.
- **`session_segments`** — one row per tracepoint from `.gc/runtime/session-reconciler-trace/segments/**/*.jsonl` (baseline, decision, mutation, operation records per session reconciler cycle). Glob-backed; many source files, one cache partition each.

Refer to the global [`collectivus-query`](../collectivus-query/SKILL.md) skill for cache freshness rules, `--format` options, and built-in datasets like `proxy_messages`.

## Agent targeting

There is no `cwd` column on these tables. Agent identity lives in different columns per table:

- `events.actor` — e.g. `hypcity-overrides.mayor`, `hypcity-overrides.refinery`, `hypcity-overrides.deacon`.
- `session_segments.template` — e.g. `hypcity-overrides.mayor` (city-scoped) or `collectivus/hypcity-overrides.polecat` (rig-scoped: `<rig>/<pack>.<agent>`).

Matching patterns:

```sql
-- a specific agent (city-scoped)
where actor = 'hypcity-overrides.mayor'

-- any rig's refinery
where template LIKE '%/hypcity-overrides.refinery'

-- everything in the collectivus rig
where template LIKE 'collectivus/%'
```

To cross-reference an agent's actions with its proxied LLM calls, join `template` (this skill) against `cwd` (global `proxy_messages` table) via the workspace path embedded in the rig prefix.

## Common queries

```sql
-- Recent beads closed by the mayor (last 24h)
SELECT ts, subject
FROM events
WHERE type = 'bead.closed'
  AND actor = 'hypcity-overrides.mayor'
  AND ts >= NOW() - INTERVAL '1 day'
ORDER BY ts DESC
LIMIT 50;

-- Order failures grouped by actor (last 24h)
SELECT actor, COUNT(*) AS failures
FROM events
WHERE type = 'order.failed'
  AND ts >= NOW() - INTERVAL '1 day'
GROUP BY actor
ORDER BY failures DESC;

-- Sleep reason distribution per template (session_baseline records)
SELECT
  template,
  JSON_VALUE(fields, '$.sleep_reason') AS sleep_reason,
  COUNT(*) AS n
FROM session_segments
WHERE _ctvs_raw LIKE '%session_baseline%'
GROUP BY template, sleep_reason
ORDER BY n DESC;

-- Decision/mutation trace for one session in a time window
SELECT ts, template, _ctvs_raw
FROM session_segments
WHERE template = 'hypcity-overrides.mayor'
  AND ts BETWEEN '2026-05-14T00:00:00Z' AND '2026-05-14T01:00:00Z'
ORDER BY ts;
```

Use `_ctvs_source_path` to see which segment file a row came from, and `_ctvs_line_number` for the line inside that file.

## Freshness

`session_segments` is glob-backed: new segment files only appear in the cache after a refresh. Run `ctvs query refresh session_segments` to pick up new segments, or use `--refresh always` on any query. Deleted segment files are pruned from the cache on the next refresh.

`events` is append-only single-file; mtime/size changes trigger re-materialization on refresh.

Full schemas: `ctvs query schema events --format markdown`, `ctvs query schema session_segments --format markdown`. Catalog: `ctvs query catalog --format markdown`.

## Refresh cost

Refreshing isn't free. `events.jsonl` and the `session_segments/**/*.jsonl` files registered by `ctvs collect` can be large — gascity ships hundreds of decision/mutation tracepoints per agent per hour — and re-materializing the Parquet partitions reads every byte that changed since the last refresh. On a busy workspace, a full refresh of `session_segments` can take tens of seconds and write tens of megabytes.

Recommended workflow:

1. Run `ctvs query status` first. The summary shows which date ranges are already cached and which are stale; cheap queries against a covered range never need a refresh.
2. Only invoke `--refresh always` or `ctvs query refresh <dataset>` when a needed date range is missing or `status` reports staleness in the window you care about.
3. Do not reflexively pass `--refresh always` "just in case". Stale-data queries print a warning to stderr (the default behavior); reading that warning is cheaper than re-materializing the cache. Treat refresh as a deliberate step, not a default.
