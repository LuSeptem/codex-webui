# Development Guide

Codex Web UI is a lightweight, local graphical interface built on top of Codex CLI; Codex CLI remains the underlying execution and session engine. This document is for contributors maintaining or extending the interface. For end-user usage, see [README.md](./README.md).

## Development environment

```bash
git clone https://github.com/LuSeptem/codex-webui.git
cd codex-webui
npm install
npm run dev          # http://127.0.0.1:3000
```

Requirements:

- **Node.js 18.18+**
- **Codex CLI** installed and authenticated (`codex login` or `CODEX_API_KEY`)
- OS: macOS / Linux / Windows. Windows paths are normalized by upper-casing the drive letter (`d:` → `D:`) to avoid duplicate project entries.

## Release metadata

Keep the release version synchronized in `package.json`, the root package entry in `package-lock.json`, and the Codex app-server `clientInfo` in `lib/codex/app-server.ts`. The README files expose the current release for users. Before publishing a tag, run `npm test` and `node node_modules/typescript/bin/tsc --noEmit`, then push the release commit and create the matching GitHub Release.

Useful scripts:

| Command | Purpose |
|---|---|
| `npm run dev` | Dev server on `127.0.0.1:3000` |
| `npm run build` | Production build |
| `npm start` | Production server on `127.0.0.1:3000` |
| `npm run lint` | ESLint (`eslint-config-next`) |
| `npm test` | Node regression tests for state, stream, and data-boundary helpers |

## Isolated showcase tool

`/showcase` is a standalone project feature for safe screenshots, product demos, visual QA, and onboarding. Open `http://127.0.0.1:3000/showcase` after starting the application. It mounts the production `AppShell`, including the real sidebar, session list, top bar, timeline, event cards, composer, directory picker, and config panel. The visual and interaction code is therefore identical to the main application rather than a separately maintained imitation.

Isolation happens at the data boundary. `ShowcaseEnvironment` installs an in-page fetch adapter before mounting `AppShell`, gives SWR a private cache, nests a fresh `ActiveSessionProvider`, and stores configuration under `codex-webui-showcase-prefs-v3`. Every `/api/*` call made by production hooks is answered from `lib/showcase/fixtures.ts`; unknown API routes and external requests are rejected. The fixture contains three synthetic projects and three standalone conversations, plus virtual config, skills, filesystem, usage, replay streams, and exec responses. It never reads `CODEX_HOME`, local sessions, the real filesystem, or Codex CLI.

Keep all fixture content fictional and never copy local session text or paths into `lib/showcase/fixtures.ts`. Browser QA must assert that no `/api/*` network request leaves the page. The README screenshot is captured at a 1440×900 viewport and stored as `docs/showcase.png`.

## Architecture overview

`middleware.ts` is the mandatory security boundary for every `/api/*` route. It delegates to `lib/server/local-api-security.ts`, which accepts only loopback request URLs and `Host` headers, requires browser `Origin` to match the request origin, rejects cross-site Fetch Metadata, and requires `application/json` for all write methods. Keep API routes under the `/api` matcher; a new write transport must not weaken these checks. This protects the unauthenticated local execution bridge against browser CSRF and DNS-rebinding-style Host abuse.

```
Browser ──POST /api/exec──▶ Next.js Route Handler
                              │
                              ├─ resolve codex binary (lib/codex/binary.ts)
                              ├─ spawn codex app-server over stdio JSON-RPC
                              ├─ thread start/resume + turn/start
                              ├─ notifications ──▶ SSE ──▶ ActiveSession reducer
                              └─ requestUserInput ◀── POST /api/exec/respond

Browser ──GET /api/sessions/:id/events──▶ lib/rollout/replay.ts
                                              │
                                              ├─ read rollout .jsonl[.zst]
                                              ├─ map items → item.completed events
                                              └─ SSE ──▶ same reducer as live
```

