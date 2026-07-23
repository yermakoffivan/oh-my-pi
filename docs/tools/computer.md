# computer

> Capture and control the real host desktop through native OS APIs. This is not the `browser` tool and does not use Chromium, CDP, Puppeteer, DOM, or ARIA surfaces.

User setup, safety guidance, platform permissions, and verified limitations: [Native computer use](../computer-use.md).

## Source

- Entry: `packages/coding-agent/src/tools/computer.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/computer.md`
- Safety prompt: `packages/coding-agent/src/prompts/system/computer-safety.md`
- Tool registration/gate: `packages/coding-agent/src/tools/index.ts`
- Approval wrapper: `packages/coding-agent/src/extensibility/extensions/wrapper.ts`
- Renderer: `packages/coding-agent/src/tools/computer-renderer.ts`
- Supervisor/protocol: `packages/coding-agent/src/tools/computer/{supervisor,protocol,worker,worker-entry}.ts`
- Native implementation: `crates/pi-natives/src/desktop.rs`
- Portable Linux stub: `crates/pi-natives/src/desktop_unsupported.rs`
- Native loader: `packages/natives/native/loader-state.js`
- Provider types: `packages/ai/src/types.ts`
- OpenAI GA schemas: `packages/ai/src/providers/openai-responses-server-schema.ts`
- OpenAI conversion/replay: `packages/ai/src/providers/openai-shared.ts`, `openai-responses.ts`, `openai-codex-responses.ts`, `azure-openai-responses.ts`

## Availability and declaration

- `computer.enabled` gates registration and defaults to `false`.
- Enabled tool load mode: `essential`.
- Concurrency: `exclusive`.
- Native descriptor: `{ type: "computer" }`.
- Providers serialize the descriptor only when `model.supportsComputerUse === true`.
- Automatic capability derivation covers GA `gpt-5.4+` IDs on OpenAI Responses, OpenAI Codex Responses, and Azure OpenAI Responses; explicit model metadata overrides derivation.
- Unsupported-model history conversion replaces native call/output items with stable assistant text notes.

Unlike `browser`, `computer` operates the entire visible host session. It can act in IDEs, terminals, native applications, browser windows, and system dialogs, but has no structured application/DOM inspection.

## Settings

| Setting | Type | Default | Contract |
|---|---|---:|---|
| `computer.enabled` | boolean | `false` | Register tool. |
| `computer.backend` | `auto \| native` | `auto` | Both prohibit non-native fallback. |
| `computer.display` | string | `all` | `all` or numeric native monitor ID. |
| `computer.maxWidth` | number | `1920` | Maximum composite PNG width; must be positive. |
| `computer.maxHeight` | number | `1200` | Maximum composite PNG height; must be positive. |

Constructor snapshots these settings into one `DesktopSessionOptions`. No setting is reread per call.

## Inputs

Public schema:

```ts
{
  actions?: unknown[]
}
```

The schema stays generic because provider-native `computer_call` metadata is authoritative. `execute()` chooses `context.toolCall.providerMetadata.actions` when metadata type is `computer`; otherwise it uses `params.actions`. Missing, empty, or invalid action arrays fail before worker dispatch.

### GA action shapes

| Type | Shape |
|---|---|
| `click` | `{ type, button: "left" \| "right" \| "wheel" \| "back" \| "forward", x, y, keys? }` |
| `double_click` | `{ type, x, y, keys: string[] \| null }` |
| `drag` | `{ type, path: Array<{x,y}>, keys? }`; native minimum two points |
| `keypress` | `{ type, keys: string[] }`; non-empty array and entries |
| `move` | `{ type, x, y, keys? }` |
| `screenshot` | `{ type }` |
| `scroll` | `{ type, x, y, scroll_x, scroll_y, keys? }` |
| `type` | `{ type, text: string }` |
| `wait` | `{ type }`; fixed two-second sleep |

Native validation rejects missing and unexpected fields before emitting input. Coordinate values must map to non-negative `i32` screenshot pixels. Mouse `keys` accept unique modifier keys only. Keypress strings are case-insensitive, accept aliases and `+`-separated chords, and fall back to one Unicode character. `wheel` is the GA middle-button spelling; `middle` is invalid.

Scroll conversion: nonzero provider delta `d` becomes `sign(d) × max(1, floor((abs(d)+50)/100))` native steps.

