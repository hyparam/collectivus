# Recording claude-code with Collectivus

This walkthrough shows how to record every prompt, response, and stream event
from [`claude-code`](https://github.com/anthropics/claude-code) by routing it
through Collectivus's LLM proxy mode. The proxy is a transparent pass-through:
your `x-api-key` is forwarded verbatim to Anthropic, and a copy of the request
plus every SSE event is written to JSONL on disk.

The whole pipeline is local — no third-party services, no server-side keys.

## 1. Start collectivus with a proxy config

The fastest path is the interactive walkthrough — run `collectivus` with no
arguments and answer the prompts (LLM gateway proxy → Anthropic → defaults
→ install as daemon → attach Claude Code). It writes the config to
`~/.hyp/collectivus.json`, recordings to `~/.hyp/collectivus/`, and (if you
opt in) sets up the LaunchAgent / systemd unit and points Claude Code at
the proxy:

```bash
npx collectivus
```

The rest of this doc shows the manual config equivalent. Save this as
`collectivus.json`:

```json
{
  "proxy": {
    "listen": "127.0.0.1:8787",
    "upstreams": {
      "anthropic": {
        "base_url": "https://api.anthropic.com",
        "match": { "path_prefix": "/v1/messages" }
      }
    },
    "redact_headers": [
      "authorization",
      "x-api-key",
      "anthropic-api-key",
      "cookie",
      "set-cookie"
    ]
  },
  "sink": {
    "type": "file",
    "dir": "./collectivus-data"
  }
}
```

(There's a copy of this file in [`examples/claude-code.json`](../examples/claude-code.json).)

Launch collectivus:

```bash
npx collectivus --config collectivus.json
```

You should see:

```
Proxy listener bound on 127.0.0.1:8787, recording to ./collectivus-data/proxy.jsonl
```

## 2. Point claude-code at the proxy

In another terminal:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude
```

`claude-code` reads `ANTHROPIC_BASE_URL` and rewrites every Messages API call
to that origin. The proxy matches on `/v1/messages`, forwards the request to
`https://api.anthropic.com`, and tees the streaming response back to you while
recording it.

Run any prompt — the streamed response in your terminal is the live, unmodified
upstream traffic. Collectivus is observational only.

## 3. Watch traffic land in JSONL

```bash
tail -f collectivus-data/proxy.jsonl
```

Two row kinds interleave:

- `kind: "stream_event"` — one row per SSE event, with `t_ms` measured from
  exchange start. These appear live as the response streams.
- `kind: "exchange"` — written when the request finishes, with the full
  request body, redacted headers, response status, duration, and event count.

For example, a prompt that elicits one short message produces something like:

```jsonl
{"exchange_id":"…","kind":"stream_event","t_ms":42,"event":"message_start","data":"…"}
{"exchange_id":"…","kind":"stream_event","t_ms":78,"event":"content_block_start","data":"…"}
{"exchange_id":"…","kind":"stream_event","t_ms":112,"event":"content_block_delta","data":"{\"type\":\"content_block_delta\",\"delta\":{\"text\":\"Hi\"}}"}
{"exchange_id":"…","kind":"stream_event","t_ms":140,"event":"content_block_delta","data":"{\"type\":\"content_block_delta\",\"delta\":{\"text\":\" there.\"}}"}
{"exchange_id":"…","kind":"stream_event","t_ms":165,"event":"content_block_stop","data":"…"}
{"exchange_id":"…","kind":"stream_event","t_ms":190,"event":"message_stop","data":"…"}
{"exchange_id":"…","kind":"exchange","ts_start":"…","ts_end":"…","duration_ms":214,"upstream":"anthropic","client":{…},"request":{…},"response":{"status":200,"headers":{…},"body":null},"stream_event_count":6,"error":null}
```

The `request.headers["x-api-key"]` field is redacted as `REDACTED:<last4>` —
your secret never lands in the file.

## 4. Slice the recording with jq

Average request duration, by model:

```bash
jq -r 'select(.kind=="exchange") | [(.request.body | fromjson).model, .duration_ms] | @tsv' \
  < collectivus-data/proxy.jsonl \
| awk -F'\t' '{ count[$1]++; sum[$1]+=$2 }
              END { for (m in count) printf "%s\t%d calls\tavg %dms\n", m, count[m], sum[m]/count[m] }'
```

All assistant text deltas from the most recent exchange:

```bash
jq -r 'select(.kind=="stream_event" and .event=="content_block_delta") | (.data | fromjson).delta.text // empty' \
  < collectivus-data/proxy.jsonl
```

Replay one exchange (events plus its terminating row):

```bash
EXCHANGE_ID=$(jq -r 'select(.kind=="exchange") | .exchange_id' < collectivus-data/proxy.jsonl | tail -1)
jq -c "select(.exchange_id==\"$EXCHANGE_ID\")" < collectivus-data/proxy.jsonl
```

## 5. Shut down

`Ctrl+C` (SIGINT) on the collectivus process. Collectivus flushes and fsyncs
the JSONL file before exiting, so the last exchange row is durable.

## What's recorded vs redacted

- **Bodies are never auto-redacted.** Both the full request body and any
  non-streaming response body land verbatim. Streaming responses are decomposed
  into per-event rows — the response `body` is `null` and the data lives in
  `stream_event` rows instead.
- **Headers in `proxy.redact_headers`** (default: `authorization`, `x-api-key`,
  `anthropic-api-key`, `cookie`, `set-cookie`) are replaced with
  `REDACTED:<last 4 chars>` so operators can correlate keys without leaking
  them. Add to this list to redact more — you cannot shrink the default set.
- **Auth is pass-through.** Your `x-api-key` is forwarded to Anthropic
  verbatim; collectivus never holds a credential of its own.

## Combining with the OTLP collector

Collectivus's original OTLP receiver still works in the same process. Add an
`otel` block to the same config to record both LLM traffic and OpenTelemetry
signals from one binary:

```json
{
  "otel": { "listen": "0.0.0.0:4318" },
  "proxy": { "listen": "127.0.0.1:8787", "upstreams": { … } },
  "sink": { "type": "file", "dir": "./collectivus-data" }
}
```

The OTLP receiver writes to `<dir>/{traces,metrics,logs}/…` exactly as before;
the proxy writes to `<dir>/proxy.jsonl`.
