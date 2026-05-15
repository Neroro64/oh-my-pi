/**
 * Built-in extensions vendored directly into omp.
 *
 * Each entry registers an {@link ExtensionFactory} that the runtime loads
 * after disk discovery, before the per-session runtime starts. Built-ins
 * supersede same-named installed plugins automatically, but can be disabled
 * individually via the `disabledExtensions` setting (id: `extension-module:<name>`).
 */
import type { ExtensionFactory } from "../extensibility/extensions/types";
import rtkOptimizerFactory from "./rtk-optimizer/index";

export interface BuiltinExtension {
	/**
	 * Stable id used for `disabledExtensions` matching. Must be unique across
	 * built-ins AND across discovered on-disk extensions.
	 */
	name: string;
	/** Factory invoked with the host-allocated {@link ExtensionAPI}. */
	factory: ExtensionFactory;
	/**
	 * Installed-plugin package names whose extension paths should be skipped
	 * when this built-in is active. Used to prevent double-registration when a
	 * user has the marketplace plugin installed alongside the vendored copy.
	 */
	supersedesPluginPackages?: readonly string[];
}

export const BUILTIN_EXTENSIONS: readonly BuiltinExtension[] = [
	{
		name: "pi-rtk-optimizer",
		factory: rtkOptimizerFactory,
		supersedesPluginPackages: ["pi-rtk-optimizer"],
	},
];

/** Build the synthetic extension id used to match `disabledExtensions`. */
export function getBuiltinExtensionDisabledId(name: string): string {
	return `extension-module:${name}`;
}

/**
 * Compute the set of installed-plugin package names superseded by active
 * built-ins. A built-in counts as active when its disabled id is NOT in the
 * provided set.
 */
export function getSupersededPluginPackages(disabledExtensionIds: Iterable<string>): Set<string> {
	const disabled = disabledExtensionIds instanceof Set ? disabledExtensionIds : new Set(disabledExtensionIds);
	const out = new Set<string>();
	for (const builtin of BUILTIN_EXTENSIONS) {
		if (disabled.has(getBuiltinExtensionDisabledId(builtin.name))) continue;
		for (const pkg of builtin.supersedesPluginPackages ?? []) out.add(pkg);
	}
	return out;
}

/** Active (non-disabled) built-ins for the current call. */
export function getActiveBuiltinExtensions(disabledExtensionIds: Iterable<string>): BuiltinExtension[] {
	const disabled = disabledExtensionIds instanceof Set ? disabledExtensionIds : new Set(disabledExtensionIds);
	return BUILTIN_EXTENSIONS.filter(b => !disabled.has(getBuiltinExtensionDisabledId(b.name)));
}
