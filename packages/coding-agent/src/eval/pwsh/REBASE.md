# Pwsh Eval Backend — Rebase / Upstream Integration Guide

Purpose: we carry a local PowerShell (`language: "pwsh"`) eval backend that does
not exist upstream. This page is the checklist for re-integrating it after
rebasing onto `upstream/main`, and the rationale for each touchpoint so you can
re-apply decisions (not just lines) when upstream has drifted.

Everything below was written against the tree as of 2026-10-02. File paths are
relative to the repo root.

---

## 1. The self-contained module (port first, unchanged if possible)

| File | Contents |
| --- | --- |
| `packages/coding-agent/src/eval/pwsh/executor.ts` | Persistent-session executor + process protocol. No imports from py/js backends. |
| `packages/coding-agent/src/eval/pwsh/index.ts` | `ExecutorBackend` (`id: "pwsh"`) mirroring `eval/js/index.ts`. |

These two files are deliberately dependency-light (only `pi-utils`, `pi-tui`
OutputSink, `tools/output-meta`, `eval/backend`, `eval/backend-helpers`,
`eval/session-id`). Port them verbatim first, then fix whatever import paths
drifted. If upstream changes `ExecutorBackend`/`ExecutorBackendResult`, adapt
`index.ts` only — keep `executor.ts`'s `PwshResult` shape internal.

Wire into the barrel: `packages/coding-agent/src/eval/index.ts`
(`export { default as pwshBackend } from "./pwsh";`).

## 2. Protocol contract (what must survive any refactor)

- One `pwsh -NoProfile -NonInteractive -Command -` process per namespaced eval
  session id (`pwsh:<sessionId>`), serialized through a per-session promise
  chain. **At most one process per omp session** is the product requirement.
- Each cell = ONE ASCII statement line that dot-sources a base64 UTF-8
  scriptblock. Dot-sourcing at the stdin REPL's global scope is what makes
  variables/functions/imports persist across cells. Do not switch to
  `Invoke-Expression` or a wrapper function — that would scope user state away.
- Completion marker: `__OMP_PWSH_DONE__<snowflake runId>|<0|1>` on stdout.
  Host reads stdout lines until the marker; stderr streams into the same sink.
- Gotchas baked into the code (do not remove):
  - `env.TERM = "dumb"` + ANSI-escape stripping in the line pump — the pwsh
    console host emits VT mode toggles (`\x1b[?1h/l`) around statements even
    with `-NonInteractive`; without this the marker match silently fails.
  - Manual reader/decoder/split line pump — Bun's `node:readline` does not
    accept Web `ReadableStream`s (proc.stdout).
  - One persistent stream-reader pair per process for its lifetime; per-cell
    `getReader()` calls would deadlock on the stream lock.
  - Cancellation/timeout kills the process (pwsh pipelines cannot be
    interrupted from the host); the session is dropped and lazily restarted.
  - `exit N` in user code → marker never arrives → detect via process exit,
    report exit code, drop the session.

## 3. Touchpoints outside the module (re-apply per anchor)

Each row = a place upstream may have drifted. Re-grep the anchor; if the
surrounding code changed, re-apply the *decision*, not the diff.