The backend never stores sessions — it reads codex's own rollout files directly, so there is exactly one source of truth. Live streams and replays feed the same `ActiveSession` reducer, which is why rendering is identical.

Because `exec` is a `POST`, the app cannot use `EventSource`. Instead the server streams `data: <json>\n\n` frames via a `ReadableStream`, and the client parses them manually with `fetch` + `ReadableStream` reader (`hooks/sse-client.ts`). The abort chain runs from the client `AbortController` → `request.signal` → kill the child process.

## Directory layout

```
app/
  layout.tsx                    RootLayout: ThemeProvider → LanguageProvider → ToastProvider → ActiveSessionProvider
  page.tsx                      Renders <AppShell />
  showcase/page.tsx             Mounts the production AppShell in the isolated showcase environment
  globals.css                   Tailwind + VSCode Dark+/Light+ token colors + KaTeX
  api/
    exec/route.ts               POST → app-server JSON-RPC bridge, SSE stream
    exec/respond/route.ts       POST → answer a pending structured question
    sessions/route.ts           GET → list sessions
    sessions/[id]/route.ts      GET → session metadata
    sessions/[id]/events/route.ts  GET → replay SSE stream
    config/route.ts             GET → model/sandbox/approval/effort enums
    fs/list/route.ts            GET → directory listing (cwd picker)
    skills/route.ts             GET → scan ~/.codex/skills + enabled plugins
middleware.ts                   Local-only request boundary for every /api/* route
lib/
  session/
    active-session-state.ts     Pure live/replay reducer and execution-start transitions
    project-selection.ts        Decide whether a project click keeps or resets the active session
  codex/
    binary.ts                   Resolve codex binary (CODEX_BIN → CODEX_JS → npm global → PATH)
    args.ts                     Build argv for new + resume sessions
    spawn.ts                    spawn(shell:false) → stdout lines, stderr, kill, onExit
    events.ts                   Parse JSONL → typed events; normalize item text
    severity.ts                 Classify codex messages (error/warning/info)
    slash-commands.ts           15 registered slash commands
    app-server.ts               Persistent stdio JSON-RPC connection per live turn
    app-server-events.ts        Map app-server items, usage, and user-input requests
    interactions.ts             Pending request registry for cross-request answers
  i18n/
    messages.ts                 English/Chinese message catalogs + locale types
  showcase/
    fixtures.ts                 Synthetic sessions, events, config, filesystem, and fetch adapter
  rollout/
    paths.ts                    codexHome(), sessions/ + archived_sessions/ layout
    reader.ts                   Read .jsonl + .jsonl.zst (fzstd streaming)
    list.ts                     Enumerate sessions, build previews, filter subagents
    replay.ts                   Map rollout lines → SSE events (dedup, filter system injects)
    session-index.ts            Read session_index.jsonl → id→thread_name
    types.ts
  server/
    local-api-security.ts       Loopback, same-origin, Fetch Metadata, and JSON-write validation
    sse.ts                      SSE frame encoder
    config.ts                   Enum resolution for /api/config
    skills.ts                   Scan skills directory + plugins
  utils/
    cn.ts                       clsx + tailwind-merge
    diff.ts                     Unified diff parser
    format.ts                   Time/duration/token formatting
    highlight.ts                highlight.js line splitting for diffs
components/
  layout/   AppShell · Sidebar · TopBar
  showcase/ ShowcaseEnvironment · showcase mode context
  session/  SessionView · EventTimeline (virtualized) · Composer · EmptyState · ConversationNav · SkillMenu · SlashCommandMenu
  events/   EventCard dispatcher + 10 typed cards + Markdown
  diff/     DiffViewerDialog
  sessions/ SessionList · SessionListItem
  config/   ConfigPanel
  fs/       DirectoryPicker
  theme/    ThemeToggle
  i18n/     LanguageProvider · LanguageToggle
  ui/       shadcn-style primitives
hooks/
  sse-client.ts                 Manual SSE frame parser (fetch + ReadableStream)
  useExecStream.ts              POST /api/exec, manage AbortController
  useReplayStream.ts            GET /api/sessions/:id/events
  useSessionList.ts             SWR session list with refresh
  useConfig.ts                  SWR /api/config + per-session prefs (localStorage)
  useSkills.ts                  SWR /api/skills
stores/
  active-session.tsx            Context + useReducer state machine (live + replay)
  toast.tsx
types/
  api.ts                        Shared frontend/backend types
logo/
  codex-color.svg               Codex compatibility mark; see THIRD_PARTY_NOTICES.md
```

