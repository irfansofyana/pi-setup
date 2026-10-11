import test from "node:test";
import assert from "node:assert/strict";
import { claimOwner } from "./ownership.ts";

test("replacement cannot admit before the previous generation drains; quarantine is sticky", () => {
 const lease=claimOwner("fixture-draining");
 assert.throws(()=>claimOwner("fixture-draining"),/owner/);
 lease.release();
 const next=claimOwner("fixture-draining");next.quarantine();next.release();
 assert.throws(()=>claimOwner("fixture-draining"),/quarantined/);
 const other=claimOwner("fixture-other");other.release();
});
