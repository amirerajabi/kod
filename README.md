# Kod

A focused C# / .NET IDE in the spirit of Rider: write code with Roslyn IntelliSense, fix it with Alt+Enter, build, run
and test with the dotnet CLI, manage NuGet packages, and use a terminal, in one keyboard-first window.

Kod follows the architecture and UI structure of Rowlit: an **Electron** shell, a **React + Monaco** UI, and a
**.NET 10 engine** that runs as a local sidecar. The UI talks to the engine over token-authenticated HTTP and a
WebSocket event stream; the engine owns everything that touches code, files and processes.

```
desktop/   Electron shell: window (Windows caption overlay, macOS inset), kod://app protocol, engine lifecycle
ui/        React + Monaco UI: top bar, tool window stripe, side panel, editor tabs, tool windows, status bar, palette, dialogs
engine/    Kod.Engine (ASP.NET Core minimal API on 127.0.0.1)
  Workspace/  MSBuildWorkspace solution / project loading, live editor text overlays, file watching, files, search
  Intel/      Roslyn: completion, hover, signature help, diagnostics, navigation, usages, rename, format,
              semantic tokens, outline, code fixes and refactorings, metadata views
  Processes/  dotnet build / run / test / new / add package and the terminal shell, streamed over /ws
  Nuget/      v3 feed search, registration details, versions, sources, PackageReferences (incl. central versions)
  Ai/         the assistant's agent loop and workspace tools; Claude via the Anthropic SDK, other providers via
              the OpenAI-compatible chat completions API
```

## Features

**Editor**
- Monaco editor with tabs (preview tabs, drag to reorder, dirty markers, session restore per folder), breadcrumbs,
  sticky scroll, minimap, bracket colours, Rider colour scheme driven by **Roslyn semantic classification**.
- **IntelliSense** from Roslyn's `CompletionService`: members, types, keywords, overrides, with documentation;
  C# live templates (`prop`, `ctor`, `cw`, `foreach`, `fact`, …).
- **Postfix templates** (`expr.if`, `.foreach`, `.var`, `.null`, `.notnull`, `.await`, `.return`, `.using`, `.switch`,
  `.par`, `.cast`, `.new`, …) offered by what the expression is, and **Surround With** (Ctrl+Alt+T: if, while,
  for/foreach, try/catch/finally, using, lock, #region, braces, parentheses…).
- **Inlay hints**: parameter names before literal arguments, inferred types of `var`, `foreach` and lambda parameters.
- **Code Vision**: usages and implementations / inheritors / overrides above types and members, counted as they
  scroll into view; click to show usages or go to implementations.
- **Hover** quick info, **parameter info** (overloads, active parameter, XML docs), **live diagnostics**
  (errors, warnings, unnecessary usings faded).
- **Code inspections** while typing: Roslyn's IDE analyzers (unused members and parameters, redundant code,
  simplifications, style) and the projects' own analyzers (the SDK's CA rules, StyleCop, …), following .editorconfig.
- **Alt+Enter**: Roslyn's own code fixes (add `using`, generate method/type, implement interface, …) and
  refactorings (convert, introduce, extract, …); "Fix all in file / solution" and "Disable with #pragma".
- **Navigation**: go to declaration (F12 / Ctrl+B / Ctrl+click), type declaration, implementation, base symbols
  (Alt+Home), derived symbols (Alt+End), related files (Ctrl+Alt+Home), find usages (Alt+F7 Find window grouped by
  usage type, project, folder, file and member, with read/write filters, preview and pinned tabs), **Show Usages**
  (Ctrl+Alt+F7 popup at the caret with speed search; read, write, invocation, nameof... per usage), peek (Shift+F12), Navigate To (Ctrl+Shift+G), next / previous member (Alt+Down / Alt+Up), Back / Forward across
  files (Ctrl+Alt+Left / Right), Recent Files (Ctrl+E), Recent Locations (Ctrl+Shift+E), file structure, metadata
  view for framework types (generated declarations with docs).
