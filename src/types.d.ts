export interface DataReader {
  view: DataView
  offset: number
}

// ---------- SSE ----------

export interface SseEvent {
  /** Event type (defaults to 'message' when no `event:` field is present). */
  event: string
  /** Event data; multiple `data:` lines are joined with `\n`. */
  data: string
}

// ---------- Recorder / proxy exchange ----------

export interface ClientInfo {
  /** Client remote address as observed by the proxy. */
  ip: string | undefined
  /** Client User-Agent header value. */
  user_agent: string | undefined
}

export interface ExchangeRequest {
  /** HTTP method (e.g. 'POST'). */
  method: string | undefined
  /** Path + query as received. */
  path: string | undefined
  /** Headers post-redaction. */
  headers: Record<string, string | string[] | undefined>
  /** Request body as received (utf-8). Empty string for requests with no body. */
  body: string
}

export interface ExchangeResponse {
  /** HTTP status from upstream. */
  status: number | undefined
  /** Response headers post-redaction. */
  headers: Record<string, string | string[] | undefined>
  /** Response body for non-streaming responses; `undefined` for SSE (events recorded separately). */
  body: string | undefined
}

// ---------- File sink ----------

export interface Sink {
  /** Append a row to the sink. */
  writeRow(obj: unknown): Promise<void>
  /** Flush, fsync, and release resources. */
  close(): Promise<void>
}

// ---------- Proxy ----------

export interface CompiledUpstream {
  /** Upstream key from config. */
  name: string
  /** Parsed base URL. */
  baseUrl: URL
  /** Path prefix used for routing. */
  prefix: string
}

// ---------- Config ----------

export interface OtelConfig {
  /** host:port for the OTLP receiver (e.g. '0.0.0.0:4318'). */
  listen: string
}

export interface UpstreamMatch {
  /** Request path prefix that selects this upstream. */
  path_prefix: string
}

export interface UpstreamConfig {
  /** Identifier used in logs and recorded exchange rows. Unique within the proxy. */
  name: string
  /** Origin to forward matched requests to. */
  base_url: string
  /** Match rule for routing requests to this upstream. */
  match: UpstreamMatch
}

export interface ProxyConfig {
  /** host:port the proxy listens on. */
  listen: string
  /** Upstream targets in declaration order; first matching prefix wins. */
  upstreams: UpstreamConfig[]
  /** Header names to redact in recorded traffic. */
  redact_headers?: string[]
}

export interface FileSinkConfig {
  /** Sink kind. Only 'file' is supported in v0. */
  type: 'file'
  /** Directory where recordings are written. */
  dir: string
}

export type UploadSignal = 'logs' | 'traces' | 'metrics'

export interface UploadConfig {
  /** Destination bucket. Required. */
  bucket: string
  /** Object-key prefix. Default 'collectivus'. */
  prefix?: string
  /** Region for the destination bucket. Default ''. */
  region?: string
  /** Daily fire time as HH:MM (24-hour, local). Default '00:10'. */
  time?: string
  /** Subset of signals to upload. Default ['logs', 'traces', 'metrics']. */
  signals?: UploadSignal[]
  /** Days of past data to backfill on startup. Default 30. */
  catchupDays?: number
  /** Override base URL for S3-compatible servers (MinIO, etc.). */
  endpoint?: string
}

/**
 * Operating mode for this collectivus instance. `standalone` (default when
 * `role` is absent) preserves single-binary behavior. `server` and `gateway`
 * activate the central-server / local-gateway split introduced by Epic A.
 */
export type CollectivusRole = 'server' | 'gateway' | 'standalone'

export interface IdentityIssuerConfig {
  /** HMAC secret used to sign control-plane JWTs. Must be ≥32 chars. */
  secret: string
  /** TTL applied to issued gateway JWTs. */
  jwt_ttl_seconds?: number
  /** TTL applied to operator-provisioned bootstrap tokens. */
  bootstrap_ttl_seconds?: number
  /**
   * Filesystem path to the bootstrap-token store. Required when the server
   * should accept `POST /v1/identity/bootstrap` — when omitted, the bootstrap
   * endpoint returns 503 (refresh and ordinary auth still work).
   */
  bootstrap_store_path?: string
}

/** Standard claims this server emits and accepts on control-plane JWTs. */
export interface JwtClaims {
  /** Subject — the gateway identity this token represents. */
  sub: string
  /** Issued-at, seconds since the unix epoch. */
  iat: number
  /** Expiration, seconds since the unix epoch. */
  exp: number
}

