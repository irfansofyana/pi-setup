export type FooterProgressText = {
	text: string;
	spinner: string;
	isQuip: boolean;
};

/** Share presentation only. Native Pi still owns the indicator and its timer. */
export function createFooterProgress() {
	let reader: ((width: number) => FooterProgressText | undefined) | undefined;
	let footer: { active: () => boolean } | undefined;
	return {
		setReader(next: typeof reader) { reader = next; },
		read(width: number) { return reader?.(width); },
		isInFooter() { return footer?.active() ?? false; },
		mountFooter(active: () => boolean = () => true) {
			const owner = { active };
			footer = owner;
			return () => { if (footer === owner) footer = undefined; };
		},
		reset() { reader = undefined; footer = undefined; },
	};
}

export type FooterProgress = ReturnType<typeof createFooterProgress>;
