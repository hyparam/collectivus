# Company-wide MDM Deployment Notes

These notes summarize what it would take to deploy Collectivus company-wide
through MDM, updated for the fact that Hyperparam Desktop is already a signed
macOS app and already ships Collectivus as an app resource.

## Summary

The preferred deployment path is to use Hyperparam Desktop as the managed
carrier for Collectivus instead of deploying a standalone Node CLI package.
That gives IT one signed/notarized application artifact to deploy and avoids a
separate Node install, global `npm install -g`, or endpoint self-update flow.

The core rollout should be:

1. Ship Hyperparam Desktop as a signed/notarized macOS installer package.
2. Bundle the current Collectivus version inside the app.
3. Start Collectivus with `ELECTRON_RUN_AS_NODE=1` through the signed Electron
   executable.
4. Feed it a centrally managed `--config https://.../collectivus.json` URL.
5. Use launchd plus MDM-managed background-item approval to keep it running.
6. Keep updates controlled by Hyperparam Desktop releases distributed by MDM.

## Current State

### Collectivus repo

Collectivus is currently a pure Node CLI and daemon project.

- Package name/version: `collectivus@1.3.0`
- Primary CLI: `bin/cli.js`
- Current daemon install path: per-user macOS LaunchAgent
- Current default config/log paths: `~/.hyp/collectivus.json` and
  `~/.hyp/collectivus/`
- Current install command assumes a stable globally installed npm binary:
  `npm install -g collectivus`

Relevant files:

- `package.json`
- `bin/cli.js`
- `src/cli.js`
- `src/cli/install.js`
- `src/daemon/macos.js`
- `src/update.js`
- `src/claude-code/settings.js`
- `src/codex/settings.js`

The standalone CLI path can work for developers, but it is not ideal for MDM:

- It relies on global npm for the managed binary path.
- The daemon install writes into the current user's home directory.
- It edits the current user's Claude/Codex settings.
- It has npm registry update checks and a supervised self-update path.
- A separate pkg would need its own signing/notarization/update story.

### Hyperparam Desktop repo

Hyperparam Desktop lives in `../electron` and is already set up as a signed
Electron app.

Current package metadata:

- App package: `hyperparam-desktop@0.9.8`
- App ID: `app.hyperparam.desktop`
- Builder: `electron-builder`
- Current mac targets: arm64 `dmg` and `zip`
- Current bundled Collectivus dependency: `collectivus@1.0.0`

Relevant files:

- `../electron/package.json`
- `../electron/electron-builder.yml`
- `../electron/src/telemetry-service.js`
- `../electron/src/telemetry-config.js`
- `../electron/src/main.js`

`electron-builder.yml` already ships Collectivus as `extraResources`:

```yaml
extraResources:
  - from: node_modules/collectivus
    to: collectivus
```

The Desktop service resolver expects packaged builds to find the CLI at:

```text
<app>/Contents/Resources/collectivus/bin/cli.js
```

and launch it via:

```text
ELECTRON_RUN_AS_NODE=1 <Hyperparam executable> <collectivus cli>
```

That is the right foundation for MDM.

## Recommended Architecture

Use Hyperparam Desktop as the signed carrier app:

```text
/Applications/Hyperparam Desktop.app/
  Contents/MacOS/Hyperparam Desktop
  Contents/Resources/collectivus/bin/cli.js
  Contents/Resources/collectivus/src/...
```

Launch Collectivus through the signed app executable:

```text
ELECTRON_RUN_AS_NODE=1 \
  /Applications/Hyperparam Desktop.app/Contents/MacOS/Hyperparam Desktop \
  /Applications/Hyperparam Desktop.app/Contents/Resources/collectivus/bin/cli.js \
  --config https://collectivus.example.com/client.json
```

This has several advantages:

- No endpoint Node install.
- No global npm path dependency.
- No separate Collectivus code-signing surface.
- App updates can update Collectivus.
- MDM only needs to deploy and update Hyperparam Desktop.

## MDM Installer Shape

For company-wide rollout, add a macOS `pkg` target or a wrapper pkg around the
current app artifact.

Target state:

- Install app to `/Applications/Hyperparam Desktop.app`.
- Include the bundled Collectivus resource.
- Install or configure launchd artifacts.
- Optionally install a managed preferences/profile payload.
- Sign with Developer ID Application where applicable.
- Sign the installer with Developer ID Installer.
- Notarize and staple the final distribution artifact.

The current Desktop build emits `dmg` and `zip` for macOS. Some MDM systems can
deploy DMGs, but a signed/notarized pkg is the most predictable format across
Jamf, Intune, Kandji, and similar tools.

## launchd Model

There are two viable launchd models.

### Option A: Per-user LaunchAgent

Install a LaunchAgent for each user, either by:

