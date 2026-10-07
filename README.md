<div align="center">

# <img src="icon.svg" width="36" height="36" /> DSH Web Git Sidebar

### Git, where your eyes already are.

**A VS Code-style Source Control panel for DeepSeek Harness, living in the left rail.**
Branches, graph, previews, and push-state — one click from the left rail. No telemetry. No cloud. Just git.

[![License: MIT](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-%3E%3D0.2.0--rc.2-4c6ef5?style=flat-square)](https://github.com/RaditPasya/dsh-web-git-sidebar)
[![Platform](https://img.shields.io/badge/platform-web-333?style=flat-square)](https://github.com/RaditPasya/dsh-web-git-sidebar)

[Features](#what-you-get) · [Tour](#tour) · [Install](#install) · [Dev](#dev-loop)

</div>

---

![Full Git panel with branches and commit graph](docs/panel.png)

## What you get

| | |
|---|---|
| **Branch switcher** | Search, switch, create. `↑N ↓M` ahead/behind, `✓` in sync, `●` local-only. |
| **Commit graph** | Topo-order lanes in living color. Click any row to expand it. |
| **Commit preview** | Files (`A/M/D`), `+ins −del`, message body, author, timestamp. Hover any row for the gist. |
| **Who's who** | Every author gets their own dot color — scan a hundred commits at a glance. |
| **Footer dock** | An always-on branch dropdown + recent commits docked above Settings. *Follows your open session*, hides on non-git workspaces. Click the header to collapse, drag (or focus and use arrow keys on) the top edge to resize — it remembers. |
| **Pull / fetch** | One button. It fetches when you are in sync and fast-forwards when you are behind, and tells you what happened. |
| ⚡ **Fast** | Status + branches + graph in **one** batched host call, cached, skeleton placeholders — no empty flashes. |

Every host git command runs under a deadline, so a stalled repository degrades into
an error instead of wedging the panel.

## Tour

<table>
  <tr>
    <td><img src="docs/tour1.gif" alt="Quick tour part 1" width="100%" /></td>
    <td><img src="docs/tour2.gif" alt="Quick tour part 2" width="100%" /></td>
  </tr>
</table>

![Footer dock in the sidebar](docs/popup.png)

## Install

```sh
dsh plugin --profile web add dsh-web-git-sidebar
```

Restart the web UI once (new host routes), refresh — the **Git icon** appears in the left rail.

> Local hacking? Clone and link it instead:
> ```sh
> git clone https://github.com/RaditPasya/dsh-web-git-sidebar.git
> dsh plugin --profile web add link:$(pwd)/dsh-web-git-sidebar
> ```

## Dev loop

```sh
pnpm install
node scripts/build.mjs            # lib/index.js (host) + lib/client.js (browser)
MINIFY=0 node scripts/build.mjs   # dev variant: readable output, intact stack traces
```

Builds are minified by default (the client bundle is ~45% smaller raw, ~22% smaller
gzipped). Use `MINIFY=0` when you want to read the emitted JS or get usable host
stack traces.

`link:` installs pick up rebuilds live — just refresh the page. Host-side changes
(anything under `src/host/` or `src/index.ts`) need a DSH restart, because the host
bundle is loaded once at startup.

Three gates, all run in CI on every push and again before publishing:

```sh
pnpm run typecheck   # tsc --noEmit, strict, with noUnusedLocals
pnpm test            # builds lib/, then runs every suite under test/
```

`pnpm test` bundles each `test/*.test.ts` with esbuild into a temp directory and
hands it to `node --test` — the sources use TypeScript parameter properties, which
Node's native type stripping rejects. The suites cover the git command deadline,
flight eviction, the poll backoff policy and the mutation guards, plus smoke tests
that load the **built** bundles, so a minification or bundling regression fails
`pnpm test` rather than the browser.

```
src/
├── core/        git vocabulary: commands, parsers, wire types
├── host/        workspace-gated service + /git-sidebar/* routes + SSE
└── client/
    ├── api.ts       typed fetch client
    └── sidebar/     icon · panel · footer dock · shared kit

test/            bundled by scripts/test.mjs and run with node --test
scripts/         build.mjs (esbuild) · test.mjs (bundle + run suites)
```

## License

MIT — the industry-standard permissive license. You are free to use this
software commercially, modify it, distribute it, sublicense it, and sell
copies of it. The only requirements: keep the copyright notice and this
permission notice in all copies. The software is provided "as is", without
warranty of any kind, and the authors are not liable for any claims or
damages. See [LICENSE](LICENSE) for the full text.
