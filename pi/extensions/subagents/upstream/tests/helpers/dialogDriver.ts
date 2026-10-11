import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { DialogEditor, DialogMenu } from "../../src/ui/dialog.ts";

const drivers = new WeakMap<object, DialogDriver>();

export interface DialogDriverStats {
  outerOpens: number;
  outerCompletions: number;
  forcedRenders: number;
  childMounts: number;
  frameHeights: number[];
}

export interface DialogDriver {
  custom: (factory: Function, options?: unknown) => Promise<unknown>;
  theme: Theme;
  /** Return true to handle a mounted child (or direct component) yourself. */
  onChild?: (component: any) => boolean | Promise<boolean>;
  /** Non-overlay custom calls, such as the external editor, forwarded by the session. */
  onPassthrough?: (factory: Function, options: unknown) => Promise<unknown>;
  readonly stats: DialogDriverStats;
  /** Outer DialogSession once its factory has returned, otherwise undefined. */
  readonly session: any;
  readonly renders: string[][];
  failure?: unknown;
}

export interface DialogDriverOptions {
  theme: Theme;
  rows?: number;
  width?: number;
  timeoutMs?: number;
  choices?: (string | undefined)[];
  inputs?: (string | undefined)[];
  /** Menus, editors, and inputs all consume `choices` in call order. */
  unified?: boolean;
  menuLabels?: (menu: DialogMenu) => string[];
  resolveChoice?: (title: string, labels: string[], choice: string) => string;
  onMenu?: (menu: DialogMenu, labels: string[]) => void;
  onEditor?: (editor: DialogEditor) => void;
  onFrame?: (component: any, lines: string[]) => void;
  onOpen?: (options: unknown) => void;
  assertBorder?: boolean;
}

export function bindDialogDriver(ctx: object, driver: DialogDriver): void {
  drivers.set(ctx, driver);
}

export function dialogDriverFor(ctx: object): DialogDriver {
  const driver = drivers.get(ctx);
  assert.ok(driver, "dialog driver missing for context");
  return driver;
}

function isSession(component: unknown): component is { getComponent(): unknown } {
  return (
    !!component &&
    typeof component === "object" &&
    typeof (component as { getComponent?: unknown }).getComponent === "function"
  );
}

function isOverlay(options: unknown): boolean {
  return !!options && typeof options === "object" && "overlay" in options;
}

/** Replace a prefilled single-line dialog input regardless of cursor position. */
function replaceInput(
  component: { handleInput(data: string): void },
  value: string | undefined,
): void {
  if (value === undefined) {
    component.handleInput("\x1b");
    return;
  }
  component.handleInput("\x05");
  component.handleInput("\x15");
  if (value) component.handleInput(value);
  component.handleInput("\r");
}

function moveMenu(menu: DialogMenu, index: number): void {
  for (let step = 0; step < menu.rows.length; step++) menu.handleInput("\x1b[A");
  for (let step = 0; step < index; step++) menu.handleInput("\x1b[B");
}

/**
 * Fake `ctx.ui.custom` that drives either one persistent DialogSession or, until
 * that host exists, each overlay component directly. Session children are
 * inspected on `requestRender` microtasks and never handled twice.
 */
