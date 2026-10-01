/**
 * Persistent PowerShell (pwsh) eval session executor.
 *
 * One `pwsh -NoProfile -NonInteractive -Command -` subprocess per eval
 * session id. Each cell is delivered as a single ASCII statement line:
 *
 *   . ([scriptblock]::Create([System.Text.Encoding]::UTF8.GetString(
 *       [Convert]::FromBase64String('<base64>'))))
 *
 * The REPL executing piped stdin runs each statement in the global scope, so
 * dot-sourcing the decoded scriptblock makes user variables, functions, and
 * module imports persist across cells in the same pwsh process. The decoded
 * script wraps the user code in try/catch and finishes by writing a unique
 * completion marker (`__OMP_PWSH_DONE__<runId>|<ok>`) to stdout; the host reads
 * stdout lines until that marker, treating everything before it as cell output.
 * stderr is streamed into the same output sink as it arrives.
 *
 * Cancellation kills the process (pwsh cannot safely interrupt a running
 * pipeline from the host side); the session is dropped and lazily restarted on
 * the next cell. `exit` inside user code terminates the process and is
 * reported the same way.
 */
import { $which, getProjectDir, logger, Snowflake } from "@oh-my-pi/pi-utils";
import type { OutputArtifactError } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { DEFAULT_MAX_BYTES, OutputSink } from "@oh-my-pi/pi-tui/tools/streaming-output";
import type { ToolSession } from "../../tools";
import {
	resolveOutputMaxColumns,
	resolveOutputSinkArtifactMaxBytes,
	resolveOutputSinkHeadBytes,
} from "../../tools/output-meta";

export interface PwshExecutorOptions {
	/** Working directory for the pwsh process and each cell. */
	cwd?: string;
	/** Timeout in milliseconds. */
	timeoutMs?: number;
	/** Absolute wall-clock deadline in milliseconds since epoch. */
	deadlineMs?: number;
	/** Runtime-work budget (ms); used only for timeout-annotation text. */
	idleTimeoutMs?: number;
	/** Callback for streaming output chunks (already sanitized). */
	onChunk?: (chunk: string) => Promise<void> | void;
	/** AbortSignal for cancellation. */
	signal?: AbortSignal;
	/** Session identifier for pwsh-process reuse. */
	sessionId?: string;
	/** Logical owner identifier for retained session cleanup. */
	kernelOwnerId?: string;
	/** Restart the pwsh session before executing. */
	reset?: boolean;
	/** Artifact path/id for full output storage. */
	artifactPath?: string;
	artifactId?: string;
	session: ToolSession;
}