## Core data flow

### Live execution (`/api/exec`)

1. Client `POST /api/exec` with `{ prompt, cwd, model, effort, collaborationMode, sandbox, approvalPolicy, resumeSessionId? }`.
2. `lib/codex/binary.ts` resolves the codex executable (cached).
3. `AppServerConnection` spawns `codex app-server`, performs `initialize`, then sends `thread/start` or `thread/resume` followed by `turn/start` while keeping stdin open.
4. `app-server-events.ts` maps notifications and camelCase thread items into the existing SSE event types. `AbortSignal` kills the app-server process.
5. A server request named `item/tool/requestUserInput` is registered in `interactions.ts` and emitted as a `user_input_request` timeline item. The card posts answers to `/api/exec/respond`, which writes the JSON-RPC response to the same process so the same turn continues.
6. `hooks/useExecStream.ts` marks the state as running and inserts a pending `user_message` before awaiting the app-server response. A resumed request keeps its replayed timeline; a new request starts from an empty timeline before that pending item is appended. If an app-server user item later arrives, the reducer reconciles it by text instead of duplicating it. The first non-ephemeral `thread.started` event becomes the next prompt's `resumeSessionId`.
7. `lib/server/sse.ts` encodes mapped events as `data: <json>\n\n`; `hooks/useExecStream.ts` dispatches them to the shared reducer.

The Composer's outer surface intentionally uses `px-4 py-[6px]`: it keeps the input area low-profile while preserving separation from the timeline and the lower configuration panel. Adjust this container rather than the textarea or keyboard-hint margins when tuning the send area's vertical density.

When a replay stream ends normally, `useReplayStream.ts` dispatches `FINISH_REPLAY`. It converts any unmatched historical running turn to completed, so incomplete rollout traces cannot leave a stale `RUNNING` divider in a finished conversation. Only this successful replay path finalizes turns; live execution remains controlled by its own stream events.

### Replay (`/api/sessions/:id/events`)

1. `lib/rollout/paths.ts` resolves the rollout file under `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` or `~/.codex/archived_sessions/` (`.jsonl.zst` for >7 days). `findRolloutFile` searches both roots, preferring plain `.jsonl`.
2. `lib/rollout/reader.ts` transparently reads `.jsonl` (createReadStream + readline) or `.jsonl.zst` (fzstd `Decompress` streaming → readline).
3. `lib/rollout/replay.ts` maps rollout lines to the same SSE events as live:
   - Deduplicates `event_msg/agent_message` vs `response_item/message`.
   - Canonicalizes Codex Desktop file wrappers before deduplication, retaining the explicit request plus attachment metadata while dropping `<image>` and ambient-browser markup. This ensures the `response_item` copy with image data wins over the duplicate `event_msg` copy.
   - Skips system-injected role:user context (`<recommended_plugins>`, `<environment_context>`, `# AGENTS.md`, etc.).
   - Maps `custom_tool_call(exec, shell_command)` → `command_execution`, `patch_apply_end` → `file_change`.
   - Clears `seenMessageKeys` / `seenReasoningTexts` in `clearTurn()` so user messages aren't incorrectly deduplicated across turns.

### Session listing (`/api/sessions`)

