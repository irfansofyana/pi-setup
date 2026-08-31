import assert from "node:assert/strict";
import test from "node:test";

import registerSetupCommands, { DOCTOR_PROMPT, INIT_PROMPT } from "./index.ts";

interface RegisteredCommand {
  description: string;
  handler: (args: string) => Promise<void> | void;
}

class MockPi {
  commands = new Map<string, RegisteredCommand>();
  sent: string[] = [];

  registerCommand(name: string, options: RegisteredCommand): void {
    this.commands.set(name, options);
  }

  sendUserMessage(message: string): void {
    this.sent.push(message);
  }
}

test("registers explicit init and doctor commands", () => {
  const pi = new MockPi();
  registerSetupCommands(pi as never);

  assert.deepEqual([...pi.commands.keys()].sort(), ["pi-setup-doctor", "pi-setup-init"]);
  assert.match(pi.commands.get("pi-setup-init")?.description ?? "", /audit/i);
  assert.match(pi.commands.get("pi-setup-doctor")?.description ?? "", /read-only/i);
});

test("init delegates to the bundled skill without granting mutation approval", async () => {
  const pi = new MockPi();
  registerSetupCommands(pi as never);

  await pi.commands.get("pi-setup-init")?.handler("");

  assert.deepEqual(pi.sent, [INIT_PROMPT]);
  assert.match(INIT_PROMPT, /pi-setup skill/);
  assert.match(INIT_PROMPT, /Do not mutate anything/);
  assert.match(INIT_PROMPT, /companion packages/);
});

test("setup prompts audit native web delivery and legacy coexistence without removal authority", () => {
  for (const prompt of [INIT_PROMPT, DOCTOR_PROMPT]) {
    assert.match(prompt, /web-research/);
    assert.match(prompt, /my-web-search/);
    assert.match(prompt, /Ciung/);
    assert.match(prompt, /9router/);
    assert.match(prompt, /Tavily\/Exa MCP/);
  }
  assert.match(INIT_PROMPT, /separate numbered proposals/i);
  assert.match(INIT_PROMPT, /do not remove/i);
  assert.match(DOCTOR_PROMPT, /read-only/i);
});

test("doctor delegates a strictly read-only health audit", async () => {
  const pi = new MockPi();
  registerSetupCommands(pi as never);

  await pi.commands.get("pi-setup-doctor")?.handler("");

  assert.deepEqual(pi.sent, [DOCTOR_PROMPT]);
  assert.match(DOCTOR_PROMPT, /read-only audit/);
  assert.match(DOCTOR_PROMPT, /Do not install, write, copy, move, remove, or change/);
});