| # | File | Anchor / what to do |
| --- | --- | --- |
| 1 | `packages/tui/src/tools/eval.ts` | `EvalLanguage` union: add `"pwsh"`. `languageForHighlighter` → `"powershell"` (check the `codeNode({ lang })` consumer still accepts arbitrary strings). `normalizeRenderLanguage`: `if (value === "pwsh") return "pwsh"`. |
| 2 | `packages/tui/src/tools/eval-format/index.ts` | Exhaustive switch on `EvalLanguage`: add `case "pwsh": return source;` (no formatter). |
| 3 | `packages/coding-agent/src/eval/settings.ts` | `cfgEvalPwsh` register block: id `eval.pwsh`, env `PI_PWSH`, default true, ui group "Eval & Runtimes". |
| 4 | `packages/coding-agent/src/tools/eval-backends.ts` | `EvalBackendsAllowance.pwsh` + `resolveEvalBackends` reads `cfgEvalPwsh`. |
| 5 | `packages/coding-agent/src/tools/eval.ts` | `EvalLanguageToken` += `"pwsh"`; `EVAL_LANGUAGE_ORDER`, `EVAL_LANGUAGE_RUNTIME` (`'"pwsh": PowerShell 7'`), `EVAL_LANGUAGE_NAME`; `evalSchema` language union `'py' \| 'js' \| 'pwsh'`; `enabledEvalLanguages` allowed record; `resolveBackend` `language === "pwsh"` branch (availability = `$which("pwsh")`, error message points at installing pwsh); `formatEvalInputLanguage` pwsh→"powershell"; `cellLanguage` mapping (`params.language` "py"→"python", "js"→"js", else "pwsh"); `EvalToolDescriptionOptions.pwsh` + `evalTemplateContext` `pwsh:` field; `#descriptionOptions` sets `pwsh: backends.pwsh`; sessionless fallback language list includes `"pwsh"`. |
| 6 | `packages/coding-agent/src/eval/input.ts` | `EvalSourceInput.language` union += `"pwsh"`. Passthrough condition: pwsh intercepts only `%load` (i.e. it follows the non-js branch: `%bun`/`%pip`/`%environment` pass through as plain code). |
| 7 | `packages/coding-agent/src/prompts/tools/eval.md` | `{{#if pwsh}}` one-liner: persistent pwsh process, state persists, pipeline output prints, `Write-Output` for explicit results. |
| 8 | `packages/coding-agent/src/tools/bash.ts` | `hasEval` gate: `\|\| evalBackends.pwsh`. |
| 9 | `packages/coding-agent/src/task/executor.ts` | `exec` tool expansion: `\|\| backends.pwsh` before pushing `"eval"`. |
| 10 | `packages/coding-agent/src/tools/index.ts` | `allowEval`: `\|\| backends.pwsh` (pwsh availability is checked per-invocation; no preflight needed). |
| 11 | `packages/coding-agent/src/session/eval-runner.ts` | `disposeKernels()`: add `disposePwshSessionsByOwner(this.#kernelOwnerId)` (import from `../eval/pwsh/executor`). |
| 12 | `packages/coding-agent/src/sdk.ts` | postmortem: `postmortem.register("pwsh-cleanup", disposeAllPwshSessions)` next to `python-cleanup`; and `disposePwshSessionsByOwner(evalKernelOwnerId)` next to the py dispose in `createAgentSession` cleanup. |
| 13 | `packages/coding-agent/test/tools/eval-fallback.test.ts` | Any fixture asserting the full `resolveEvalBackends()` shape needs `pwsh: <bool>`. |
| 14 | Changelogs | `packages/coding-agent/CHANGELOG.md` (Added: pwsh backend line) and `packages/tui/CHANGELOG.md` (Added: `pwsh` eval language union). Only if still unreleased at rebase time. |

## 4. Things intentionally NOT wired (decisions, keep them)

- **Speculation / shadow cells**: pwsh does not participate; the py/js-only
  check in `EvalTool.execute` naturally discards shadow cells for pwsh
  (`tokenIsPython === (cellLanguage === "python")` fails). No change needed.
- **Preludes** (`eval/preludes.ts`): definitions carry `.python`/`.js` sources;
  pwsh has no prelude helpers (`display`/`read`/`write`/`tool.*` bridge). The
  `{{#if pwsh}}` prompt line documents `Write-Output` instead. If upstream adds
  a language-generic prelude mechanism, revisit.
- **Packages/environment** (`%bun add`, managed envs): pwsh ignores
  `packages`/`environment`; no `pwshBackend` plumbing for them.
- **Eval state registry** (`eval/state.ts`, `EvalStateLanguage`): py/js
  register retained-runtime state for compaction notices; pwsh does not (a dead
  pwsh session is already self-reporting via the exit notice). If upstream makes
  that registry language-generic, add `"pwsh"`.
- **Worker dispatch / `cli.ts` selectors**: not needed — pwsh is host-side
  subprocess management, not a worker module.

## 5. Verification checklist after rebase

1. `bun run --filter './packages/*' --sequential --if-present check:types` — clean.
2. `bunx oxlint` + `bunx oxfmt --check` on all touched files.
3. `bun test packages/coding-agent/test/eval/pwsh-executor.test.ts`
   (`test/eval/pwsh-executor.test.ts` from the package dir). All five contract
   tests exercise real pwsh and skip cleanly where pwsh is absent:
   persistence across cells, output/error/exit-code mapping, `reset` drops
   state, `exit N` reported + next cell restarts fresh.
4. Live smoke in a session: `eval language:"pwsh"` with `$x = 1`, then
   `Write-Output ($x + 1)` → `2`; then `throw 'boom'` → exitCode 1 + stderr in
   output; then `exit 3` → "session exited with code 3" notice and next cell works.
5. TUI: a pwsh cell renders with PowerShell highlighting (transcript + rebuild).

Known local-env trap: a stale `packages/natives/native/*.node` (older than the
JS) makes **every** coding-agent test import fail with
`WeakMap keys must be objects` at `adaptDesktopSession` — that failure is
environmental, not caused by this feature; rebuild natives or ignore.