`lib/rollout/list.ts` walks both root directories (cap 10000 files), reads the first line for `session_meta`, extracts the first non-system-injected user message as a preview, joins `session_index.jsonl` for `thread_name`, filters out subagent-generated sessions (source contains `{"subagent":...}`), supports `cwd`/`q` filters, default limit 200.

`components/sessions/SessionList.tsx` groups items by normalized cwd. Clicking a project header synchronizes that project's cwd; if the active session belongs to the project, its per-session preference is corrected in place, otherwise the old stream/session is cleared and the project cwd becomes the new-session default. Clicking a history item writes its `ThreadItem.cwd` to that session's preference before replay starts.

### Frontend state machine (`lib/session/active-session-state.ts` + `stores/active-session.tsx`)

A pure reducer, wired through a React Context provider, with `status` (`idle` / `running` / `completed` / `failed` / `aborted`), `threadId`, `sessionMeta`, `timeline` (`TurnEntry` | `ItemEntry[]`), `totalUsage`, `rateLimits`, `error`, `isReplay`, and `resumeSessionId`. `rateLimits` is account-global state: reset, replay, and new-session transitions preserve it, while replay `rate_limits.updated` and historical usage snapshots are ignored; `contextTokens` and `contextWindow` remain session-specific. `lib/session/global-rate-limits.ts` persists the latest real-time rate limit in browser storage. On a cold browser cache, the provider calls `/api/usage/rate-limits`, which scans recent sessions by update time and returns the newest recorded rate-limit snapshot; this bootstrap is not tied to the selected replay. `START_EXECUTION` enters `running` before network/app-server startup; resumed executions preserve the existing timeline while new executions reset it. `ADD_PENDING_USER_MESSAGE` immediately appends the submitted prompt and reconciles a matching live user item if Codex later sends one. `FINISH_REPLAY` closes unmatched historical running turns after a successful replay. Both live and replay events route through the same `dispatchEvent`. The pure module is the regression-test seam for these transitions.

### Timeline rendering (`components/session/EventTimeline.tsx`)

`@tanstack/react-virtual` with dynamic measurement. The timeline is aggregated into `DisplayEntry` (`turn` / `item` / `response_block`). `INTERMEDIATE_TYPES` (`reasoning`, `command_execution`, `file_change`, `web_search`, `mcp_tool_call`, `plan_update`) are merged into a `response_block`. `estimateSize` per type; auto-follow when the user is at the bottom (with an 800ms scroll lock); force-scroll-to-bottom on session switch.

Rendered event types (see `EventCard.tsx` dispatcher): `agent_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`, `web_search`, `plan_update`, `user_message`, `user_input_request`, `error`.

## Configuration & preferences

`hooks/useConfig.ts` fetches `/api/config` (model/sandbox/approval/effort enums) via SWR and persists per-session preferences, including collaboration mode, to `localStorage` under `codex-webui-prefs-v3` (a `default` object + a `sessions` map). `updatePrefs` accepts an optional explicit session target so project/session selection can write cwd to the intended scope instead of whichever session is currently rendered. Switching models auto-corrects unsupported `effort` values.

### Windows Codex process resolution

`lib/codex/binary.ts` must keep binary discovery shell-free on Windows. Do not invoke `npm.cmd`, `.cmd`, `.bat`, or `.ps1` shims just to locate Codex: inspect the known npm global directories, resolve `@openai/codex/bin/codex.js` through Node, and use `where.exe` with `shell:false` only as a direct-executable fallback. The app-server and legacy exec paths also use `spawn(..., { shell: false, windowsHide: true })`. This removes the unnecessary `cmd.exe` child process that can trigger Web-server protection when a user sends a message. It does not bypass endpoint security; a local, narrowly scoped trust rule may still be required by the user's security product.

Theme and interface language both default to following the operating system when no stored preference exists. `ThemeProvider` uses `defaultTheme="system"` with `enableSystem`, while next-themes preserves explicit light/dark selections. Existing user preferences are never overwritten by the defaults.

### Internationalization

