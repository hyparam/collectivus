# Local JSONL For LLM Agents

Applications that embed LLM agents should write a local append-only JSONL event stream in addition to OTEL. OTEL gives causality and latency; JSONL preserves agent-specific event shape that is easier to query with `ctvs collect`.

## File Layout

Use a local, gitignored path:

```text
.collectivus/agents/<agent-id>/<YYYY-MM-DD>.jsonl
```

If the repo uses another runtime/log directory, follow that convention, but keep files local, append-only, and easy to glob. Add the path to `.gitignore` unless the repo already ignores the parent directory.

Register the stream:

```bash
ctvs collect --glob '.collectivus/agents/**/*.jsonl' \
  --name app-agent-events \
  --timestamp-column timestamp \
  --replace
ctvs query schema app_agent_events --format markdown
```

`ctvs collect` infers top-level fields as SQL columns. Keep common fields top-level and put rare or nested details in `metadata`.

## Event Shape

Use one JSON object per line. Keep field names stable.

```jsonl
{"timestamp":"2026-05-18T19:00:00.000Z","dev_run_id":"smoke-20260518T190000Z-123","agent_id":"planner","conversation_id":"conv-abc","turn_id":"turn-001","event_type":"tool_call","phase":"act","status":"started","model":"claude-opus-4-7","provider":"anthropic","tool_name":"search_inventory","tool_call_id":"toolu_123","latency_ms":null,"input_sha256":"a1b2","output_sha256":null,"content_excerpt":"search inventory for sku prefix","metadata":{"route":"inventory.lookup"}}
```

Recommended top-level fields:

- `timestamp`: ISO-8601 UTC time. Use this with `--timestamp-column timestamp`.
- `dev_run_id`: matches the smoke/test run id used in OTEL.
- `agent_id`: stable logical agent name.
- `conversation_id`, `turn_id`, `parent_turn_id`: correlate multi-turn flows.
- `event_type`: `run_start`, `prompt_built`, `model_request`, `model_response`, `tool_call`, `tool_result`, `decision`, `validation`, `run_end`, `error`.
- `phase`: `plan`, `act`, `observe`, `reflect`, `evaluate`, or a domain-specific phase.
- `status`: `started`, `ok`, `error`, `skipped`, `retrying`.
- `model`, `provider`: model metadata when applicable.
- `tool_name`, `tool_call_id`: tool correlation when applicable.
- `latency_ms`, `prompt_tokens`, `completion_tokens`, `total_tokens`: numeric cost/performance fields.
- `input_sha256`, `output_sha256`: stable hashes for large or sensitive content.
- `content_excerpt`: short redacted excerpt for local debugging.
- `error_kind`, `error_message`: bounded error detail.
- `metadata`: nested JSON for rare details.

## What To Log

Log:

- Agent run start/end with inputs summarized by id/hash.
- Prompt/template version, selected tools, model, temperature, max tokens, and safety settings.
- Retrieval/search query summaries, hit counts, chosen ids, and score ranges.
- Tool call arguments after redaction, tool results summarized by ids/counts/status, and latency.
- Model response metadata, finish reason, token usage, and structured output validation results.
- Decisions and routing choices as explicit data: `decision`, `alternatives`, `reason_code`, `confidence`.
- Evaluator or smoke-test assertions: expected, actual summary, pass/fail, and linked domain ids.
- Errors, retries, cancellations, and fallbacks.

Do not log hidden chain-of-thought. When reasoning is useful, log a brief decision rationale or machine-readable reason code instead.

## Writer Requirements

The writer should:

- Create parent directories.
- Append exactly one compact JSON object plus `\n` per event.
- Avoid partial lines where possible.
- Never throw in the main application path because logging failed.
- Redact secrets before writing.
- Include `dev_run_id` on every event when available.

In tests and local smokes, assert that at least one event was written for each expected agent phase. Then use `ctvs collect` and SQL to inspect the same file from the outside.

## Query Examples

```bash
ctvs query sql "select event_type, status, count(*) as events from app_agent_events group by event_type, status order by events desc" --format markdown
```

```bash
ctvs query sql "select timestamp, agent_id, phase, event_type, status, tool_name, error_message from app_agent_events where dev_run_id = '<run-id>' order by timestamp" --refresh always --format json
```

```bash
ctvs query sql "select agent_id, avg(latency_ms) as avg_latency_ms, count(*) as calls from app_agent_events where event_type in ('model_response', 'tool_result') and latency_ms is not null group by agent_id order by avg_latency_ms desc" --format markdown
```
