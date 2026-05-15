Executes a PowerShell command in the configured FrostShell session for terminal operations like git, bun, cargo, python.

<instruction>
- Write PowerShell directly in `command`; NEVER wrap it in `pwsh -Command`, `pwsh -c`, `powershell -Command`, or `powershell -c`.
- Use `cwd` to set working directory, not `Set-Location …; …` or `cd …; …`.
- Prefer `env: { NAME: "…" }` for multiline, quote-heavy, or untrusted values; reference as `$env:NAME`.
- Quote variable expansions only when PowerShell semantics require it, e.g. `"$env:NAME"` inside expandable strings.
- PTY mode is opt-in: set `pty: true` only when the command needs a real terminal; default is `false`.
- Use `;` only when later commands should run regardless of earlier failures.
- Internal URIs (`skill://`, `agent://`, etc.) are auto-resolved to filesystem paths.
{{#if asyncEnabled}}
- Use `async: true` for long-running commands when you don't need immediate output; the call returns a background job ID and the result is delivered automatically as a follow-up.
{{/if}}
</instruction>

<critical>
- NEVER use Linux coreutils (`cat`, `head`, `tail`, `less`, `more`, `ls`, `grep`, `rg`, `awk`, `sed`, `find`, `fd`, etc.) when a dedicated tool suffices — ALWAYS prefer `read`, `search`, `find`, `edit`, `write`.
- NEVER pipe through `| Select-Object -First N`, `| Select-Object -Last N`, `| head -n N`, or `| tail -n N` — output is already truncated with the full result available via `artifact://<id>`.
- NEVER redirect with `2>&1` or `2>$null` — stdout and stderr are already merged.
</critical>

<output>
- Returns output and exit code.
- Truncated output is retrievable from `artifact://<id>` (linked in metadata)
- Exit codes shown on non-zero exit
</output>