/** Result of `verifyJwt`. */
export type JwtVerifyResult =
  | { valid: true, claims: JwtClaims }
  | { valid: false, error: 'malformed' | 'bad_signature' | 'expired' | 'iat_in_future' }

/** A persisted bootstrap-token record. The plaintext token is never stored. */
export interface BootstrapRecord {
  /** sha256 hex of the plaintext bootstrap token. */
  tokenHash: string
  /** Gateway identity this token will mint a JWT for. */
  gatewayId: string
  /** Expiration, seconds since the unix epoch. */
  expiresAt: number
  /** Whether the token has already been redeemed. */
  used: boolean
}

/** Result of `issueFromBootstrap`. */
export type IssueFromBootstrapResult =
  | { ok: true, jwt: string, expiresAt: number, gatewayId: string }
  | { ok: false, reason: 'unknown_token' | 'already_used' | 'expired' }

/**
 * Gateway-side persisted identity. Written by `IdentityClient` after a
 * successful `bootstrap` or `refresh`, read on subsequent gateway start so
 * the JWT survives process restarts.
 */
export interface PersistedIdentity {
  /** The control-plane JWT this gateway uses for every authenticated call. */
  jwt: string
  /** Expiration of `jwt`, seconds since the unix epoch. */
  expires_at: number
  /** Gateway identity claim (`sub`) recovered from the JWT at issue time. */
  gateway_id: string
}

export interface ServerConfig {
  /** host:port for the control-plane HTTP listener (separate from OTLP/proxy). */
  control_plane_listen: string
  /** JWT issuer settings for the control-plane. */
  identity_issuer: IdentityIssuerConfig
  /**
   * Filesystem root for server-side state (per-gateway config registry,
   * future log-ingest spool, etc). Defaults to `~/.hyp/collectivus/server-data`
   * when omitted.
   */
  data_dir?: string
  /**
   * Filesystem root where the ingest endpoint persists shipped rows. Files
   * live at `<sink_dir>/<gateway_id>/<signal>/<YYYY-MM-DD>.jsonl`. Distinct
   * from server `data_dir` (which holds configs / bootstrap tokens). Default:
   * `~/.hyp/collectivus/server-data/ingested`.
   */
  sink_dir?: string
  /** Backpressure / disk I/O throttle settings for the ingest endpoint. */
  ingest?: IngestThrottleConfig
}

/**
 * Server-side ingest throttle settings. All fields are optional and fall back
 * to defaults that match the spec in epic C.2: 50000 pending rows, 80%
 * high-water mark, 5s `Retry-After`, no disk-rate ceiling.
 */
export interface IngestThrottleConfig {
  /**
   * Maximum rows queued for fsync before the endpoint starts emitting
   * backpressure. A request that arrives while the queue is at or past this
   * value is rejected with 503. Default 50000.
   */
  max_pending_rows?: number
  /**
   * Percentage of `max_pending_rows` at which the endpoint starts emitting
   * 429 with `Retry-After`. Must be 1..100. Default 80.
   */
  high_water_pct?: number
  /**
   * Value emitted in the `Retry-After` response header when backpressure
   * triggers. Must be a positive integer (whole seconds). Default 5.
   */
  retry_after_seconds?: number
  /**
   * Per-process disk-write ceiling, in bytes per second. Implemented as a
   * 1-second token bucket: bursts up to `max_bytes_per_second` are allowed,
   * sustained throughput is capped at the same value. Omit (the default) to
   * disable disk-rate throttling entirely.
   */
  max_bytes_per_second?: number
}

/** A per-gateway config entry held by the server-side registry. */
export interface ConfigRegistryEntry {
  /** The gateway-shaped CollectivusConfig persisted for this gateway. */
  config: CollectivusConfig
  /** SHA-256 hex of the canonical JSON serialization of `config`. */
  etag: string
}

/** Signal kinds accepted on `POST /v1/ingest/:signal`. */
export type IngestSignal = 'logs' | 'traces' | 'metrics' | 'proxy'

/** Response body shape for the ingest endpoint. */
export interface IngestResponse {
  /** Number of rows successfully persisted. */
  accepted: number
  /**
   * 1-indexed line number where parsing failed. Present only on the partial-
   * success / malformed-batch path (HTTP 400).
   */
  rejected_at_line?: number
  /** Human-readable reason for the rejection. Present only on HTTP 400. */
  error?: string
}