- Writing `/Library/LaunchAgents/app.hyperparam.collectivus.plist`, or
- Running a user-context bootstrap script at login.

Pros:

- Fits local proxy usage on `127.0.0.1`.
- Runs in the user's context, which matches Claude/Codex config files.
- Avoids a root process recording user traffic.

Cons:

- Needs a login-time install/bootstrap path for every user.
- User-level launchd state can drift when the app moves or updates.
- MDM needs a Managed Login Items/background-items profile to avoid user prompts.

### Option B: System LaunchDaemon

Install one root-owned daemon under `/Library/LaunchDaemons`.

Pros:

- One service per Mac.
- Easier for MDM to install and supervise.
- Can start before user login.

Cons:

- Does not naturally map to per-user Claude/Codex settings.
- If binding a local proxy, all users share the same process and port.
- File ownership and per-user attribution need more work.
- Security review is stricter because a root process records LLM traffic.

Recommendation: use a per-user LaunchAgent unless the product requirement is
centralized machine-level capture.

## Config URL Support

The planned `--config URL` support is important for MDM.

With it, the MDM artifact can be stable while configuration stays centrally
managed:

```text
--config https://collectivus.example.com/client.json
```

Recommended URL-config behavior:

- Support HTTPS by default; avoid plain HTTP except explicit development mode.
- Timeout quickly and log useful errors.
- Validate the downloaded JSON with the same schema as local configs.
- Cache the last known good config locally so endpoints can start offline.
- Surface config version, ETag, or content hash in logs/status.
- Do not store provider credentials in the config.
- Consider optional config signature verification for high-trust deployments.

## Desktop Integration Gaps

Before MDM rollout, fix these gaps in `../electron`.

### Update Collectivus dependency

Desktop currently depends on `collectivus@1.0.0`, while the Collectivus repo is
at `1.3.0`.

`collectivus@1.0.0` appears to support only the older OTLP collector CLI with
`--port` and `--output`, not the current config-driven proxy/uploader daemon.

Action:

- Bump Desktop to the current Collectivus dependency.
- Verify the packaged app includes the expected `bin/cli.js` and `src/**`.
- Keep the dependency pinned to an exact release.

### Fix current telemetry service arguments

`../electron/src/telemetry-service.js` currently writes these environment
variables into the LaunchAgent:

```text
COLLECTIVUS_PORT
COLLECTIVUS_OUTPUT_DIR
```

but the bundled `collectivus@1.0.0` CLI parses only:

```text
--port
--output
```

So the current plist likely does not honor `outputDir` as intended. Moving to
the new config CLI should replace this with `--config <url-or-file>`.

### Add managed mode

Desktop currently installs telemetry from the app menu as a user action.
MDM needs a noninteractive mode.

Possible approaches:

- Add a small CLI mode to Hyperparam Desktop, such as
  `--install-collectivus-service --config-url <url>`.
- Add a postinstall script in the pkg that writes the LaunchAgent plist.
- Add a login helper that reconciles the LaunchAgent whenever the user logs in.

The existing `reconcile()` behavior in `telemetry-service.js` is useful because
it rewrites the plist when the app path or config changes.

### Add pkg build target

Add a macOS pkg target to `electron-builder.yml` or wrap the app with a pkg
builder.

Current mac target:

```yaml
mac:
  target:
    - target: dmg
    - target: zip
```

Needed for MDM:

```yaml
mac:
  target:
    - target: pkg
    - target: dmg
    - target: zip
```

Exact configuration depends on the chosen MDM and signing setup.

### Support Intel Macs if needed

Current mac artifacts appear arm64-only. Company-wide deployment may need:

- universal mac build, or
- separate arm64/x64 assignments in MDM.

## Collectivus Gaps For Managed Deployment

These improvements belong in the Collectivus repo.

### Disable unmanaged self-update

Managed installs should not self-update with npm.

Current code checks the npm registry and has a supervised self-update path.
Add a supported switch such as:

```text
COLLECTIVUS_DISABLE_UPDATE_CHECK=1
```

or config:

```json
{
  "managed": {
    "updates": false
  }
}
```

For MDM, updates should happen only when Hyperparam Desktop is updated.

### Improve status for Desktop-managed runs

`collectivus status` currently knows about the standalone Collectivus
LaunchAgent label. Desktop uses:

```text
app.hyperparam.collectivus
```

Consider status support for:

- custom launchd label,
- custom plist path,
- config URL,
- last downloaded config hash,
- Desktop-managed install marker.

### Add attribution fields

Company-wide capture needs attribution beyond `client.ip`.

Useful fields:

- hostname,
- macOS user,
- app bundle/version,
- Collectivus version,
- device serial or MDM device ID if policy allows,
- org/team/department from config.

Avoid collecting identifiers by default without policy review.

