/**
 * The host's own section of the package's config file, `host`: what a
 * person may turn off in the shared hosts. Read once as a host starts,
 * so a change takes effect at its next restart. A missing file or
 * section leaves every default; one that can't be read is said in the
 * journal and leaves them too, since a host refusing to start over its
 * settings would cost more than a default does.
 */
import {
	getSection,
	loadPackageConfig,
	type SectionParse,
} from "../../lib/internal/config/loader.ts";
import { isRecord } from "../../lib/internal/record.ts";

/** The config file's section the host reads. */
export const HOST_SECTION = "host";

/** What the host's section sets. */
export interface HostSettings {
	/** Give V8's pooled pages back once quiet (engine/quiet-collection.ts); on by default. */
	readonly collectWhenQuiet: boolean;
}

const DEFAULTS: HostSettings = { collectWhenQuiet: true };

/** Parse the host's section, its defaults for none. */
export const parseHostSection: SectionParse<HostSettings> = (value) => {
	if (value === undefined) return { ok: true, value: DEFAULTS };
	if (!isRecord(value)) return { ok: false, error: "must be an object" };
	const collect = value.collectWhenQuiet;
	if (collect !== undefined && typeof collect !== "boolean")
		return { ok: false, error: "has a collectWhenQuiet that isn't true or false" };
	return {
		ok: true,
		value: { collectWhenQuiet: collect ?? DEFAULTS.collectWhenQuiet },
	};
};

/** Read the host's settings from the package's config file at `path`. */
export async function hostSettings(
	report: (said: string) => void,
	path?: string,
): Promise<HostSettings> {
	const loaded = await loadPackageConfig(path);
	if (!loaded.ok) {
		report(`${loaded.error}; the host keeps its defaults`);
		return DEFAULTS;
	}
	const section = getSection(loaded.config, HOST_SECTION, parseHostSection);
	if (section.warning)
		report(
			`The ${HOST_SECTION} section of ${loaded.path} ${section.warning}; the host keeps its defaults`,
		);
	return section.value;
}