/**
 * Subset of `IdentityClient` that `ShippingSink` actually needs. Declared
 * structurally so tests can supply a small fake without re-implementing the
 * full identity lifecycle, mirroring the `IdentitySource` pattern used by
 * `ConfigClient`.
 */
export interface ShippingSinkIdentitySource {
  /** Resolve to the current bearer JWT, refreshing in-place if near expiry. */
  getCurrentJwt(): Promise<string>
  /** Force a refresh against the central server. */
  refresh(): Promise<void>
}

/** Per-signal flush thresholds for `ShippingSink`. */
export interface ShippingSinkBatchOptions {
  /** Maximum rows per batch before a flush. Default 1000. */
  maxRows?: number
  /** Maximum bytes per batch (NDJSON, including newlines) before a flush. Default 1048576 (1 MB). */
  maxBytes?: number
  /** Maximum seconds the oldest row may sit in a batch before a flush. Default 5. */
  maxSeconds?: number
}

/** Construction options for `ShippingSink`. */
export interface ShippingSinkOptions {
  /** Base URL of the central control-plane server (same as `central_server.url`). */
  centralUrl: string
  /** Identity source providing JWTs and refresh — typically the gateway's `IdentityClient`. */
  identityClient: ShippingSinkIdentitySource
  /**
   * Signal label embedded in the ingest URL (`/v1/ingest/<signal>`). Default
   * `proxy`, matching the only existing `Sink` consumer (the recorder). Future
   * multi-signal variants will override per-instance or route per-row.
   */
  signal?: IngestSignal
  /** Batching thresholds. Defaults match the bead spec (1000 / 1 MB / 5 s). */
  batch?: ShippingSinkBatchOptions
}

export interface CentralServerIdentityConfig {
  /** Operator-provisioned bootstrap token, exchanged on first start. */
  bootstrap_token?: string
  /** Filesystem path where the long-lived JWT is persisted. */
  persisted_path?: string
}

export interface CentralServerConfig {
  /** Base URL of the central control-plane server. */
  url: string
  /** Identity material used by the gateway to authenticate. */
  identity: CentralServerIdentityConfig
  /**
   * Background config-pull interval in seconds. Default 30. Validator
   * constrains to [5, 3600]: the floor is the minimum useful resolution for
   * "hot reload" semantics; the ceiling keeps a misconfigured gateway from
   * drifting hours behind a config change.
   */
  poll_interval_seconds?: number
}

/**
 * Emitted by `ConfigClient` whenever a `GET /v1/config` returns 200 with a
 * config that passes gateway-side validation. B.4's hot-reload code subscribes
 * to this and diffs `newConfig` against the running config.
 */
export interface ConfigChangedEvent {
  /** The newly fetched config — already validated. */
  newConfig: CollectivusConfig
  /** SHA-256 hex of the canonical JSON serialization of `newConfig`. */
  etag: string
  /** ISO-8601 timestamp of the moment the gateway accepted the config. */
  fetchedAt: string
}

export interface CollectivusConfig {
  /** Schema version. Always 1 in this binary. */
  version: 1
  /** Operating mode. Defaults to `standalone` when omitted. */
  role?: CollectivusRole
  /** OTLP receiver. Omit to disable. */
  otel?: OtelConfig
  /** Proxy listener. Omit to disable. */
  proxy?: ProxyConfig
  /** Sink for proxy recordings. Required when `otel` or `proxy` is set. */
  sink?: FileSinkConfig
  /** Reserved upload section. Schema-validated only; uploader wires up later. */
  upload?: UploadConfig
  /** Server-mode (control-plane) settings. Required iff `role === 'server'`. */
  server?: ServerConfig
  /** Gateway-mode central-server settings. Required iff `role === 'gateway'`. */
  central_server?: CentralServerConfig
}

// ---------- Collector / OTLP normalization ----------

export type NormalizedLogRow = Record<string, unknown> & {
  serviceName: string
  timestamp?: string
  observedTimestamp?: string
  severityNumber?: number
  severityText?: string
  body: unknown
  traceId?: string
  spanId?: string
  flags?: number
  droppedAttributesCount?: number
  resource: Record<string, unknown>
  scope: {
    name?: string
    version?: string
    attributes: Record<string, unknown>
  }
  attributes: Record<string, unknown>
}

export type NormalizedServiceRow = Record<string, unknown> & { serviceName: string }