### Review local storage and upload

Decide whether endpoints store recordings locally, upload them, or both.

If upload is used:

- Prefer short-lived credentials or identity federation.
- Do not bake long-lived AWS keys into plists or configs.
- Ensure upload failures do not lose local source JSONL.
- Define retention and disk-usage limits.

## Claude/Codex Configuration

Company-wide deployment also needs a way to route user tools through the local
or central proxy.

Current standalone Collectivus can edit:

- `~/.claude/settings.json`
- `~/.codex/config.toml`

For MDM, this should be coordinated with the Desktop per-user launch flow.

Options:

1. Configure users at login by running a helper in user context.
2. Use MDM custom settings where the target app supports managed preferences.
3. Provide an opt-in menu action in Desktop for developers.
4. For central proxy mode, configure clients to point directly at the central
   HTTPS endpoint instead of `127.0.0.1`.

Local proxy mode is usually better for endpoint observability:

```text
ANTHROPIC_BASE_URL=http://127.0.0.1:8787
```

Codex needs a provider entry pointing at:

```text
http://127.0.0.1:8787/v1
```

## Security And Privacy Decisions

These need product/legal/security signoff before rollout.

Collectivus redacts headers, but request/response bodies are intentionally
recorded. That means prompts, completions, code snippets, credentials pasted
into prompts, customer data, and other sensitive content may be captured.

Decisions to make:

- Is full prompt and response capture allowed company-wide?
- Are there opt-out groups or sensitive teams?
- Is endpoint-local storage allowed?
- What is the default retention period?
- Who can access captured data?
- Is upload encrypted with company-managed keys?
- Are users notified?
- How are incidents and deletion requests handled?

Potential controls:

- Additional body redaction hooks.
- Max body size limits.
- Domain/provider allowlists.
- Per-team configs.
- Local retention enforcement.
- S3 bucket lifecycle policies.
- Central audit logs.

## Suggested Rollout Plan

1. Align Desktop with current Collectivus.
   - Bump dependency from `1.0.0` to current.
   - Verify packaged `extraResources`.
   - Replace env-var launch config with `--config`.

2. Add `--config URL` to Collectivus.
   - Include caching and failure behavior.
   - Add tests for HTTP failures, invalid JSON, schema failures, and cached
     fallback.

3. Add managed Desktop service install.
   - Generate LaunchAgent plist with config URL.
   - Support noninteractive install/reconcile.
   - Disable Collectivus npm self-update in managed mode.

4. Add macOS pkg output.
   - Build clean artifacts.
   - Verify code signing.
   - Verify notarization and stapling.

5. Pilot with a small device group.
   - Apple Silicon and Intel if applicable.
   - Standard and admin users.
   - Fresh install and upgrade.
   - App moved/reinstalled.
   - Offline boot with cached config.
   - Uninstall and rollback.

6. Expand MDM deployment.
   - Deploy Managed Login Items/background profile.
   - Deploy app/pkg.
   - Monitor service health and data volume.
   - Roll out by department or device group.

## Verification Checklist

On a test Mac:

```bash
codesign --verify --deep --strict --verbose=2 \
  "/Applications/Hyperparam Desktop.app"

spctl -a -vv "/Applications/Hyperparam Desktop.app"

launchctl print gui/$(id -u)/app.hyperparam.collectivus

curl -sS http://127.0.0.1:4318/v1/traces \
  -H 'Content-Type: application/json' \
  -d '{"resourceSpans":[]}'
```

Check:

- App installed under `/Applications`.
- Collectivus resource exists under app `Contents/Resources`.
- LaunchAgent is loaded in the user domain.
- Config URL resolves and validates.
- Local listener is bound only to expected interfaces.
- JSONL files are written to the configured directory.
- Logs are readable by the user/admins intended to support it.
- Uninstall removes launchd artifacts and leaves or deletes data according to
  policy.

## Open Questions

- Should company-wide capture run per user or per machine?
- Is the default mode local proxy or central proxy?
- Which MDM is the first target: Jamf, Intune, Kandji, or another system?
- Do we need Intel macOS support?
- Do we need a separate managed preference domain for config URL and policy?
- Should Desktop expose a UI showing "managed by your organization"?
- Should body redaction exist before enterprise rollout?
- What is the required retention and upload target?

## References

- Apple Developer ID:
  https://developer.apple.com/developer-id/
- Apple notarization:
  https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution
- Apple Platform Deployment, proprietary in-house apps:
  https://support.apple.com/guide/deployment/distribute-proprietary-in-house-apps-dep873c25ac4/web
- Microsoft Intune macOS line-of-business apps:
  https://learn.microsoft.com/en-us/intune/intune-service/apps/lob-apps-macos
- electron-builder macOS targets:
  https://www.electron.build/mac