- **Call Hierarchy** (Ctrl+Alt+H: callers / callees) and **Type Hierarchy** (Ctrl+H: subtypes / supertypes) in the
  Hierarchy tool window, expanded one level at a time.
- **Refactor This** (Ctrl+Shift+R): Rename, **Change Signature** (Ctrl+F6: add, remove, reorder and rename parameters
  across calls, overrides and implementations), **Safe Delete** (Alt+Delete: checks usages first; a parameter is
  removed from every call), **Extract Interface**, **Move Type** to another file or folder (namespace updated),
  **Pull Members Up** / **Push Members Down**, **Inline** (Ctrl+Alt+N: a local, a constant or field, a method at
  every call or just this one), **Extract Class**, plus every Roslyn refactoring at the caret.
- **Generate** (Alt+Insert in the editor): constructor (with null checks), properties, read-only properties,
  equality members (IEquatable, GetHashCode, == / !=), ToString, overriding members, missing members, dispose
  pattern, each with a member picker.
- **Inspect Code** on the whole solution (Inspections tool window, grouped by inspection, Fix all) and **Code
  Cleanup** (Ctrl+Alt+Shift+L: redundancies removed, syntax style applied, usings sorted, reformatted).
- **Rename** across the solution (F2 / Shift+F6), **reformat** (Ctrl+Alt+L), comment, move/duplicate lines.

**Debugger**
- Breakpoints in the gutter (F9 / Ctrl+F8), F5 to debug or resume, F10 / F11 / Shift+F11 to step, **Run to Cursor**
  (Alt+F9), Shift+F5 to stop, the execution line while paused.
- **Breakpoint properties** (right-click the dot, Ctrl+Shift+F8): condition, hit count (the Nth hit, from the Nth,
  every Nth), log message with `{expressions}`, suspend or not (a logpoint: Shift+click the gutter), enable /
  disable, remove once hit.
- **Break on exceptions**: user-unhandled or all thrown; the pause shows the exception's type and message.
- **Attach to Process** (Ctrl+Alt+F5): any running .NET program; stopping detaches and leaves it running.
- Debug tool window: call stack, variables tree (double-click a value to **set** it), breakpoints, debug console
  with expression evaluation; hover a variable while paused to see its value.
