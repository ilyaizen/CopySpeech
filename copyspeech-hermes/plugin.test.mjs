// Node test entry. Run from the repo root: node copyspeech-hermes/plugin.test.mjs
// The test loads test/under-test.mjs through test/harness.mjs, after checking that
// the bundle is current. The test files register their cases in order.
import { cases } from "./test/harness.mjs";
import "./test/speech.test.mjs";
import "./test/alignment.test.mjs";
import "./test/settings.test.mjs";
import "./test/glide.test.mjs";
import "./test/captions.test.mjs";
import "./test/follow.test.mjs";
import "./test/ui.test.mjs";
import "./test/caption-regressions.test.mjs";
import "./test/stop-and-focus.test.mjs";

let passed = 0;
for (const { name, fn } of cases) {
  await fn();
  passed += 1;
  console.log("ok - " + name);
}

console.log(`\n${passed} tests passed`);
