# Changelog

All notable changes to Collectivus are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