export interface MetricRowBase {
  serviceName: string
  metricName?: string
  description?: string
  unit?: string
  resource: Record<string, unknown>
  scope: {
    name?: string
    version?: string
    attributes: Record<string, unknown>
  }
  metadata: Record<string, unknown>
}

// ---------- CLI top-level ----------

export interface HelpResult {
  mode: 'help'
}

export interface ExportParseResult {
  help: boolean
  error?: string
  configPath?: string
  outDir?: string
  date?: string
  service?: string
  signal?: 'logs' | 'traces' | 'metrics'
}

export interface ExportHooks {
  stdout?: { write(chunk: string): unknown }
  stderr?: { write(chunk: string): unknown }
  loadConfig?: (pathOrUrl: string) => CollectivusConfig | Promise<CollectivusConfig>
}

export interface VersionResult {
  mode: 'version'
}

export interface ErrorResult {
  mode: 'error'
  message: string
  exitCode: number
}

export interface ConfigResult {
  mode: 'config'
  configPath: string
  printConfig: boolean
  strict: boolean
}

export type ParseResult = HelpResult | VersionResult | ErrorResult | ConfigResult

export interface StartedListener {
  description: string
  stop(): Promise<void>
}

export type ListenerFactory = () => Promise<StartedListener>

// ---------- Claude Code settings ----------

export interface CollectivusMarker {
  attached_at?: string
  version?: string
  port?: number
}

export interface AttachOptions {
  /** TCP port (1..65535) the local proxy listens on. */
  port: number
  /** Non-empty version string recorded in the marker. */
  version: string
  /** Override the settings.json path (default: `~/.claude/settings.json`). */
  settingsPath?: string
}

export interface AttachResult {
  /** Always true; attach always (re)writes the marker. */
  changed: true
  /** Previous value of `env.ANTHROPIC_BASE_URL`, if any. */
  prevValue?: string
}

export interface DetachOptions {
  /** Override the settings.json path (default: `~/.claude/settings.json`). */
  settingsPath?: string
}

export interface DetachResult {
  /** True if the file was modified, false when no marker was present. */
  changed: boolean
  /** The `ANTHROPIC_BASE_URL` value that was removed when it matched the marker port. */
  removed?: string
  /** Set when `ANTHROPIC_BASE_URL` was overridden externally and was left in place. */
  warning?: string
}

export interface IsAttachedOptions {
  /** Override the settings.json path (default: `~/.claude/settings.json`). */
  settingsPath?: string
}

export interface ReadSettingsResult {
  /** Parsed object (mutable). */
  value: Record<string, unknown>
  /** Whether the file was on disk. */
  existed: boolean
  /** mtime captured at read time (undefined when the file did not exist). */
  mtimeMs: number | undefined
}

// ---------- Codex settings ----------

export interface CodexAttachOptions {
  /** TCP port (1..65535) the local proxy listens on. */
  port: number
  /** Non-empty version string recorded in managed comments. */
  version: string
  /** Override the config.toml path (default: `~/.codex/config.toml`). */
  configPath?: string
}

export interface CodexAttachResult {
  /** Always true; attach always (re)writes the managed config. */
  changed: true
  /** Previous root `model_provider`, if one existed before collectivus attached. */
  prevValue?: string
}

export interface CodexDetachOptions {
  /** Override the config.toml path (default: `~/.codex/config.toml`). */
  configPath?: string
}

export interface CodexDetachResult {
  /** True if the file was modified, false when no managed block was present. */
  changed: boolean
  /** The managed provider base_url that was removed. */
  removed?: string
  /** Previous root `model_provider` restored from the managed marker, if any. */
  restoredValue?: string
  /** Set when a user-edited root model_provider was left in place. */
  warning?: string
}

export interface CodexIsAttachedOptions {
  /** Override the config.toml path (default: `~/.codex/config.toml`). */
  configPath?: string
}

// ---------- CLI subcommand parse results / hooks ----------

export interface AttachParseResult {
  configPath?: string
  port?: number
  client?: 'claude' | 'codex' | 'all'
  help: boolean
  error?: string
}

export interface DetachParseResult {
  client: 'claude' | 'codex' | 'all'
  help: boolean
  error?: string
}

export interface StatusParseResult {
  help: boolean
  error?: string
}

export interface InstallParseResult {
  configPath?: string
  yes: boolean
  no: boolean
  help: boolean
  error?: string
}