`LanguageProvider` owns an independent `codex-webui-language` preference with `system`, `zh-CN`, and `en`, initialized to `system`. In system mode it resolves `navigator.language` and listens for `languagechange`; every resolved change also updates `document.documentElement.lang`. UI strings live in `lib/i18n/messages.ts`; user/model content is never translated. Add new strings to both catalogs through the typed `MessageKey` union. Keep `LanguageToggle` visually aligned with `ThemeToggle` (button dimensions, chevron, menu surface, typography, and selected-state dot) so the two global preferences read as one control family in both themes.

For rich hover details, use one tooltip implementation per trigger. Do not combine a native `title` attribute with a custom `role="tooltip"` surface: browsers will display both. The context-usage trigger is keyboard-focusable and exposes only the custom tooltip through `aria-describedby`.

## CLI compatibility and history I/O

- Both live app-server file changes and persisted FileChange maps use lib/codex/file-change.ts. It accepts structured or legacy string kinds, preserves update diffs and move paths, and turns add/delete file content into unified diffs.
- Replay consumes event_msg/item_completed CommandExecution and FileChange records. Command completions preserve output, status and exit codes. Older shell_command/exec_command text is a deferred fallback, discarded when a matching structured command completes; replay never evaluates stored JavaScript.
- Session listing sorts filesystem metadata before reading records, processes small batches until the requested number of filtered results is found, and caches heads/previews by path, size and mtime. Titles are reloaded from the session index so renames do not require touching the rollout. Preview reads stop at the first real user prompt.
- Compressed readers use a pipeline so early close, backpressure and decoder errors reach the source stream. Do not leave the compressed input reading after a head/preview consumer stops.
- Run npm test for structured/legacy replay, live and replay file diffs, bounded history I/O, cache invalidation, filters/title refresh, and compressed stream lifecycle. Test fixtures stay under ignored .tmp/compat-tests; no user history is copied into the tests.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `CODEX_BIN` | — | Absolute path to the codex executable. On Windows, prefer the real binary (not the `.cmd` shim). |
| `CODEX_JS` | — | Absolute path to `@openai/codex/bin/codex.js` (the Node launcher). Useful when native binary resolution fails. |
| `CODEX_HOME` | `~/.codex` | Override the codex home directory (where `sessions/`, `archived_sessions/`, `auth.json`, and `skills/` live). |

## Extending the app

### Add a new event type

1. Add the type to `types/api.ts`.
2. Add a case in `lib/codex/events.ts` parser (and `lib/rollout/replay.ts` if it appears in rollouts).
3. Add a reducer case in `stores/active-session.tsx`.
4. Add a card component under `components/events/` and register it in `EventCard.tsx`.
5. If it's an intermediate event that should fold into the thinking block, add it to `INTERMEDIATE_TYPES` in `EventTimeline.tsx`.

### Add a slash command

Edit `lib/codex/slash-commands.ts`. Each entry has `name`, `description`, `usage`, and a `local` flag. `/clear` executes locally (clears the session); all others insert the command name followed by a space as a prompt. The autocomplete menu in `components/session/SlashCommandMenu.tsx` opens when `/` is typed with no following space, supporting `↑↓` navigation, `Tab`/`Enter` confirmation, and `Escape` to close.

### Add a skill to `@` completion

Skills are auto-discovered from `~/.codex/skills/` and enabled plugins via `lib/server/skills.ts`. Drop a skill directory in place and it appears in the `SkillMenu`.

## UI conventions

These conventions are enforced across the codebase — follow them when adding components:

