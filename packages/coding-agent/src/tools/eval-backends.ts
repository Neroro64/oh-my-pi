import type { ToolSession } from ".";

import { cfgEvalJs, cfgEvalPy, cfgEvalPwsh } from "../eval/settings";

export interface EvalBackendsAllowance {
	python: boolean;
	js: boolean;
	pwsh: boolean;
}

/** Active eval backend allowance (`eval.py` / `eval.js` / `eval.pwsh`; `PI_PY` / `PI_JS` / `PI_PWSH` override). */
export function resolveEvalBackends(session: ToolSession): EvalBackendsAllowance {
	return {
		python: cfgEvalPy.get(session.settings),
		js: cfgEvalJs.get(session.settings),
		pwsh: cfgEvalPwsh.get(session.settings),
	};
}