export interface UninstallParseResult {
  help: boolean
  error?: string
}

export interface WriteStream {
  write(s: string): void
}

export interface AttachHooks {
  stdout?: WriteStream
  stderr?: WriteStream
  version?: string
  /** Override for `~/.claude/settings.json`. */
  settingsPath?: string
  /** Override for `~/.codex/config.toml`. */
  codexConfigPath?: string
  /** Back-compat alias for attachClaude. */
  attach?: (opts: AttachOptions) => Promise<AttachResult>
  attachClaude?: (opts: AttachOptions) => Promise<AttachResult>
  attachCodex?: (opts: CodexAttachOptions) => Promise<CodexAttachResult>
  loadConfig?: (pathOrUrl: string) => CollectivusConfig | Promise<CollectivusConfig>
}

export interface DetachHooks {
  stdout?: WriteStream
  stderr?: WriteStream
  /** Override for `~/.claude/settings.json`. */
  settingsPath?: string
  /** Override for `~/.codex/config.toml`. */
  codexConfigPath?: string
  /** Back-compat alias for detachClaude. */
  detach?: (opts?: DetachOptions) => Promise<DetachResult>
  detachClaude?: (opts?: DetachOptions) => Promise<DetachResult>
  detachCodex?: (opts?: CodexDetachOptions) => Promise<CodexDetachResult>
}

export interface StatusHooks {
  stdout?: WriteStream
  stderr?: WriteStream
  plistPath?: string
  logDir?: string
  settingsPath?: string
  /** Default config path used when the LaunchAgent plist doesn't supply one. */
  configPath?: string
  launchAgentStatus?: (opts: MacosStatusOptions) => Promise<{ loaded: boolean, pid?: number }>
  isLaunchAgentInstalled?: (opts: { label: string, plistDir?: string }) => Promise<boolean>
  isAttached?: (opts?: IsAttachedOptions) => Promise<boolean>
  readInstalledPlist?: (plistPath: string) => InstalledPlistFields | undefined
  /** Override for raw read of settings.json (returns undefined on ENOENT). */
  readSettingsRaw?: (p: string) => Promise<string | undefined>
  /** Load and validate a config; throws on parse/validation errors. */
  loadConfig?: (pathOrUrl: string) => CollectivusConfig | Promise<CollectivusConfig>
  /** Stat a file; resolve to undefined when missing. */
  statFile?: (p: string) => Promise<{ size: number, mtimeMs: number } | undefined>
  /** Count `*.jsonl` files under `dir` (recursive). Undefined when dir is missing. */
  countSinkFiles?: (dir: string) => Promise<number | undefined>
}

export interface InitHooks {
  stdout?: WriteStream
  stderr?: WriteStream
  /** Override for `process.argv[1]` in tests. Drives npx-detection. */
  binPath?: string
  /** Override the readline prompt. */
  prompt?: (question: string) => Promise<string>
  /** Override file write. */
  writeFile?: (path: string, contents: string) => void
  /** Override the read used to detect an existing config at the default path. */
  readConfig?: (path: string) => CollectivusConfig | undefined
  /** Override `collectivus install` chain entry. */
  runInstall?: (args: string[]) => Promise<number>
  /** Override `process.platform`. */
  platform?: NodeJS.Platform
  /** Override `process.cwd()`. */
  cwd?: string
  /** Override the default `~/.hyp/collectivus.json` save path. */
  defaultConfigPath?: string
  /** Override the default `~/.hyp/collectivus` sink directory. */
  defaultSinkDir?: string
}

export interface InstallHooks {
  stdout?: WriteStream
  stderr?: WriteStream
  /** Override for `process.argv[1]` in tests. */
  binPath?: string
  /** Override for the version recorded in the marker. */
  version?: string
  /** Override for `~/.hyp/collectivus`. */
  logDir?: string
  /** Forwarded to installDaemon (`~/Library/LaunchAgents` override). */
  plistDir?: string
  /** Override for `~/.claude/settings.json`. */
  settingsPath?: string
  /** Force the TTY decision in tests. */
  isTTY?: boolean
  /** Override the readline prompt. */
  prompt?: (question: string) => Promise<string>
  installLaunchAgent?: (opts: DaemonInstallOptions) => Promise<void>
  attach?: (opts: AttachOptions) => Promise<AttachResult>
  loadConfig?: (pathOrUrl: string) => CollectivusConfig | Promise<CollectivusConfig>
}