- **Corner radius:** all rectangular components use `rounded-md`. The Composer input box uses `rounded-xl` with `shadow-sm` (`shadow-md` on focus) and a theme-color border when focused.
- **Fonts:** main text uses Microsoft YaHei; code/formulas retain a monospaced font. Base font size 15px, line height 1.7.
- **Project title:** Microsoft YaHei font, with the folder path displayed below it.
- **User messages:** right-aligned, gray rounded bubble (`rounded-xl` + `bg-[hsl(var(--overlay)/0.06)]`), avatar on the right, timestamp right-aligned, content `max-width` 80%, and default `py-[8px]`. Attachments sit above the text bubble: images use compact lightbox thumbnails, while non-image files use a restrained filename/path card. The lightbox treats the image area as a canvas: wheel input performs continuous clamped zoom (10–400%), and the primary pointer can drag the image using pointer capture only after its rendered size exceeds the viewport. Its fixed viewport centering frame lives inside a 16px inset canvas measured with `getBoundingClientRect()`, so pan is clamped to half of each overflow dimension and either image edge can meet, but never pass, that buffered canvas edge; the zoomed image is `shrink-0` so Flex layout cannot collapse it. Fitting or switching images resets its pan. Never render Codex Desktop's `# Files mentioned by the user`, `<in-app-browser-context>`, or `<image>` wrappers as Markdown.
- **Browser comments:** `formatUserMessageForDisplay` keeps a compact canonical form for replay/deduplication; `parseBrowserCommentDisplay` converts it into a dedicated icon label, numbered comment rows, and an optional request section. Do not render its `###` markers through the global Markdown heading styles.
- **Avatars in EventTimeline:** only the first `agent_message` in each round shows avatar + name + timestamp; subsequent continuation messages use `pl-11` indentation without avatar. `user_message` and turn boundaries reset the display flag.
- **Thinking process:** implemented as a collapsible `ProcessGroupCard` with gray background (`surface-2`), default collapsed showing a summary preview + action count (e.g. "2 命令 · 1 文件"); expanded shows thinking text (left border + weakened color) and action list. In `ResponseBlockCard`, both clickable and non-clickable collapsed headers give their preview item `min-w-0 flex-1 truncate`, while the header flex item also has `min-w-0`, ensuring long summaries ellipsize inside the gray frame. Continuous intermediate events merge into one collapsible block; boundary events (`user`/`agent`/`turn`/`error`) trigger flush; empty reasoning is auto-filtered.
- **ConversationNav:** positioned absolutely at `left-1.5 top-1/2 -translate-y-1/2` (vertical center of conversation left side). Dots default 6px light gray, hover 10px theme color. Tooltip shows user message preview (120-char truncation, `line-clamp-4`). Click triggers `virtualizer.scrollToIndex(index, { align: "start" })` after clearing `userScrollLock`. Auto-hides when fewer than 2 user messages; internal scroll (hidden scrollbar) when dots exceed 70vh. User messages deduplicated by `normalizeText` (whitespace compression) as key. Active dot auto-highlights based on visible conversation area.
- **Codex avatar:** uses `logo/codex-color.svg` (third-party and trademark notices are recorded in `THIRD_PARTY_NOTICES.md`) at 20px in a 32px theme-color rounded container, adapting to light/dark themes. In Next.js 15, SVG static imports return `StaticImageData` objects — use the `.src` property to get the URL string, not the object directly (which renders `[object Object]` and causes `naturalWidth: 0`).
- **Copy button:** each Codex message card has a `CopyButton` in the bottom-right, appearing on hover/focus, copying original markdown via `navigator.clipboard.writeText(item.text)`. Success state shows a `Check` icon and "已复制" prompt for 1.2s.
- **Code highlighting:** matches VSCode Dark+/Light+ token colors. Code blocks go through `rehype-highlight`; diffs go through `highlightAndSplit` (rebuilds new/old versions → highlights → splits by line → maps back to diff lines, preserving cross-line span continuity). `.py` code blocks use heuristic language detection (Python/JS-TS/Shell/JSON/Python-like fallback) for `text`-marked blocks. `Markdown.tsx` also converts LaTeX delimiters (`\[...\]` → `$$...$$`).
- **Markdown images:** `mapMarkdownImageSource` accepts browser-safe image URLs and rewrites only paths under `.codex/visualizations/` to `/api/fs/image`. The route resolves real paths beneath `codexHome()/visualizations`, rejects traversal/symlink escapes and unsupported formats, and returns `nosniff` image responses. Missing or blocked sources render a compact `ImageOff` fallback.
- **Composer placement:** the input box lives in `AppShell`'s `<main>` so it's visible in both empty and active conversation states. Placeholder switches between "Ask codex anything…" (new session) and "Continue the session…" (existing session).
- **EventTimeline filtering:** must filter out `function_call` and `function_call_output` entries to prevent scroll height miscalculations.
- **Severity classification:** codex CLI error events containing "skills context budget" or "Skill descriptions were shortened" are classified as warnings, not errors. Warnings use yellow accent + `Info` icon + "warning" label; errors use red danger + `AlertTriangle`.
- **Markdown:** upgraded from `prose-sm` to `prose-base`, with paragraph/list spacing increased accordingly. Reasoning items are deduplicated using a `Set` for `agent_reasoning` and `reasoning.summary`.

