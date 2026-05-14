// ---------- Gascity source: configuration ----------

/**
 * One configured gascity supervisor. The daemon opens a lifecycle SSE per
 * city and a per-session frame SSE per active session.
 */
export interface GascityCityConfig {
  /** City name (matches the `{city}` path segment in the supervisor REST API). */
  name: string
  /** Base URL of the supervisor (e.g. `http://127.0.0.1:8372`). */
  api_url: string
  /**
   * Glob patterns matched against `session.template`. A session is captured
   * when ANY include pattern matches. Default `['**']` (capture all). The
   * patterns support `*` (any segment characters) and `**` (any sequence).
   */
  include_templates?: string[]
  /**
   * Glob patterns that suppress capture even when an include pattern matches.
   * Default `[]`. Same syntax as `include_templates`.
   */
  exclude_templates?: string[]
}

// ---------- Gascity source: SSE / frame plumbing ----------

/**
 * Per-session metadata stamped on each normalized row. Bead 1 carries this
 * through the dispatcher; beads 2/4 read it inside the normalizers.
 */
export interface SessionContext {
  /** Configured gascity name (e.g. `hyptown`). */
  city: string
  /** Provider-side session id (`hy-jw8sm`). */
  sessionId: string
  /** Session template path (e.g. `desktop/hypcity-overrides.refinery`). */
  template: string | undefined
  /** Optional rig the session belongs to. */
  rig: string | undefined
  /** Optional alias the session was started under. */
  alias: string | undefined
  /**
   * Timestamp of the first frame seen for this session (ISO 8601). Bead 3 owns
   * tracking — it's set once and reused across every subsequent row. Bead 2's
   * normalizer reads it as-is and falls back to `null` (the column is
   * nullable) when bead 3 hasn't populated it yet.
   */
  conversationStartedAt?: string | undefined
}

/**
 * Lifecycle event surfaced to a SupervisorSubscriber. The supervisor SSE
 * dispatches `session.created`, `session.woke`, `session.draining`,
 * `session.stopped`, and other `session.*` types — only the four listed are
 * actioned in bead 1; unknown types are logged at debug level and ignored.
 */
export interface LifecycleEvent {
  /** SSE `event:` field (e.g. `session.woke`). */
  type: string
  /** SSE `id:` field, if present. Used for `Last-Event-ID` resume. */
  id?: string
  /** Parsed `data:` payload. */
  payload: LifecyclePayload
}

export interface LifecyclePayload {
  /** Provider-side session id. */
  session_id?: string
  /** Session template path. */
  template?: string
  /** Optional rig label. */
  rig?: string
  /** Optional alias label. */
  alias?: string
  /** Anything else the supervisor included. */
  [k: string]: unknown
}

/**
 * Type a normalizer function takes when registered on the dispatcher. Each
 * invocation produces zero or more rows ready for the parquet writer (bead 3).
 * Returning an empty array is valid and signals "skip this frame" — used by
 * stubs and by lifecycle/heartbeat frames that don't translate to rows.
 */
export type NormalizerFn = (
  frame: unknown,
  ctx: SessionContext,
) => Array<import('./normalizers/types.d.ts').NormalizedRow>

/**
 * Persistent cursor state for a lifecycle stream — bead 1 only writes the
 * supervisor's last `id:`. The schema is intentionally flat / forward-
 * compatible so beads 3/5 can extend it without a migration.
 */
export interface LifecycleCursor {
  last_event_id?: string
}

/**
 * Persistent cursor state for a single session stream. Bead 1 records the
 * last frame uuid we successfully dispatched (so reconnect resumes after
 * it via the supervisor's `?after=<uuid>` param). Bead 3 will extend this
 * struct with flush counters and timestamps.
 */
export interface SessionCursor {
  last_uuid?: string
}
