const METADATA_ENTRIES = new Set([
	"model_change", "thinking_level_change", "session_info", "label", "usage", "custom",
]);

/** Custom state entries never render; custom_message and unknown types do. */
export function watermarkMetadataOnly(entries: readonly { type: string }[]): boolean {
	return entries.every(entry => METADATA_ENTRIES.has(entry.type));
}

export function watermarkSessionEligible(options: {
	reason: string;
	persisted: boolean;
	parentSession?: string;
	entries: readonly { type: string }[];
}): boolean {
	if (options.parentSession || !watermarkMetadataOnly(options.entries)) return false;
	if (options.reason === "new") return true;
	return (options.reason === "startup" || options.reason === "reload") && !options.persisted;
}