export interface UninstallHooks {
  stdout?: WriteStream
  stderr?: WriteStream
  /** Forwarded to uninstallDaemon (`~/Library/LaunchAgents` override). */
  plistDir?: string
  /** Override for `~/.claude/settings.json`. */
  settingsPath?: string
  /** Override for `~/.codex/config.toml`. */
  codexConfigPath?: string
  uninstallLaunchAgent?: (opts: DaemonUninstallOptions) => Promise<void>
  /** Back-compat alias for detachClaude. */
  detach?: (opts?: DetachOptions) => Promise<DetachResult>
  detachClaude?: (opts?: DetachOptions) => Promise<DetachResult>
  detachCodex?: (opts?: CodexDetachOptions) => Promise<CodexDetachResult>
  /** Back-compat alias for isClaudeAttached. */
  isAttached?: (opts?: IsAttachedOptions) => Promise<boolean>
  isClaudeAttached?: (opts?: IsAttachedOptions) => Promise<boolean>
  isCodexAttached?: (opts?: CodexIsAttachedOptions) => Promise<boolean>
}

export interface InstalledPlistFields {
  /** Path passed via `--config` in ProgramArguments. */
  configPath?: string
  /** Value of `StandardOutPath`. */
  stdoutPath?: string
  /** Value of `StandardErrorPath`. */
  stderrPath?: string
}

// ---------- Daemon: macOS LaunchAgent ----------

export interface LaunchctlResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface LaunchctlAdapter {
  load(plistPath: string): Promise<LaunchctlResult>
  unload(plistPath: string): Promise<LaunchctlResult>
  list(label: string): Promise<LaunchctlResult>
}

export interface BuildPlistOptions {
  label: string
  nodePath: string
  binPath: string
  configPath: string
  logDir: string
  env?: Record<string, string>
  keepAlive?: boolean
  runAtLoad?: boolean
}

export interface MacosInstallOptions {
  binPath: string
  configPath: string
  label: string
  logDir: string
  nodePath?: string
  env?: Record<string, string>
  keepAlive?: boolean
  runAtLoad?: boolean
  /** Override directory for the plist file. Defaults to ~/Library/LaunchAgents. */
  plistDir?: string
  launchctl?: LaunchctlAdapter
}

export interface MacosUninstallOptions {
  label: string
  plistDir?: string
  launchctl?: LaunchctlAdapter
}

export interface MacosStatusOptions {
  label: string
  /** Unused; accepted for API symmetry. */
  plistDir?: string
  launchctl?: LaunchctlAdapter
}

// ---------- Daemon: Linux systemd ----------

export interface SystemctlResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface SystemctlAdapter {
  daemonReload(): Promise<SystemctlResult>
  enable(unit: string): Promise<SystemctlResult>
  disable(unit: string): Promise<SystemctlResult>
  restart(unit: string): Promise<SystemctlResult>
  stop(unit: string): Promise<SystemctlResult>
  show(unit: string): Promise<SystemctlResult>
}

export interface BuildUnitOptions {
  description: string
  nodePath: string
  binPath: string
  configPath: string
  logDir: string
  env?: Record<string, string>
  restart?: boolean
}

export interface LinuxInstallOptions {
  label: string
  binPath: string
  configPath: string
  logDir: string
  description?: string
  nodePath?: string
  env?: Record<string, string>
  restart?: boolean
  /** Override directory for the unit file. Defaults to ~/.config/systemd/user. */
  unitDir?: string
  systemctl?: SystemctlAdapter
}

export interface LinuxUninstallOptions {
  label: string
  unitDir?: string
  systemctl?: SystemctlAdapter
}

export interface LinuxStatusOptions {
  label: string
  unitDir?: string
  systemctl?: SystemctlAdapter
}

// ---------- Daemon: cross-platform ----------

export type DaemonInstallOptions = MacosInstallOptions & LinuxInstallOptions
export type DaemonUninstallOptions = MacosUninstallOptions & LinuxUninstallOptions

// ---------- Upload scheduler ----------

export interface TickResult {
  /** Schedule a fast retry instead of waiting until the next daily fire. */
  retry?: boolean
}

export interface SchedulerDeps {
  /** For tests. */
  now?: () => Date
  setTimeoutFn?: (handler: () => void, ms: number) => NodeJS.Timeout | number
  clearTimeoutFn?: (handle: NodeJS.Timeout | number) => void
}
