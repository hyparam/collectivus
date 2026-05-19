---
name: log-driven-development
description: Instrument applications and embedded LLM-agent workflows with Collectivus OTEL and local JSONL so Claude Code or Codex can self-test, query logs/traces/metrics, and iteratively fix issues. Use when building or modifying apps, adding smoke tests, debugging development loops, adding OpenTelemetry, capturing agent events, or using ctvs query/ctvs collect to close a log-driven feedback loop.
---

# Log Driven Development

## Overview

Treat telemetry as part of the development harness. Add instrumentation early, run a narrow smoke path with a unique run id, inspect Collectivus recordings, then fix or improve the app based on observed behavior.

## Core Loop

1. Pick a stable `service.name` and a per-run id such as `DEV_RUN_ID=smoke-<utc>-<pid>`.
2. Confirm the Collectivus OTLP endpoint before wiring code. Default local OTLP/HTTP is `http://127.0.0.1:4318`; signal endpoints are `POST /v1/traces`, `POST /v1/metrics`, and `POST /v1/logs`.
3. Instrument liberally around entrypoints, state transitions, branches, external calls, background jobs, tool calls, retries, validation checks, and error paths.
4. Add or update a smoke command that exercises the smallest complete workflow and emits telemetry for each step and assertion.
5. Run the smoke command, query the resulting `logs`, `traces`, `metrics`, and collected JSONL tables, then make the next code change from evidence rather than guesses.
6. Repeat until the smoke path succeeds and the telemetry shows the expected internal sequence, not just a passing exit code.

## Instrumentation Bias

Prefer broad, cheap, local-first instrumentation over sparse "production-quality" telemetry while developing. It is acceptable for dev telemetry to be chatty when it is guarded by environment flags, avoids secrets, and can be disabled or sampled before production.

Use structured attributes that are easy to query: `dev_run_id`, `smoke_name`, `smoke_step`, `component`, `operation`, `status`, `error_kind`, `tool_name`, `agent_id`, and domain ids. Prefer snake_case for custom attributes so SQL JSON paths stay simple. Keep high-cardinality or large values in local JSONL or short hashes/excerpts, not every OTEL span.

Do not record secrets, credentials, raw customer data, or private prompts by default. For LLM agents, record decisions, tool calls, model settings, token counts, latency, validation outcomes, content hashes, and short redacted excerpts; do not record hidden chain-of-thought.

## Reference Loading

- Read [references/collectivus-otel.md](references/collectivus-otel.md) when adding OpenTelemetry libraries, manual OTLP emitters, or Collectivus-specific endpoint configuration.
- Read [references/agent-jsonl.md](references/agent-jsonl.md) when the application contains LLM agents, planners, routers, tool callers, evaluators, or other model-driven flows that should write local JSONL for `ctvs collect`.
- Read [references/self-test-loop.md](references/self-test-loop.md) when adding the smoke command or querying the captured data after a run.

If the `collectivus-query` skill is available, use it for detailed `ctvs query` cache freshness and SQL rules. Otherwise run `ctvs query status`, prefer `--format json` for analysis, and refresh the exact source file when the CLI reports a missing cache partition.

## Done Criteria

- The app can run with telemetry enabled using documented env vars or dev config.
- Each smoke run has a queryable `dev_run_id` across logs/spans/metrics and any local agent JSONL table.
- The smoke test checks both external behavior and captured internal signals.
- Failures produce enough telemetry to identify which step, component, or agent decision failed.
- The final response mentions the smoke command and the key `ctvs query` or `ctvs collect` command used for verification.