export interface PwshResult {
	/** Combined stdout + stderr output (sanitized, possibly truncated) */
	output: string;
	/** Execution exit code (0 ok, 1 error, undefined if cancelled) */
	exitCode: number | undefined;
	/** Whether the execution was cancelled via signal */
	cancelled: boolean;
	/** Whether the output was truncated */
	truncated: boolean;
	/** Artifact ID if full output was saved to artifact storage */
	artifactId?: string;
	/** Bytes the artifact cap dropped from the saved file's middle. */
	artifactElidedBytes?: number;
	artifactError?: OutputArtifactError;
	/** Total number of lines in the output stream */
	totalLines: number;
	/** Total number of bytes in the output stream */
	totalBytes: number;
	/** Number of lines included in the output text */
	outputLines: number;
	/** Number of bytes included in the output text */
	outputBytes: number;
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

let pwshAvailabilityCache: string | null | undefined;

/** Resolve the pwsh executable; `null` when not installed. Cached per process. */
export function resolvePwshExecutable(): string | null {
	if (pwshAvailabilityCache !== undefined) return pwshAvailabilityCache;
	pwshAvailabilityCache = $which("pwsh");
	return pwshAvailabilityCache;
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

class PwshExecutionCancelledError extends Error {
	readonly timedOut: boolean;

	constructor(timedOut: boolean) {
		super(timedOut ? "Command timed out" : "Command aborted");
		this.name = "PwshExecutionCancelledError";
		this.timedOut = timedOut;
	}
}

function isTimeoutReason(reason: unknown): boolean {
	return reason instanceof Error && reason.name === "TimeoutError";
}

/** Signals the pwsh process exited mid-cell with `code`. */
class PwshProcessExitedError extends Error {
	readonly exitCode: number;

	constructor(exitCode: number) {
		super(`pwsh session exited with code ${exitCode}`);
		this.name = "PwshProcessExitedError";
		this.exitCode = exitCode;
	}
}

// ---------------------------------------------------------------------------
// Session management
//
// At most one pwsh process per (namespaced) eval session id. Executions are
// serialized through a per-session promise chain because a single REPL
// process cannot run two cells concurrently. Each process owns one pair of
// persistent stream readers for its whole lifetime; cells swap line handlers
// instead of acquiring new stream locks.
// ---------------------------------------------------------------------------

type PwshProcess = Bun.Subprocess<"pipe", "pipe", "pipe">;

interface PwshSession {
	sessionId: string;
	ownerId: string | undefined;
	generation: number;
	proc: PwshProcess;
	/** Resolves with the process exit code once the process is gone. */
	exited: Promise<number>;
	/** Current cell's stdout line handler; absent while the session is idle. */
	onStdoutLine: ((line: string) => void) | undefined;
	/** Resolves when the stdout stream closes (process death). */
	stdoutClosed: Promise<void>;
	/** Current cell's stderr line handler; absent while the session is idle. */
	onStderrLine: ((line: string) => void) | undefined;
	/** Serializes cell execution: each cell waits for the previous one. */
	queue: Promise<unknown>;
}

const sessions = new Map<string, PwshSession>();

/** Console-host control sequences (VT mode toggles, OSC, CSI) that leak into the pipe. */
const ANSI_ESCAPE_PATTERN = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

/**
 * Reads a Web ReadableStream line-by-line for the process lifetime. Bun's
 * `node:readline` does not accept web streams, so this is a manual
 * decoder+split loop. Console-host control sequences are stripped before
 * line dispatch (the host emits VT mode toggles around statements even in
 * non-interactive mode on some terminals). Errors are swallowed: a killed
 * process tears the stream down mid-read and the caller observes the exit.
 */
function pumpLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void, onDone: () => void): void {
	void (async () => {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		const emit = (pending: string): void => {
			const line = pending.replaceAll("\r", "").replace(ANSI_ESCAPE_PATTERN, "");
			if (line.length > 0) onLine(line);
		};
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				for (;;) {
					const newline = buffer.indexOf("\n");
					if (newline < 0) break;
					emit(buffer.slice(0, newline));
					buffer = buffer.slice(newline + 1);
				}
			}
			emit(buffer + decoder.decode());
		} catch {
			// stream torn down during kill
		} finally {
			onDone();
		}
	})();
}

function killSession(session: PwshSession): void {
	session.generation += 1;
	session.onStdoutLine = undefined;
	session.onStderrLine = undefined;
	session.proc.kill();
}