## Approval

`computerApproval(args)` returns:

- `read`: every action is `screenshot` or `wait`;
- `exec`: any input action, missing actions, or malformed action.

Approval prompts render up to 12 ordered action summaries, truncate each line to 240 characters, and cap the combined details at 2,000 characters.

Provider safety checks come from native call metadata, not parameters. Wrapper precedence:

1. Resolve ordinary mode and `tools.approval.computer` policy.
2. Explicit `deny` blocks immediately.
3. Pending provider checks force interactive approval regardless of `yolo`, `autoApprove`, per-tool `allow`, or xdev approval.
4. No UI fails closed with `Tool "computer" has pending provider safety checks but no interactive UI is available.`
5. Approval sets `context.providerSafetyApproved = true`.
6. Tool execution checks the marker again.
7. Successful output echoes pending checks as acknowledged checks.

The agent's system safety prompt independently treats all UI as untrusted and requires point-of-risk confirmation for consequential actions. Provider approval does not replace direct user authorization.

## Outputs

One successful call returns:

- `content`: one `{ type: "image", mimeType: "image/png", detail: "original", data: <base64> }` block;
- `details.width` / `height`: composite PNG dimensions;
- `details.backend`: `quartz`, `x11`, `wayland`, or `win32`;
- `details.displayServer`: OS display endpoint/subsystem label when known;
- `details.capturePermission` / `inputPermission`: `granted`, `denied`, `unknown`, or `unavailable`;
- `details.displays`: selected display geometry in global logical and screenshot-pixel spaces;
- `details.capabilities`: current native backend/capture/input status;
- `details.actions`: executed action type names;
- `providerMetadata.type`: `computer`;
- `providerMetadata.screenshot`: inline `computer_screenshot.image_url` data URI;
- `providerMetadata.acknowledgedSafetyChecks`: exact approved provider checks.

The renderer merges call and result. Expanded output shows every display; collapsed output shows at most three. Each row includes native ID/name, logical rectangle, PNG pixel rectangle, scale, and primary flag.

OMP native execution never creates a provider Files upload. The provider contract also accepts `{ type: "computer_screenshot", file_id }`; gateway/history parsing preserves that reference in metadata, and capable-model replay emits it unchanged.

## Flow

1. Tool registration checks `computer.enabled`.
2. `ComputerTool` constructs a `ComputerSupervisor` with session settings but does not start a worker.
3. Provider adapter exposes the native declaration only for capable models.
4. Provider `action`/`actions` and pending safety checks become typed tool-call metadata.
5. Extension wrapper resolves tool approval and mandatory provider safety approval.
6. `ComputerTool.execute()` chooses metadata actions, validates the batch, and rechecks safety approval.
7. Supervisor serializes execution behind a promise tail and lazily starts one Bun worker.
8. Worker constructs one native `DesktopSession` and reports capabilities.
9. A first coordinate batch triggers a pre-capture when no frame exists.
10. Native session validates all actions, executes them in order, and captures one fresh final PNG.
11. Worker transfers the PNG buffer to the parent and preserves session/frame state for the next call.
12. Tool returns image content, display/capability details, and exact GA result metadata.

## Capture and coordinate mapping

Native capture enumerates selected monitors, sorts by logical `y/x/id`, coalesces mirrored rectangles, and rejects duplicate IDs, invalid scale/size, and overlapping non-mirrored layouts. Monitor images are captured at native pixels.

The compositor builds the global logical bounding rectangle, then selects one render scale limited by native density and configured width/height. Display gaps remain opaque black. Maximum allocation: 268,435,456 composite pixels.

Every `DesktopDisplay` carries:

```ts
{
  id, name,
  x, y, width, height, scale,       // global logical space
  pixelX, pixelY, pixelWidth, pixelHeight, // returned PNG space
  isPrimary
}
```

Coordinate mapping finds the containing PNG display rectangle, scales locally to logical width/height, then adds global origin. Negative global origins work. Negative screenshot points, image bounds, and layout-gap points fail closed.

Before each coordinate action, native code re-enumerates displays and compares ID, logical rectangle, and scale against the stored frame. Difference clears the stored frame and returns `DESKTOP_LAYOUT_CHANGED`; caller must capture again.

## Platform variants