- Uses [netcoredbg](https://github.com/Samsung/netcoredbg) (MIT) over the Debug Adapter Protocol; Kod downloads it
  on first use (or set `KOD_NETCOREDBG`). ASP.NET Core apps get their launch profile URL and environment.
- **Visualizers**: a View link on collections, arrays, dictionaries and DataTables opens them as a grid (one column
  per field or property; sort, filter, copy as CSV / TSV), and on long strings a Text / JSON / XML / HTML viewer.
- **Live diagnostics** (Debug window › Diagnostics, like Visual Studio's Diagnostic Tools): CPU, memory and GC heap,
  garbage collections, allocation rate, exceptions per second and the thread pool, charted live over EventPipe,
  with every exception (type and message) and GC as it happens.

**Git** (the git CLI, with your own config and credentials)
- Commit window (Alt+0): changes with check boxes, message, Amend, Commit / Commit and Push, Rollback, Stage /
  Unstage; diff tabs (side by side or unified); added / modified / deleted markers in the gutter while you type.
- Annotate (blame), Git colours on file names, a branches popup (checkout, new, delete, pull, push, fetch) and a
  Git log window (Alt+9) with commit details and per-file diffs.
- Inline blame of the caret line, like GitToolBox: author, time ago and commit message at the end of the line.
- Git › Manage Remotes: add, rename, change the URL of and remove remotes.
- **Pull Requests** tool window (GitHub, signed in with `gh` or a token): open / closed / mine, details with checks,
  reviews and comments, the changed files as diffs, Checkout, Create Pull Request, comment, review (approve, request
  changes) and merge (merge, squash, rebase).
- **Changelists** in the Commit window (the active one's files are checked for the next commit) and **partial
  commits**: expand a file to pick hunks or single lines.
- **Merge conflicts**: a Conflicts dialog (Accept Yours / Accept Theirs / Merge…) and a three-way merge tool (yours,
  the result with Accept actions per conflict, theirs); Continue / Skip / Abort for a stopped merge, rebase,
  cherry-pick or revert.
- From the log: **Cherry-Pick**, **Revert Commit**, **Reset Current Branch to Here** (soft / mixed / keep / hard),
  Checkout Revision, New Branch, and **Interactively Rebase from Here** (reorder, reword, edit, squash, fixup, drop).
- **Stash** (save, apply, pop, drop, browse the stashed files) and **Shelf** (set changes aside as patches, unshelve
  later), in the Git window's Stashes and Shelf tabs.

**Local History, bookmarks, TODO**
- **Auto Save** like Rider's, on by default: files are saved when Kod loses focus, when you switch or close a tab,
  before build / run / test / debug and Git, after a quiet moment (15 s, adjustable), and before Kod quits. There
  is no "save changes?" question; Local History keeps every version. Settings › General switches to the other modes.
- **Local History** of every file, Git or not: every save, delete, refactoring, revert and external change (another
  program, a git checkout) keeps a revision (30 days); diff any revision against the current text, revert to it,
  put labels.
- **Project and folder history** (Explorer › Local History, File › Local History): every change across files, newest
  first, with project labels (yours, every commit, every revert); pick a change to see what it did to each file,
  and revert the whole change or one file. **Show History for Selection** (right-click in the editor) lists only the
  versions in which the selected lines changed; **Recent Changes** (Alt+Shift+C) shows the latest at a glance.
- **Bookmarks**: F11 toggles one, Ctrl+Shift+1…9 a numbered one, Ctrl+1…9 jumps back, Ctrl+F11 a letter; they
  follow edits and are listed in the Bookmarks window (Shift+F11).
- **TODO** window (Alt+Shift+6): TODO / FIXME / HACK / BUG / NOTE comments of the project or the current file.

**Database** (Alt+Shift+D)
- Data sources for SQL Server, PostgreSQL, MySQL / MariaDB and SQLite (fields or a connection string; passwords in
  the OS keychain), or imported from appsettings.json's ConnectionStrings.
- Schema tree (schemas, tables, views, columns with types and keys, routines); Select Top 100 Rows.
- SQL consoles: Ctrl+Enter runs the selection or the statement at the caret, Ctrl+Shift+Enter the whole console;
  results grid with several result sets, NULLs, copy as TSV / CSV, errors linked to their line, cancel.
- **SQL completion** from the schema (tables, columns, aliases) in consoles and inside C# strings: FromSqlRaw,
  ExecuteSqlRaw, SqlQuery, Dapper's Query / Execute, or any string that starts like a SQL statement.

**Docker**
- **Services** window (Alt+Shift+8): Docker Compose files and their services, containers and images; start, stop,
  restart, remove, logs, a terminal inside a container; compose up / down / stop / restart / build / pull.
- **Run in Docker**: builds the project's Dockerfile and runs it with its EXPOSEd ports, output in the Run window.
- **Debug in Docker** (Rider's fast mode): the Dockerfile's `base` stage (or the official runtime image) with the
  local build mounted and a Linux netcoredbg inside; breakpoints and stepping as usual.

**AI Assistant** (Alt+2)
- Chat with Claude (Anthropic SDK), ChatGPT, GLM (Zhipu / Z.ai), Gemini, DeepSeek, Mistral, Grok, Qwen, OpenRouter,
  Ollama, LM Studio or any OpenAI-compatible server.
- Agent mode reads and searches the workspace, edits files and runs commands, asking before each edit or command;
  Auto and Chat modes. Streaming Markdown answers, code blocks with Copy / Insert, editor actions (Explain, Fix,
  Write tests, Document). API keys are kept encrypted by the OS keychain.
- **Inline completions** (Settings › AI): grey ghost text as you type, from your provider and a fast model
  (Claude Haiku, GPT-5 mini, Gemini Flash, Codestral… or one you choose). Tab accepts, Ctrl+→ a word, Alt+\ asks.

**Unit tests**
- Test explorer (Alt+8) for xUnit, NUnit and MSTest, discovered by Roslyn: run all / failed / a namespace, class or
  test, theory rows, failure message with a stack trace linked to the source, test output; "Run test" code lenses
  with the last result in the editor.
- **Code coverage**: Run with Coverage (the shield button, or right-click a test) collects line and branch coverage
  (coverlet, or Microsoft Code Coverage); green, red and yellow bars in the editor gutter for covered, uncovered and
  partly covered lines, and the **Coverage** window per assembly and file.

**HTTP Client** (.http / .rest files, Rider's and Visual Studio's format)
- ▶ Send request above every request, or Ctrl+Enter in it; responses in the HTTP Client window (formatted JSON / XML,
  images, headers, timing, size), with a history.
- Variables (`@name = value`), environments from `http-client.env.json` / `http-client.private.env.json`,
  `{{$guid}}`, `{{$timestamp}}`, `{{$randomInt}}`, bodies from files (`< ./body.json`), Copy as cURL, and
  completion of methods, headers and variables. Requests go through the engine, so localhost dev certificates work.
- Right-click a web project › **Generate HTTP Requests**: a .http file with a request for every endpoint (minimal
  APIs, MapGroup prefixes, controllers) at the launch profile's URL.

**EF Core** (the EF Core tool window, via `dotnet ef`)
- The migrations project, startup project and DbContext; migrations with whether the database has applied them.
- Add / remove migrations, update the database (to the latest or any migration), revert all, drop the database,
  and generate the SQL script (idempotent where the provider supports it).
- Scaffold a DbContext and entities from a Database panel data source; its connection string stays out of the
  command line and the generated code. Installs dotnet-ef or the Design package when they are missing.

**Settings and updates**
- Rowlit's settings dialog: searchable sections, app themes (Light, Paper, Solarized Light, IntelliJ Light, Dark,
  Midnight, Nord, Violet, Darcula; one light and one dark favourite for System mode) and code themes (Rider, Darcula,
  Visual Studio, GitHub, Dracula, Monokai, One Dark, Solarized).
- Auto-update from GitHub Releases (electron-updater): background download, status bar chip, Restart now / Later,
  Settings › Updates, Help › Check for Updates.

**Project and tools**
- Open a folder, `.sln`, `.slnx` or `.csproj`; projects load through MSBuildWorkspace in the background.
  Files outside any project still get full IntelliSense (miscellaneous project on the framework reference pack).
- **New project** dialog: console, class library, Web API, MVC, Blazor, worker, gRPC, xUnit/NUnit/MSTest,
  WPF/WinForms (Windows), with or without a solution, or added to the open solution.
- **Build / Rebuild / Clean / Restore** (Ctrl+Shift+B), **Run** the selected run configuration (Shift+F10) with
  stdin input, ANSI colours and a "listening on" link for web apps, **Run tests**, **Stop**.
- **Run/Debug Configurations** (Alt+Shift+F10, or the top bar's picker › Edit Configurations): one per runnable
  project, plus your own with a launch profile from launchSettings.json (or none), program arguments, environment
  variables and a working directory; **compound** configurations start several projects at once.
- **Hot Reload** (a configuration's check box): the app runs under `dotnet watch` and saved edits are applied to it
  while it runs; an edit it cannot apply restarts the app.
- **Project Properties** (Explorer › right-click a project, or File › Project Properties): application, build,
  package and references pages that edit the .csproj in place (comments and layout kept); add or remove projects in
  the solution from the solution's menu.
- Clickable `file(line,col)` locations in output; build errors flow into the **Problems** window, together with
  live diagnostics and an on-demand **Analyze solution**.
- **Tool window stripe** on the left edge (Rider's new UI): the side panel windows at the top, the bottom panel ones
  at the bottom, each button toggling its window, with live state (a spinner while building or testing, the error
  count, the coverage). Only the everyday windows are on it at first (Explorer, Commit, Structure, Run, Debug, Build,
  Tests, Terminal, Problems, Git); ⋯ More tool windows (or View › Tool Windows) opens any other and chooses which
  ones stay on the stripe; right-click a button to remove it.
- **Explorer** with new class / interface / record / enum / file / folder, rename, delete (Recycle Bin on
  Windows), copy path, reveal, open in terminal, run/build/test project, set run configuration; **Show All Files**
  (the eye button) also lists bin, obj, .git, .vs and node_modules, dimmed.
- **Find in files** with regex, case, whole word, include globs and replace all.
- **NuGet** tool window (Alt+Shift+7, like Rider's): Browse / Installed / Updates across the solution, search on
  every enabled v3 feed (or one), prerelease toggle; package details (versions, description, license, project link,
  downloads, dependencies per framework, deprecation and vulnerability warnings); every project with its installed
  version and install / upgrade / remove buttons, "Install to all", "Update all"; central package management
  versions; a Sources tab (enable / disable feeds) and Restore.
- **Terminal** (Alt+F12): a real pseudo console (ConPTY on Windows, a pty on macOS / Linux) with xterm.js — type
  at the prompt, PowerShell / zsh / bash line editing, history, Ctrl+C, colours, several tabs.
- **Search Everywhere** (Shift Shift): files, `>` actions, `#` symbols, `:` line.
- Light / dark / system theme, settings (font, ligatures, tabs, wrap, minimap, auto save, format on save, …),
  keyboard shortcut sheet.

**Memory and performance**
- **Memory indicator** in the status bar (Kod's total, and the engine's share of its limit). Click it for the
  **Memory** window: where the memory goes (the Roslyn engine, the window, GPU and other processes), a live graph,
  the engine's documents, caches and garbage collections, **Free memory** and **Deep clean** (which also drops
  Roslyn's compilations; they are rebuilt as you work).
- The engine keeps itself small: it gives memory back to the system after you have been idle for a while or the
  window has been hidden for a minute, and above its limit (Settings › Memory, default a quarter of the RAM) it
  drops its caches and compilations, then warns you and suggests unloading projects.
- **Unload / Load Project** (Explorer, or the Memory window), like Rider: an unloaded project leaves the solution
  (no compilation, analysis or Find Usages inside it). Projects that use it compile against its last build, and
  the choice is remembered per folder.
- **Power Save Mode** (File menu): no inlay hints, Code Vision, inspections, inline blame, minimap or automatic
  completion popup.
- Completion sends only the best 400 matches for what you typed, out of the 10,000+ items Roslyn offers (all types
  in scope, plus those from namespaces that are not imported yet). The engine re-filters its own list as you type,
  so each further keystroke takes milliseconds, and the `using` for a type from another namespace is added when you
  pick the item.
- Old build and run outputs close themselves (Settings › Memory), and files opened only for a peek are released.

## Requirements

- .NET 10 SDK (`dotnet` on PATH): the engine targets net10.0 and Kod builds and runs projects with it.
- Node.js 22+ and npm, to build the UI and the shell.

## Run it

```powershell
pwsh scripts/dev.ps1            # build the engine, Vite with hot reload, Electron on top
pwsh scripts/dev.ps1 -Browser   # engine + Vite only; open the printed URL in a browser
```

Or step by step:

```powershell
dotnet build engine/Kod.slnx
cd ui; npm install; npm run build; cd ..
cd desktop; npm install; npm start
```

`desktop` starts the engine from `engine/src/Kod.Engine/bin/Debug/net10.0` (or `dotnet run` when it is not built).
`KOD_ENGINE_PATH` points it at another engine build; `KOD_DEV_URL` loads the UI from a dev server.

## Package

```powershell
pwsh scripts/build.ps1          # engine publish + UI build + electron-builder installer in desktop/dist
pwsh scripts/build.ps1 -Dir     # unpacked app folder
```

## CI and releases

- **CI** (`.github/workflows/ci.yml`): on every push to `main` and every pull request, on Windows and Linux: engine
  build, vulnerable-package check, an engine smoke test (publish, start, Roslyn completion), UI type-check and build,
  desktop type-check and bundle.
- **Release** (`.github/workflows/release.yml`): push a tag `vX.Y.Z` matching `desktop/package.json` (the three version
  files must agree) with `docs/release-notes/vX.Y.Z.md`. Windows (NSIS), macOS (DMG + ZIP, arm64) and Linux (AppImage)
  build on their own runners; the update metadata (`latest*.yml`) is checked against the assets and everything is
  published as the GitHub Release the in-app updater reads.

```bash
git tag v0.2.1 && git push origin v0.2.1
```

## Keyboard (Rider keymap)

| Action | Keys |
|---|---|
| Search everywhere | Shift Shift, Ctrl+T |
| Go to file / symbol / line | Ctrl+Shift+N (or Ctrl+P) / Ctrl+N / Ctrl+G |
| Find action | Ctrl+Shift+A, Ctrl+Shift+P |
| Context actions | Alt+Enter |
| Completion / parameter info / quick doc | Ctrl+Space / Ctrl+Shift+Space / Ctrl+Q |
| Declaration / implementation / usages | F12, Ctrl+B / Ctrl+Alt+B / Alt+F7, Ctrl+Alt+F7, Shift+F12 |
| Rename / reformat / code cleanup | F2, Shift+F6 / Ctrl+Alt+L / Ctrl+Alt+Shift+L |
| Refactor This / change signature / safe delete | Ctrl+Shift+R / Ctrl+F6 / Alt+Delete |
| Surround with / replace in file | Ctrl+Alt+T / Ctrl+R |
| Navigate To / type declaration / base / derived / related | Ctrl+Shift+G / Ctrl+Shift+F11 / Alt+Home / Alt+End / Ctrl+Alt+Home |
| Call hierarchy / type hierarchy | Ctrl+Alt+H / Ctrl+H |
| Recent files / recent locations / back / forward | Ctrl+E / Ctrl+Shift+E / Ctrl+Alt+Left / Ctrl+Alt+Right |
| Next / previous member | Alt+Down / Alt+Up |
| Build / run / debug / stop | Ctrl+Shift+B / Shift+F10, Ctrl+F5 / F5 / Shift+F5 |
| Edit configurations / attach to process | Alt+Shift+F10 / Ctrl+Alt+F5 |
| Breakpoint / step over / into / out | F9, Ctrl+F8 / F10, F8 / F11, F7 / Shift+F11 |
| Breakpoint properties / run to cursor | Ctrl+Shift+F8 / Alt+F9 |
| Generate / inline | Alt+Insert / Ctrl+Alt+N |
| Explorer / tool windows / terminal | Alt+1 / Ctrl+J / Alt+F12 |
| Save / save all / close tab | Ctrl+S / Ctrl+Shift+S / Ctrl+F4 |
| Settings | Ctrl+Alt+S |
| Bookmark / numbered bookmark / go to bookmark / bookmarks | F11 / Ctrl+Shift+1…9 / Ctrl+1…9 / Shift+F11 |
| TODO / Database / Services | Alt+Shift+6 / Alt+Shift+D / Alt+Shift+8 |
| Run query in a SQL console (statement / all) | Ctrl+Enter / Ctrl+Shift+Enter |

On macOS, Ctrl is ⌘.

## Not (yet) in Kod

A full profiler (CPU sampling, memory snapshots), debugging a single test, and Razor / XAML intelligence.
