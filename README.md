# Kod

A focused C# / .NET IDE in the spirit of Rider: write code with Roslyn IntelliSense, fix it with Alt+Enter, build, run
and test with the dotnet CLI, manage NuGet packages, and use a terminal, in one keyboard-first window.

Kod follows the architecture and UI structure of Rowlit: an **Electron** shell, a **React + Monaco** UI, and a
**.NET 10 engine** that runs as a local sidecar. The UI talks to the engine over token-authenticated HTTP and a
WebSocket event stream; the engine owns everything that touches code, files and processes.

```
desktop/   Electron shell: window (Windows caption overlay, macOS inset), kod://app protocol, engine lifecycle
ui/        React + Monaco UI: top bar, tabbed dock, editor tabs, tool windows, status bar, palette, dialogs
engine/    Kod.Engine (ASP.NET Core minimal API on 127.0.0.1)
  Workspace/  MSBuildWorkspace solution / project loading, live editor text overlays, file watching, files, search
  Intel/      Roslyn: completion, hover, signature help, diagnostics, navigation, usages, rename, format,
              semantic tokens, outline, code fixes and refactorings, metadata views
  Processes/  dotnet build / run / test / new / add package and the terminal shell, streamed over /ws
  Nuget/      nuget.org search, PackageReference listing
```

## Features

**Editor**
- Monaco editor with tabs (preview tabs, drag to reorder, dirty markers, session restore per folder), breadcrumbs,
  sticky scroll, minimap, bracket colours, Rider colour scheme driven by **Roslyn semantic classification**.
- **IntelliSense** from Roslyn's `CompletionService`: members, types, keywords, overrides, with documentation;
  C# live templates (`prop`, `ctor`, `cw`, `foreach`, `fact`, …).
- **Hover** quick info, **parameter info** (overloads, active parameter, XML docs), **live diagnostics**
  (errors, warnings, unnecessary usings faded).
- **Alt+Enter**: Roslyn's own code fixes (add `using`, generate method/type, implement interface, …) and
  refactorings (convert, introduce, extract, …).
- **Navigation**: go to declaration (F12 / Ctrl+B / Ctrl+click), go to implementation, find usages (Alt+F7 tool
  window, Shift+F12 peek), file structure, metadata view for framework types (generated declarations with docs).
- **Rename** across the solution (F2 / Shift+F6), **reformat** (Ctrl+Alt+L), comment, move/duplicate lines.

**Debugger**
- Breakpoints in the gutter (F9 / Ctrl+F8; conditions supported by the engine), F5 to debug or resume, F10 / F11 /
  Shift+F11 to step, Shift+F5 to stop, the execution line while paused.
- Debug tool window: call stack, variables tree, breakpoints, debug console with expression evaluation; hover a
  variable while paused to see its value.
- Uses [netcoredbg](https://github.com/Samsung/netcoredbg) (MIT) over the Debug Adapter Protocol; Kod downloads it
  on first use (or set `KOD_NETCOREDBG`). ASP.NET Core apps get their launch profile URL and environment.

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
- Clickable `file(line,col)` locations in output; build errors flow into the **Problems** window, together with
  live diagnostics and an on-demand **Analyze solution**.
- **Explorer** with new class / interface / record / enum / file / folder, rename, delete (Recycle Bin on
  Windows), copy path, reveal, open in terminal, run/build/test project, set run configuration.
- **Find in files** with regex, case, whole word, include globs and replace all.
- **NuGet** panel: search nuget.org, install a version, update, remove (via `dotnet add/remove package`).
- **Terminal** (cmd / zsh / bash) in the tool window.
- **Search Everywhere** (Shift Shift): files, `>` actions, `#` symbols, `:` line.
- Light / dark / system theme, settings (font, ligatures, tabs, wrap, minimap, auto save, format on save, …),
  keyboard shortcut sheet.

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

## Keyboard (Rider keymap)

| Action | Keys |
|---|---|
| Search everywhere | Shift Shift, Ctrl+T |
| Go to file / symbol / line | Ctrl+Shift+N (or Ctrl+P) / Ctrl+N / Ctrl+G |
| Find action | Ctrl+Shift+A, Ctrl+Shift+P |
| Context actions | Alt+Enter |
| Completion / parameter info / quick doc | Ctrl+Space / Ctrl+Shift+Space / Ctrl+Q |
| Declaration / implementation / usages | F12, Ctrl+B / Ctrl+Alt+B / Alt+F7, Shift+F12 |
| Rename / reformat | F2, Shift+F6 / Ctrl+Alt+L |
| Build / run / debug / stop | Ctrl+Shift+B / Shift+F10, Ctrl+F5 / F5 / Shift+F5 |
| Breakpoint / step over / into / out | F9, Ctrl+F8 / F10, F8 / F11, F7 / Shift+F11 |
| Explorer / tool windows / terminal | Alt+1 / Ctrl+J / Alt+F12 |
| Save / save all / close tab | Ctrl+S / Ctrl+Shift+S / Ctrl+F4 |
| Settings | Ctrl+Alt+S |

On macOS, Ctrl is ⌘.

## Not (yet) in Kod

A test explorer tree, Git UI beyond the branch name, and profilers.
