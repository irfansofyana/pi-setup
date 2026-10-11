import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";

export type RootEditorKeybindings = Pick<KeybindingsManager, "matches" | "getResolvedBindings">;
export type RootEditorInputHandler = (data: string) => boolean;
type RootEditorInputHost = { onExtensionShortcut?: RootEditorInputHandler };
type RootEditorRegistration = {
	keybindings?: RootEditorKeybindings;
	handlers: Set<RootEditorInputHandler>;
	inputDepth: number;
};

// Pi's extension loader may evaluate this module more than once. Share identity
// across those loads without retaining editors after their UI lifetime ends.
const registryKey = Symbol.for("pi-setup.pi-irfan-devs.root-editors.v1");
const shared = globalThis as typeof globalThis & { [registryKey]?: WeakMap<object, RootEditorRegistration> };
const rootEditors = (shared[registryKey] ??= new WeakMap<object, RootEditorRegistration>());

/** Call only from the theme's root editor factory, never its reusable constructor. */
export function markRootEditor<T extends object>(editor: T, keybindings?: RootEditorKeybindings): T {
	const registration = rootEditors.get(editor);
	if (!registration) rootEditors.set(editor, { keybindings, handlers: new Set(), inputDepth: 0 });
	else if (keybindings !== undefined) registration.keybindings = keybindings;
	return editor;
}

/** Cooperative UI ownership identity; this does not inspect or modify callbacks. */
export function isRootEditor(component: unknown): component is object {
	return component !== null && (typeof component === "object" || typeof component === "function") && rootEditors.has(component);
}

/** The installed manager stays live when the host changes bindings; no snapshot or private editor access. */
export function getRootEditorKeybindings(component: unknown): RootEditorKeybindings | undefined {
	return isRootEditor(component) ? rootEditors.get(component)?.keybindings : undefined;
}

/** A disposable input subscription cannot grant root identity to an unrelated editor. */
export function onRootEditorInput(editor: unknown, handler: RootEditorInputHandler): () => void {
	const registration = isRootEditor(editor) ? rootEditors.get(editor) : undefined;
	if (!registration) return () => {};
	registration.handlers.add(handler);
	return () => { registration.handlers.delete(handler); };
}

/** Called by the theme after extension shortcuts decline the current input. */
export function dispatchRootEditorInput(editor: unknown, data: string): boolean {
	const registration = isRootEditor(editor) ? rootEditors.get(editor) : undefined;
	if (!registration) return false;
	for (const handler of [...registration.handlers]) {
		if (registration.handlers.has(handler) && handler(data)) return true;
	}
	return false;
}

/** Preserve native shortcut ordering and exactly one stock input dispatch. */
export function withRootEditorInput(editor: RootEditorInputHost, data: string, nativeInput: () => void): void {
	const registration = rootEditors.get(editor);
	if (!registration) { nativeInput(); return; }
	const original = editor.onExtensionShortcut;
	let wrapper: RootEditorInputHandler | undefined;
	registration.inputDepth++;
	try {
		if (registration.inputDepth === 1) {
			wrapper = input => {
				if (original?.call(editor, input)) return true;
				return registration.inputDepth === 1 && input === data && dispatchRootEditorInput(editor, input);
			};
			editor.onExtensionShortcut = wrapper;
		}
		nativeInput();
	} finally {
		if (wrapper && editor.onExtensionShortcut === wrapper) editor.onExtensionShortcut = original;
		registration.inputDepth--;
	}
}