| Target | Native surface |
|---|---|
| `darwin-x64`, `darwin-arm64` | Real `DesktopSession` in core addon: xcap/CoreGraphics capture, Quartz `CGEvent` pointer events, native input. Screen Recording preflight; Accessibility required operationally. |
| `linux-x64` glibc | Core addon remains GUI-free. Separate `pi_natives.desktop.linux-x64[-variant].node` is loaded on first `DesktopSession` construction. X11 capture/input or XWayland capture plus portal/libei input. |
| `linux-arm64` | Published core has typed unsupported stub; no packaged desktop leaf. |
| Linux musl | Explicit typed unsupported stub. |
| `win32-x64` | Real `DesktopSession` in core addon: xcap, native input, `SendInput` absolute movement over the virtual desktop. |
| Other targets | Native package loader rejects unsupported platform tag. |

Wayland detection wins when `XDG_SESSION_TYPE=wayland` or `WAYLAND_DISPLAY` is set. Capture still requires `DISPLAY` because xcap 0.9.6 uses XWayland. Linux input first verifies the session bus and `org.freedesktop.portal.Desktop`, then initializes Enigo/libei without asking OMP to open a permission prompt. Coordinate input rejects Wayland frames containing more than one selected display.

macOS capture calls `CGPreflightScreenCaptureAccess()` without prompting. Input creation also disables automatic permission prompts. Windows sets DPI awareness and maps pointer coordinates with `MOUSEEVENTF_VIRTUALDESK`, supporting negative origins and secondary displays.

## Worker and session lifecycle

`ComputerSupervisor`:

- start timeout: 10 seconds;
- close timeout: 1.5 seconds;
- serializes calls even after an earlier call rejects;
- on abort, terminates worker and rejects pending requests;
- owner registry supports bulk close on session/eval-owner teardown.

`ComputerWorkerCore` also serializes inbound messages. It initializes once, holds `#hasFrame`, closes native session once, then unsubscribes and closes transport.

Native `DesktopSession` starts a named `omp-desktop-session` thread. Capture/execute/close requests use a FIFO channel. Operation waits are bounded to one minute; explicit close waits up to two seconds and is idempotent. Destructor sends best-effort close but does not block indefinitely on a stuck worker.

## Side effects

- Captures every selected visible display into model/provider context.
- Emits real user-session keyboard and pointer events.
- Keeps a native worker and desktop session alive across calls.
- May expose visible secrets, notifications, other applications, and system dialogs in screenshots.
- Linux x64 may lazily `dlopen` the separately packaged GUI-linked addon.
- Does not launch a browser, upload to provider Files, persist screenshots as local files, or create arbitrary child processes beyond its dedicated Bun/native workers.

## Errors

Stable native codes:

- `DESKTOP_INVALID_OPTIONS`
- `DESKTOP_INVALID_ACTION`
- `DESKTOP_BACKEND_UNAVAILABLE`
- `DESKTOP_PERMISSION_DENIED`
- `DESKTOP_CAPTURE_FAILED`
- `DESKTOP_INPUT_FAILED`
- `DESKTOP_LAYOUT_CHANGED`
- `DESKTOP_COORDINATE_OUT_OF_BOUNDS`
- `DESKTOP_SESSION_CLOSED`
- `DESKTOP_WORKER_FAILED`

Tool/wrapper errors also include:

- `Computer call requires at least one action`
- `Computer call contains an invalid action`
- `Computer session is closed`
- `Provider safety checks require interactive approval before computer input`
- `Timed out starting native computer worker`
- `Tool "computer" has pending provider safety checks but no interactive UI is available.`

Key platform failures and remedies are listed in [Native computer use: Troubleshooting](../computer-use.md#troubleshooting).

## Limits and proof boundary

- No non-native backend or browser fallback.
- No pure Wayland capture; XWayland required.
- No safe multi-display coordinate input on Wayland.
- Published Linux native desktop addon: x64 glibc only.
- Windows backend implemented but not remotely exercised for this feature.
- Real remote macOS proof used `ComputerSupervisor` → worker → native session on a real macOS host, controlling TextEdit with global hotkey, double-click, click, type, and 1920×1080 Quartz capture after permissions were granted.
- That proof did not include a live OpenAI native provider round trip. GA transport and replay are contract-tested locally.