export function createDialogDriver(options: DialogDriverOptions): DialogDriver {
  const stats: DialogDriverStats = {
    outerOpens: 0,
    outerCompletions: 0,
    forcedRenders: 0,
    childMounts: 0,
    frameHeights: [],
  };
  const renders: string[][] = [];
  const choices = options.choices ?? [];
  const inputs = options.inputs ?? [];
  const width = options.width ?? 80;
  const rows = options.rows ?? 24;
  let session: any;
  let lastChild: unknown;
  let driving = false;
  let queued = false;
  let settled = false;
  let failure: unknown;
  const seen = new WeakSet<object>();

  const driver: DialogDriver = {
    theme: options.theme,
    stats,
    renders,
    custom: (factory, overlayOptions) => open(factory, overlayOptions).finally(() => undefined),
    get session() {
      return session;
    },
    get failure() {
      return failure;
    },
  };

  function note(error: unknown): void {
    failure = failure ?? error;
  }

  function finishOuter(
    result: unknown,
    resolve: (value: unknown) => void,
    reject: (error: unknown) => void,
  ): void {
    if (settled) return;
    settled = true;
    stats.outerCompletions++;
    if (failure) reject(failure);
    else resolve(result);
  }

  async function drive(component: any): Promise<void> {
    if (driver.onChild && (await driver.onChild(component))) return;
    const lines = component.render?.(width) ?? [];
    if (Array.isArray(lines) && lines.length) {
      renders.push(lines);
      stats.frameHeights.push(lines.length);
      if (options.assertBorder) assert.match(lines.at(-1), /^╰.*╯$/);
      options.onFrame?.(component, lines);
    }
    if (component instanceof DialogMenu) {
      const labels = (options.menuLabels ?? ((menu: DialogMenu) => menu.rows.map((row) => row.id)))(
        component,
      );
      options.onMenu?.(component, labels);
      const choice = choices.shift();
      if (choice === undefined) {
        component.handleInput("\x1b");
        return;
      }
      const resolved = options.resolveChoice?.(component.title, labels, choice) ?? choice;
      assert.ok(labels.includes(resolved), `Missing dialog option: ${choice}`);
      moveMenu(component, labels.indexOf(resolved));
      assert.equal(component.getSelectedId(), component.rows[labels.indexOf(resolved)]!.id);
      component.handleInput("\r");
      return;
    }
    if (component instanceof DialogEditor) {
      options.onEditor?.(component);
      const value = (options.unified ? choices : inputs).shift();
      if (value === undefined) component.handleInput("\x1b");
      else {
        component.getEditor().setText(value);
        component.handleInput("\x13");
      }
      return;
    }
    const items = component.getItems?.();
    if (items) {
      const choice = choices.shift();
      if (choice === undefined) {
        component.getSelectList?.().onCancel?.();
        return;
      }
      const item = items.find((entry: { value: string }) => entry.value === choice);
      assert.ok(item, `Missing color picker option: ${choice}`);
      component.getSelectList?.().onSelectionChange?.(item);
      component.getSelectList?.().onSelect?.(item);
      return;
    }
    if (typeof component.handleInput === "function") {
      replaceInput(component, (options.unified ? choices : inputs).shift());
      return;
    }
    assert.ok(items, "expected color picker items");
  }

  function inspect(): void {
    if (!isSession(session)) return;
    if (driving) {
      queued = true;
      return;
    }
    const child = session.getComponent();
    if (!child || child === lastChild || seen.has(child)) return;
    lastChild = child;
    seen.add(child);
    stats.childMounts++;
    driving = true;
    Promise.resolve(drive(child))
      .catch((error) => {
        note(error);
        try {
          (child as { handleInput?(data: string): void }).handleInput?.("\x1b");
        } catch {
          /* the original failure is the one that matters */
        }
      })
      .finally(() => {
        driving = false;
        if (!queued) return;
        queued = false;
        queueMicrotask(inspect);
      });
  }

  function open(factory: Function, overlayOptions: unknown): Promise<unknown> {
    if (!isOverlay(overlayOptions)) {
      if (driver.onPassthrough) return driver.onPassthrough(factory, overlayOptions);
      return new Promise((resolve, reject) => {
        try {
          Promise.resolve(
            factory({ requestRender() {}, terminal: { rows } }, driver.theme, {}, resolve),
          ).catch(reject);
        } catch (error) {
          reject(error);
        }
      });
    }
    options.onOpen?.(overlayOptions);
    stats.outerOpens++;
    settled = false;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        note(
          new Error(
            `dialog driver timed out (${stats.outerOpens} outer opens, ${stats.childMounts} children)`,
          ),
        );
        if (settled) return;
        settled = true;
        reject(failure);
      }, options.timeoutMs ?? 4000);
      const done = (result: unknown) => {
        clearTimeout(timer);
        finishOuter(result, resolve, reject);
      };
      const host = {
        setFocus(component: { focused?: boolean }) {
          component.focused = true;
        },
        requestRender(force?: boolean) {
          if (force === true) stats.forcedRenders++;
          queueMicrotask(inspect);
        },
        terminal: { rows },
      };
      let created: unknown;
      try {
        created = factory(host, driver.theme, {}, done);
      } catch (error) {
        clearTimeout(timer);
        note(error);
        reject(error);
        return;
      }
      Promise.resolve(created)
        .then((component) => {
          if (isSession(component)) {
            session = component;
            // requestRender during factory may have run before `session` was visible.
            queueMicrotask(inspect);
            return;
          }
          session = undefined;
          lastChild = component;
          return drive(component);
        })
        .catch((error) => {
          clearTimeout(timer);
          note(error);
          if (!settled) {
            settled = true;
            reject(error);
          }
        });
    });
  }

  return driver;
}

