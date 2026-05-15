/**
 * Conservative transforms applied to a shell command before execution.
 *
 * Two fixups are applied, each anchored to the end of a top-level segment
 * (segments split on `;`, `&&`, `||`, and background `&`):
 *
 *  1. Trailing `| head [args]` / `| tail [args]` (and the `|&` variant) — these
 *     pipes exist purely to limit output length. The harness already truncates
 *     shell output and exposes the full result via an artifact, so they only
 *     hide content the agent wanted.
 *
 *  2. A redundant trailing `2>&1` left on a segment that has no remaining pipe
 *     or other redirect. The harness already merges stderr into stdout, so the
 *     duplication is purely cosmetic — and often a leftover after fixup (1)
 *     drops a downstream pipe.
 *
 * The heavy lifting (tokenization, quoting, heredoc handling, command
 * substitution, nested compound commands) lives in Rust under
 * `pi_shell::fixup`, driven by the real `brush-parser` AST. This module is a
 * thin sync wrapper plus user-facing notice formatting.
 */
import * as nativeBindings from "@oh-my-pi/pi-natives";

export interface BashFixupResult {
	/** Possibly-rewritten command. */
	command: string;
	/** Substrings that were stripped, in the order they were removed. */
	stripped: string[];
}

const nativeApplyBashFixups = (nativeBindings as { applyBashFixups?: (command: string) => BashFixupResult })
	.applyBashFixups;

/**
 * Apply both fixups to a shell command. On any parse failure, multi-line input,
 * missing native support, or no-op transform, returns the input verbatim with `stripped: []`.
 */
export function applyBashFixups(command: string): BashFixupResult {
	return typeof nativeApplyBashFixups === "function" ? nativeApplyBashFixups(command) : { command, stripped: [] };
}

/**
 * Human-readable notice for the fixups that fired. Mirrors the shape of
 * `formatTimeoutClampNotice` so it can ride alongside the other bash notices.
 */
export function formatBashFixupNotice(stripped: readonly string[]): string | undefined {
	if (!stripped.length) return undefined;
	const quoted = stripped.map(s => `\`${s}\``).join(", ");
	return `<system-warning>Stripped redundant ${quoted} — shell output is already truncated and stderr is already merged into stdout. NEVER use these patterns.</system-warning>`;
}
