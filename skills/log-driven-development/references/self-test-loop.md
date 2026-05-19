# Self-Test And Query Loop

The loop is: instrument, smoke, query, fix, repeat. A smoke run is not complete until both external assertions and internal telemetry look right.

## Add A Smoke Command

Prefer one command that can run unattended:

```bash
DEV_RUN_ID="smoke-$(date -u +%Y%m%dT%H%M%SZ)-$$" npm run smoke
```

If the project does not have `npm`, use the repo's native test runner or add a small script in the established local style.

The smoke command should:

- Set or print `DEV_RUN_ID`.
- Start the smallest needed local services or reuse an existing dev server.
- Exercise one complete user or agent workflow.
- Emit telemetry at every step.
- Make explicit assertions on both outputs and key side effects.
- Exit non-zero on failure.

Examples of smoke telemetry:

- `smoke_start` log with `dev_run_id`, `smoke_name`, git branch/sha when available.
- One span per step: `smoke.load-page`, `smoke.submit-form`, `smoke.agent-run`, `smoke.assert-result`.
- `smoke_assertion` logs with `assertion`, `expected`, `actual_summary`, and `status`.
- `smoke_end` log with `status`, `duration_ms`, and failure summary.

## Query After Each Run

Start broad, then narrow by service and `dev_run_id`.

```bash
ctvs query status
ctvs query logs --since 15m --service <service-name> --format json
ctvs query traces slow --since 15m --service <service-name> --limit 20 --format json
ctvs query errors --since 15m --format json
```

Run-specific SQL:

```bash
ctvs query sql "select timestamp, severityText, body, attributes from logs where serviceName = '<service-name>' and JSON_VALUE(attributes, '$.dev_run_id') = '<run-id>' order by timestamp" --refresh always --format json
```

```bash
ctvs query sql "select startTimestamp, durationMs, name, status, attributes from traces where serviceName = '<service-name>' and JSON_VALUE(attributes, '$.dev_run_id') = '<run-id>' order by startTimestamp" --refresh always --format json
```

For agent JSONL:

```bash
ctvs collect --glob '.collectivus/agents/**/*.jsonl' --name app-agent-events --timestamp-column timestamp --replace
ctvs query sql "select timestamp, agent_id, phase, event_type, status, tool_name, error_message from app_agent_events where dev_run_id = '<run-id>' order by timestamp" --refresh always --format json
```

If a query reports a missing partition, run the exact `ctvs query refresh <file.jsonl>` command it prints. If it warns about stale cache data, either tell the user the cache is stale or rerun with `--refresh always`.

## Decide From Evidence

After each run, classify the result:

- No telemetry arrived: endpoint/env/config issue. Verify `ctvs status`, OTLP endpoint, service name, and that the smoke path executes instrumented code.
- Logs arrived but no spans: trace SDK/exporter setup issue or manual spans not ended/flushed.
- Spans arrived but missing run id: context propagation or attribute wiring issue.
- Smoke assertions passed but internal sequence is wrong: add assertions or fix hidden behavior before calling the task done.
- Agent output is wrong but tool logs look right: inspect prompt/model/validation JSONL events.
- Agent tool logs are wrong: fix tool selection, arguments, or observation handling before changing prompt text.
- Errors appear without enough context: add structured attributes around the failing branch, then rerun.

Keep the loop tight. Prefer a 10-30 second smoke that emits rich telemetry over a broad test that takes minutes and hides the failing step.
