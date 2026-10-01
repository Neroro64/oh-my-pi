import type { ToolSession } from "../../tools";
import type { BackendProbeOptions } from "../probe";
import { type ExecutorBackend, type ExecutorBackendExecOptions, type ExecutorBackendResult } from "../backend";
import { namespaceSessionId as sharedNamespace, toExecutorBackendResult } from "../backend-helpers";
import { defaultEvalSessionId } from "../session-id";
import { executePwsh, resolvePwshExecutable } from "./executor";

const PWSH_SESSION_PREFIX = "pwsh:";

export function namespaceSessionId(sessionId: string): string {
	return sharedNamespace(sessionId, PWSH_SESSION_PREFIX);
}

/** Resolve the retained pwsh session identity owned by a tool session. */
export function resolvePwshSessionIdentity(session: ToolSession): {
	sessionKey: string;
	ownerId: string | undefined;
} {
	return {
		sessionKey: namespaceSessionId(session.getEvalSessionId?.() ?? defaultEvalSessionId(session)),
		ownerId: session.getEvalKernelOwnerId?.() ?? undefined,
	};
}

export default {
	id: "pwsh",
	label: "PowerShell",
	highlightLang: "powershell",

	async isAvailable(_session: ToolSession, _opts?: BackendProbeOptions): Promise<boolean> {
		return resolvePwshExecutable() !== null;
	},

	async execute(code: string, opts: ExecutorBackendExecOptions): Promise<ExecutorBackendResult> {
		const identity = resolvePwshSessionIdentity(opts.session);
		const result = await executePwsh(code, {
			cwd: opts.cwd,
			idleTimeoutMs: opts.idleTimeoutMs,
			signal: opts.signal,
			sessionId: identity.sessionKey,
			kernelOwnerId: identity.ownerId,
			reset: opts.reset,
			onChunk: opts.onChunk,
			session: opts.session,
		});
		return toExecutorBackendResult({ ...result, displayOutputs: [] });
	},
} satisfies ExecutorBackend;