function startSession(session: PwshSession, cwd: string): void {
	const executable = resolvePwshExecutable();
	if (!executable) throw new Error("pwsh executable not found on PATH");
	const proc: PwshProcess = Bun.spawn([executable, "-NoProfile", "-NonInteractive", "-Command", "-"], {
		cwd,
		env: { ...process.env, TERM: "dumb" },
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	session.proc = proc;
	session.exited = proc.exited;
	const stdoutDone = Promise.withResolvers<void>();
	session.stdoutClosed = stdoutDone.promise;
	pumpLines(proc.stdout as ReadableStream<Uint8Array>, line => session.onStdoutLine?.(line), stdoutDone.resolve);
	pumpLines(
		proc.stderr as ReadableStream<Uint8Array>,
		line => session.onStderrLine?.(line),
		() => undefined,
	);
	// Force UTF-8 output so non-ASCII cell output survives the pipe. Base64
	// command payloads are pure ASCII, so stdin decoding is safe regardless.
	proc.stdin!.write("try{[Console]::OutputEncoding=[System.Text.Encoding]::UTF8}catch{}\n");
}

function acquireSession(sessionId: string, ownerId: string | undefined, cwd: string): PwshSession {
	let session = sessions.get(sessionId);
	if (!session) {
		const draft = {
			sessionId,
			ownerId,
			generation: 0,
			proc: undefined as unknown as PwshProcess,
			exited: undefined as unknown as Promise<number>,
			onStdoutLine: undefined as ((line: string) => void) | undefined,
			stdoutClosed: undefined as unknown as Promise<void>,
			onStderrLine: undefined as ((line: string) => void) | undefined,
			queue: Promise.resolve(),
		} satisfies PwshSession;
		sessions.set(sessionId, draft);
		session = draft;
		startSession(session, cwd);
	}
	if (ownerId !== undefined) session.ownerId = ownerId;
	return session;
}

function disposeSession(session: PwshSession): void {
	if (sessions.get(session.sessionId) === session) sessions.delete(session.sessionId);
	killSession(session);
}

/** Shut down every retained pwsh session. */
export async function disposeAllPwshSessions(): Promise<void> {
	const all = [...sessions.values()];
	sessions.clear();
	for (const session of all) killSession(session);
}

/** Shut down retained pwsh sessions owned by `ownerId`. */
export async function disposePwshSessionsByOwner(ownerId: string): Promise<void> {
	const owned = [...sessions.values()].filter(session => session.ownerId === ownerId);
	for (const session of owned) disposeSession(session);
}

// ---------------------------------------------------------------------------
// Cell protocol
// ---------------------------------------------------------------------------

const DONE_MARKER_PREFIX = "__OMP_PWSH_DONE__";

function escapeSingleQuoted(value: string): string {
	return value.replaceAll("'", "''");
}

function buildCellScript(code: string, cwd: string, runId: string): string {
	return [
		`Set-Location -LiteralPath '${escapeSingleQuoted(cwd)}'`,
		"$__omp_ok = $true",
		"try {",
		code,
		"} catch {",
		"    $__omp_ok = $false",
		"    [Console]::Error.WriteLine(($_ | Out-String))",
		"}",
		`[Console]::Out.WriteLine('${DONE_MARKER_PREFIX}${runId}|' + [int](-not $__omp_ok))`,
	].join("\n");
}

interface CellOutcome {
	ok: boolean;
	/** Process exit code when the session died instead of completing. */
	processExitCode?: number;
}

async function runCell(
	session: PwshSession,
	generation: number,
	code: string,
	cwd: string,
	signal: AbortSignal | undefined,
	push: (chunk: string) => void,
): Promise<CellOutcome> {
	const runId = Snowflake.next();
	const payload = Buffer.from(buildCellScript(code, cwd, runId), "utf8").toString("base64");
	const statement = `. ([scriptblock]::Create([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))))`;

	const completion = Promise.withResolvers<CellOutcome>();
	session.onStdoutLine = line => {
		if (line.startsWith(`${DONE_MARKER_PREFIX}${runId}|`)) {
			completion.resolve({ ok: line.endsWith("|0") });
			return;
		}
		push(`${line}\n`);
	};
	session.onStderrLine = line => push(`${line}\n`);

	let onAbort: (() => void) | undefined;
	const abortSignal: Promise<never> = new Promise((_, reject) => {
		if (!signal) return;
		if (signal.aborted) {
			reject(new PwshExecutionCancelledError(isTimeoutReason(signal.reason)));
			return;
		}
		onAbort = () => reject(new PwshExecutionCancelledError(isTimeoutReason(signal.reason)));
		signal.addEventListener("abort", onAbort, { once: true });
	});

	const died = session.exited.then(exitCode => {
		throw new PwshProcessExitedError(exitCode);
	});

	session.proc.stdin!.write(`${statement}\n`);

	try {
		return await Promise.race([completion.promise, abortSignal, died]);
	} catch (error) {
		if (error instanceof PwshProcessExitedError) {
			// Process exited mid-cell: wait for the pipe to drain so partial
			// cell output is not lost, then report the death.
			await Promise.race([session.stdoutClosed, Bun.sleep(250)]);
			return { ok: false, processExitCode: error.exitCode };
		}
		throw error;
	} finally {
		if (signal && onAbort) signal.removeEventListener("abort", onAbort);
		session.onStdoutLine = undefined;
		session.onStderrLine = undefined;
		died.catch(() => undefined);
	}
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

function formatTimeoutAnnotation(timeoutMs: number | undefined): string {
	if (timeoutMs === undefined) return "Command timed out; the pwsh session was terminated.";
	const seconds = Math.round(timeoutMs / 1000);
	return `Command timed out after ${seconds}s; the pwsh session was terminated. State is unavailable until the next eval restarts it.`;
}

export async function executePwsh(code: string, options: PwshExecutorOptions): Promise<PwshResult> {
	const cwd = options.cwd ?? options.session.cwd ?? getProjectDir();
	const outputSink = new OutputSink({
		artifactPath: options.artifactPath,
		artifactId: options.artifactId,
		spillThreshold: DEFAULT_MAX_BYTES,
		headBytes: resolveOutputSinkHeadBytes(options.session.settings),
		artifactMaxBytes: resolveOutputSinkArtifactMaxBytes(options.session.settings),
		maxColumns: resolveOutputMaxColumns(options.session.settings),
		onChunk: chunk => options.onChunk?.(chunk),
	});

	const timeoutMs =
		options.deadlineMs !== undefined
			? Math.max(0, options.deadlineMs - Date.now())
			: (options.timeoutMs ?? options.idleTimeoutMs);
	const timeoutSignal =
		typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
			? AbortSignal.timeout(timeoutMs)
			: undefined;
	const signal =
		options.signal && timeoutSignal
			? AbortSignal.any([options.signal, timeoutSignal])
			: (options.signal ?? timeoutSignal);

	const sessionId = options.sessionId ?? "pwsh:default";

	const run = async (): Promise<PwshResult> => {
		if (options.reset) {
			const existing = sessions.get(sessionId);
			if (existing) disposeSession(existing);
		}
		const session = acquireSession(sessionId, options.kernelOwnerId, cwd);
		const generation = session.generation;

		const execution = (async () => {
			await session.queue.then(
				() => undefined,
				() => undefined,
			);
			signal?.throwIfAborted();
			if (session.generation !== generation) throw new PwshExecutionCancelledError(false);
			return await runCell(session, generation, code, cwd, signal, chunk => outputSink.push(chunk));
		})();
		session.queue = execution;
		const outcome = await execution;

		if (outcome.processExitCode !== undefined) {
			// Session died mid-cell (exit, crash, kill): drop it so the next
			// cell starts a fresh process instead of writing to a dead stdin.
			if (sessions.get(sessionId) === session && session.generation === generation) {
				disposeSession(session);
			}
			outputSink.push(
				outcome.processExitCode === 0
					? "\npwsh session exited; state was reset. The next eval cell starts a fresh session.\n"
					: `\npwsh session exited with code ${outcome.processExitCode}; state was reset. The next eval cell starts a fresh session.\n`,
			);
		}

		const summary = await outputSink.dump();
		return {
			output: summary.output,
			exitCode: outcome.ok ? 0 : 1,
			cancelled: false,
			truncated: summary.truncated,
			artifactId: summary.artifactId,
			artifactElidedBytes: summary.artifactElidedBytes,
			artifactError: summary.artifactError,
			totalLines: summary.totalLines,
			totalBytes: summary.totalBytes,
			outputLines: summary.outputLines,
			outputBytes: summary.outputBytes,
		};
	};

	try {
		return await run();
	} catch (error) {
		const timedOut = Boolean(timeoutSignal?.aborted) || isTimeoutReason(options.signal?.reason);
		if (error instanceof PwshExecutionCancelledError || signal?.aborted) {
			// A cancelled cell leaves a possibly-still-running pipeline; the
			// single-process session cannot be reused safely, so drop it.
			const session = sessions.get(sessionId);
			if (session) disposeSession(session);
			if (timedOut) outputSink.push(formatTimeoutAnnotation(timeoutMs));
			const summary = await outputSink.dump();
			return {
				output: summary.output,
				exitCode: undefined,
				cancelled: true,
				truncated: summary.truncated,
				artifactId: summary.artifactId,
				artifactElidedBytes: summary.artifactElidedBytes,
				artifactError: summary.artifactError,
				totalLines: summary.totalLines,
				totalBytes: summary.totalBytes,
				outputLines: summary.outputLines,
				outputBytes: summary.outputBytes,
			};
		}
		const message = error instanceof Error ? error.message : String(error);
		logger.warn("pwsh eval failed", { error: message });
		outputSink.push(message);
		const summary = await outputSink.dump();
		return {
			output: summary.output,
			exitCode: 1,
			cancelled: false,
			truncated: summary.truncated,
			artifactId: summary.artifactId,
			artifactElidedBytes: summary.artifactElidedBytes,
			artifactError: summary.artifactError,
			totalLines: summary.totalLines,
			totalBytes: summary.totalBytes,
			outputLines: summary.outputLines,
			outputBytes: summary.outputBytes,
		};
	} finally {
		await outputSink.dispose();
	}
}
