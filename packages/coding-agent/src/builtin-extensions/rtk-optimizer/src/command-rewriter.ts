import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { type RtkRewriteProviderOptions, resolveRtkRewrite } from "./rtk-rewrite-provider.js";
import type { RtkIntegrationConfig } from "./types.js";

export interface RewriteDecision {
	changed: boolean;
	originalCommand: string;
	rewrittenCommand: string;
	reason: "ok" | "empty" | "already_rtk" | "no_match";
	warning?: string;
}

export async function computeRewriteDecision(
	command: string,
	_config: RtkIntegrationConfig,
	pi: ExtensionAPI,
	rewriteOptions: RtkRewriteProviderOptions = {},
): Promise<RewriteDecision> {
	if (!command?.trim()) {
		return { changed: false, originalCommand: command, rewrittenCommand: command, reason: "empty" };
	}

	const trimmedStart = command.trimStart();
	if (trimmedStart === "rtk" || trimmedStart.startsWith("rtk ")) {
		return { changed: false, originalCommand: command, rewrittenCommand: command, reason: "already_rtk" };
	}

	const result = await resolveRtkRewrite(pi, command, rewriteOptions);

	if (result.changed && result.rewrittenCommand) {
		return {
			changed: true,
			originalCommand: command,
			rewrittenCommand: result.rewrittenCommand,
			reason: "ok",
		};
	}

	return {
		changed: false,
		originalCommand: command,
		rewrittenCommand: command,
		reason: "no_match",
		warning: result.error,
	};
}
