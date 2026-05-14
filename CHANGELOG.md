# Changelog

All notable changes to Collectivus are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.0.0] — 2026-05-13

### Changed (breaking)

- **Proxy Parquet schema replaced.** The `proxy_exchanges` and
  `proxy_stream_events` Parquet datasets are removed. A new `proxy_messages`
  dataset takes their place with one row per content part, globally
  deduplicated by content-derived `message_id`. JSONL capture is unchanged —
  on-disk `kind: "exchange"` and `kind: "stream_event"` rows are still
  recorded as before; only the derived Parquet projection was reshaped.
- `ctvs export` now writes a single `<out>/proxy/messages.parquet` (was
  `<out>/proxy/exchanges.parquet` + `<out>/proxy/stream_events.parquet`).
- `ctvs query proxy get` now takes a `<conversation-id>` (previously
  `<exchange-id>`) and returns the conversation's part rows in
  `(message_index, part_index)` order.
- `ctvs query proxy events` is removed; query `proxy_messages` directly for
  the reconstructed assistant content.
- The query cache schema version is bumped (1 → 2), so existing Parquet
  caches are invalidated. The first query after upgrade triggers a full
  rebuild from JSONL.

### Migration

Old queries against `proxy_exchanges` / `proxy_stream_events` must be
rewritten against `proxy_messages`. See
[skills/collectivus-query/SKILL.md](skills/collectivus-query/SKILL.md) for the
new schema reference, working SQL patterns, and dataset semantics.

## [1.7.0] — 2026-05-13

### Changed (breaking)

- **`ctvs query` allows stale Parquet cache by default.** Stale partitions
  (Parquet exists but may be outdated) now query successfully and emit a
  `warning: querying stale data; …` line to stderr instead of exiting non-zero.
  Stdout output (table, json, jsonl, markdown) is unchanged.
- `missing` partitions (no Parquet at all) still exit with the exact
  `ctvs query refresh …` command to run — that behavior is unchanged.

### Added

- `--strict-freshness` flag on `ctvs query` restores the pre-1.7 behavior
  where stale partitions are a hard error. Use this in scheduled jobs or
  CI checks that must never read outdated data.

### Migration

Scripts that relied on a non-zero exit code from stale partitions must add
`--strict-freshness` to keep the old behavior. Everything else — including
`--refresh always`, the warning text format, and stdout schemas — is
unchanged.
