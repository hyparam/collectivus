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
  /** Origin to forward matched requests to. */
  base_url: string
  /** Match rule for routing requests to this upstream. */
  match: UpstreamMatch
}

export interface ProxyConfig {
  /** host:port the proxy listens on. */
  listen: string
  /** Named upstream targets. */
  upstreams: { [name: string]: UpstreamConfig }
  /** Header names to redact in recorded traffic. */
  redact_headers?: string[]
}

export interface FileSinkConfig {
  /** Sink kind. Only 'file' is supported in v0. */
  type: 'file'
  /** Directory where recordings are written. */
  dir: string
}

export interface CollectivusConfig {
  /** OTLP receiver. Omit to disable. */
  otel?: OtelConfig
  /** Proxy listener. Omit to disable. */
  proxy?: ProxyConfig
  /** Sink for proxy recordings. Required when `proxy` is set. */
  sink?: FileSinkConfig
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

// ---------- CLI subcommand parse results / hooks ----------

export interface AttachParseResult {
  configPath?: string
  port?: number
  help: boolean
  error?: string
}

export interface DetachParseResult {
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
  detach: boolean
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
  settingsPath?: string
  attach?: (opts: AttachOptions) => Promise<AttachResult>
  loadConfig?: (path: string) => CollectivusConfig
}

export interface DetachHooks {
  stdout?: WriteStream
  stderr?: WriteStream
  settingsPath?: string
  detach?: (opts?: DetachOptions) => Promise<DetachResult>
}

export interface StatusHooks {
  stdout?: WriteStream
  stderr?: WriteStream
  plistPath?: string
  logDir?: string
  settingsPath?: string
  launchAgentStatus?: (opts: MacosStatusOptions) => Promise<{ loaded: boolean, pid?: number }>
  isLaunchAgentInstalled?: (opts: { label: string, plistDir?: string }) => Promise<boolean>
  isAttached?: (opts?: IsAttachedOptions) => Promise<boolean>
  readInstalledPlist?: (plistPath: string) => InstalledPlistFields | undefined
  /** Override for raw read of settings.json (returns undefined on ENOENT). */
  readSettingsRaw?: (p: string) => Promise<string | undefined>
}

export interface InitHooks {
  stdout?: WriteStream
  stderr?: WriteStream
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
  /** Override `process.argv[1]`. Used to detect npx-resolved binaries. */
  binPath?: string
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
  loadConfig?: (path: string) => CollectivusConfig
}

export interface UninstallHooks {
  stdout?: WriteStream
  stderr?: WriteStream
  /** Forwarded to uninstallDaemon (`~/Library/LaunchAgents` override). */
  plistDir?: string
  /** Override for `~/.claude/settings.json`. */
  settingsPath?: string
  isTTY?: boolean
  prompt?: (question: string) => Promise<string>
  uninstallLaunchAgent?: (opts: DaemonUninstallOptions) => Promise<void>
  detach?: (opts?: DetachOptions) => Promise<DetachResult>
  isAttached?: (opts?: IsAttachedOptions) => Promise<boolean>
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
