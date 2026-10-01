import { afterAll, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	disposeAllPwshSessions,
	executePwsh,
	resolvePwshExecutable,
} from "@oh-my-pi/pi-coding-agent/eval/pwsh/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

function makeSession(settings = Settings.isolated()): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings,
	};
}

const pwshPresent = resolvePwshExecutable() !== null;

describe("pwsh eval executor", () => {
	afterAll(async () => {
		await disposeAllPwshSessions();
	});

	it.skipIf(!pwshPresent)("persists variables across cells in one pwsh process", async () => {
		const session = makeSession();
		const first = await executePwsh("$__omp_probe = 41", { session, sessionId: "pwsh:test-persist" });
		expect(first.exitCode).toBe(0);
		const second = await executePwsh("$__omp_probe + 1; Write-Output ($__omp_probe + 1)", {
			session,
			sessionId: "pwsh:test-persist",
		});
		expect(second.exitCode).toBe(0);
		expect(second.output).toContain("42");
	});

	it.skipIf(!pwshPresent)("captures output, errors, and exit codes", async () => {
		const session = makeSession();
		const ok = await executePwsh('Write-Output "hello pwsh"', { session, sessionId: "pwsh:test-output" });
		expect(ok.exitCode).toBe(0);
		expect(ok.cancelled).toBe(false);
		expect(ok.output).toContain("hello pwsh");

		const failure = await executePwsh("throw 'boom'", { session, sessionId: "pwsh:test-output" });
		expect(failure.exitCode).toBe(1);
		expect(failure.output).toContain("boom");
	});

	it.skipIf(!pwshPresent)("reset drops prior session state", async () => {
		const session = makeSession();
		await executePwsh("$__omp_probe = 1", { session, sessionId: "pwsh:test-reset" });
		const afterReset = await executePwsh(
			"if (Get-Variable -Name __omp_probe -ErrorAction SilentlyContinue) { throw 'state survived reset' }",
			{ session, sessionId: "pwsh:test-reset", reset: true },
		);
		expect(afterReset.exitCode).toBe(0);
	});

	it.skipIf(!pwshPresent)("reports a killed session and restarts on the next cell", async () => {
		const session = makeSession();
		const exited = await executePwsh("exit 3", { session, sessionId: "pwsh:test-exit" });
		expect(exited.exitCode).toBe(1);
		expect(exited.output).toContain("exited with code 3");
		const revived = await executePwsh('Write-Output "back"', { session, sessionId: "pwsh:test-exit" });
		expect(revived.exitCode).toBe(0);
		expect(revived.output).toContain("back");
	});
});