## Known limitations

- **Structured questions require Plan mode.** Default mode does not expose `request_user_input`. Permission approvals are routed to Codex's automatic reviewer and are not rendered as user cards.
- **Windows `.cmd` shim.** If codex is installed via npm on Windows, the app prefers launching `codex.js` through `node` (platform-independent launcher) to avoid `.cmd` shim / `shell:true` security issues. If that fails, set `CODEX_BIN` to the real executable.
- **Single user.** No authentication, no multi-tenant isolation. Bind is `127.0.0.1` only.
- **Rollout read-only.** The UI never writes to `~/.codex/sessions/`; codex is the sole writer. Archived `.jsonl.zst` files (>7 days) are decompressed on the fly with `fzstd`.
- **Slash commands via prompt.** The Web UI provides its own completion menu; commands are still sent as prompt content rather than relying on the terminal TUI.

## Lessons learned

- Extracting codex usage from `info.last_token_usage` is more accurate than `p.usage`.
- The web-ui previously missed handling `event_msg/agent_reasoning` events, causing failure to display plaintext reasoning that codex CLI could show.
- Directly using a `StaticImageData` object as an `img src` in Next.js 15 causes `[object Object]` rendering and `naturalWidth: 0` error — use `.src`.
- `EventTimeline`'s `flushBlock` resetting `blockTurnMeta` on `user_message` caused loss of turn metadata, leading to incorrect "执行动作" labels and missing default collapse behavior for processed content.
- `koa-connect` wrapper caused `ctx` leaks, so the server uses a native rewrite instead.

## Troubleshooting (development)

**`codex executable not found`** — Set `CODEX_BIN` to the absolute path of the codex binary, or ensure `codex` is on `PATH` and `codex --version` works in the same shell you use to start the dev server.

**`Model metadata for 'gpt-5-codex' not found`** — This is a codex CLI warning (shown as an error card in the timeline), not a Web UI issue. Run `codex` in a terminal directly to confirm; switch models in the config panel if needed.

**Hydration warnings in console** — `data-trae-ref` attributes injected by browser automation tooling can cause SSR/client attribute mismatch warnings. These are dev-only artifacts and do not affect production.

**Port 3000 in use** — Another process (often a stale dev server) holds the port. Kill it or run on a different port: `npx next dev -H 127.0.0.1 -p 3001`.

## Tech stack

Next.js 15 (App Router) · React 19 · TypeScript · Tailwind CSS · SWR · @tanstack/react-virtual · react-markdown · rehype-highlight · KaTeX · fzstd · lucide-react · next-themes

## License and project identity

Project source is released under the [MIT License](./LICENSE). The `private: true` package flag intentionally prevents accidental npm publication and does not change the source license. Third-party dependencies retain their own licenses, and bundled third-party material is recorded in [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md). This is an independent community project; OpenAI and Codex names and marks belong to OpenAI and must not be used to imply affiliation or endorsement.
