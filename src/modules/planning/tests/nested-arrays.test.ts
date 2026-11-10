import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";

import { Effect } from "effect";

import { json } from "../../../../test/shared/assertions.ts";
import { fixture } from "../../../../test/shared/fixtures.ts";
import { resolveInputs, type LoadedBundle } from "../../policy/index.ts";
import { planProject } from "../index.ts";

const run = Effect.runPromise;
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function contribute(f: Fixture, id: string, value: object, options: object = {}) {
  await f.add(id, { name: id, requires: [] });
  await f.write(`${id}/files/config.json`, value);
  await f.add(id, {
    files: [
      {
        source: "files/config.json",
        target: "config.json",
        operation: "compose",
        format: "json",
        ...options,
      },
    ],
  });
}
async function output(
  f: Fixture,
  selected: readonly string[],
  previousBundles: readonly LoadedBundle[] = [],
) {
  const resolved = await run(resolveInputs(await f.load(selected), {}));
  const plan = await run(planProject(f.project, resolved, { manager: "npm", previousBundles }));
  const after = plan.files.find((file) => file.path === "config.json")?.after;
  assert.ok(after?.kind === "file");
  return json(Buffer.from(after.base64, "base64").toString());
}
async function writeTarget(f: Fixture, value: object) {
  await fs.writeFile(path.join(f.project, "config.json"), JSON.stringify(value));
}

await test("explicit nested arrays append without concatenating their enclosing tuples", async (t) => {
  const f = await fixture(t);
  const fields = { "/rules/example/1/allow": { merge: "append-unique" } };
  await contribute(
    f,
    "one",
    {
      rules: { example: ["error", { allow: ["one", "shared"] }] },
    },
    { fields },
  );
  await contribute(
    f,
    "two",
    {
      rules: { example: ["error", { allow: ["shared", "two"] }] },
    },
    { fields },
  );
  assert.deepEqual(await output(f, ["two", "one"]), {
    rules: { example: ["error", { allow: ["one", "shared", "two"] }] },
  });
});

await test("nested append ownership preserves project items through reruns, updates, and deselection", async (t) => {
  const f = await fixture(t);
  const fields = { "/rules/example/1/allow": { merge: "append-unique" } };
  await contribute(
    f,
    "one",
    {
      rules: { example: ["error", { allow: ["one", "shared"] }] },
    },
    { fields },
  );
  await contribute(
    f,
    "two",
    {
      rules: { example: ["error", { allow: ["two", "shared"] }] },
    },
    { fields },
  );
  await writeTarget(f, {
    rules: { example: ["warn", { allow: ["local"], localOption: true }] },
  });
  const initial = await f.load(["one", "two"]);
  const created = await output(f, ["one", "two"]);
  assert.deepEqual(created, {
    rules: { example: ["error", { allow: ["local", "one", "shared", "two"], localOption: true }] },
  });
  await writeTarget(f, created);
  assert.deepEqual(await output(f, ["two", "one"], initial.bundles), created);
  await contribute(
    f,
    "one",
    {
      rules: { example: ["error", { allow: ["updated"] }] },
    },
    { fields },
  );
  const updated = await output(f, ["one"], initial.bundles);
  assert.deepEqual(updated, {
    rules: { example: ["error", { allow: ["local", "updated"], localOption: true }] },
  });
  await writeTarget(f, updated);
  assert.deepEqual(await output(f, [], (await f.load(["one"])).bundles), {
    rules: { example: ["error", { allow: ["local"], localOption: true }] },
  });
});

for (const [label, second, fields] of [
  [
    "different severities",
    ["warn", { allow: ["two"] }],
    { "/rules/example/1/allow": { merge: "append-unique" } },
  ],
  [
    "different tuple lengths",
    ["error", { allow: ["two"] }, true],
    { "/rules/example/1/allow": { merge: "append-unique" } },
  ],
  [
    "undeclared sibling arrays",
    ["error", { allow: ["two"], other: ["two"] }],
    { "/rules/example/1/allow": { merge: "append-unique" } },
  ],
  ["missing nested merge declarations", ["error", { allow: ["one"], other: ["one"] }], {}],
] as const) {
  await test(`nested array composition rejects ${label}`, async (t) => {
    const f = await fixture(t);
    await contribute(
      f,
      "one",
      {
        rules: { example: ["error", { allow: ["one"], other: ["one"] }] },
      },
      { fields: { "/rules/example/1/allow": { merge: "append-unique" } } },
    );
    await contribute(f, "two", { rules: { example: second } }, { fields });
    await assert.rejects(output(f, ["one", "two"]), /Incompatible/);
  });
}

await test("nested append rejects non-array project values", async (t) => {
  const f = await fixture(t);
  await contribute(
    f,
    "one",
    {
      rules: { example: ["error", { allow: ["one"] }] },
    },
    { fields: { "/rules/example/1/allow": { merge: "append-unique" } } },
  );
  await writeTarget(f, { rules: { example: ["error", { allow: null }] } });
  await assert.rejects(output(f, ["one"]), /non-array project value/);
  await writeTarget(f, { rules: { example: false } });
  await assert.rejects(output(f, ["one"]), /non-array project value/);
});

await test("indexed ownership honors inherited seeds and more-specific replacements", async (t) => {
  const f = await fixture(t);
  const fields = { "/tuple/1/allow": { mode: "replace", merge: "append-unique" } };
  await contribute(
    f,
    "one",
    { tuple: ["default", { allow: ["one"] }] },
    {
      defaultMode: "seed",
      fields,
    },
  );
  await writeTarget(f, { tuple: [false, { allow: ["local"] }] });
  const initial = await f.load(["one"]);
  const created = await output(f, ["one"]);
  assert.deepEqual(created, { tuple: [false, { allow: ["local", "one"] }] });
  await writeTarget(f, created);
  await contribute(
    f,
    "one",
    { tuple: ["changed", { allow: ["two"] }] },
    {
      defaultMode: "seed",
      fields,
    },
  );
  assert.deepEqual(await output(f, ["one"], initial.bundles), {
    tuple: [false, { allow: ["local", "two"] }],
  });
});

await test("explicit nested field replacement restores the original contribution on deselection", async (t) => {
  const f = await fixture(t);
  const at = "/rules/example/1/allow";
  await contribute(
    f,
    "one",
    {
      rules: { example: ["error", { allow: ["one"] }] },
    },
    { fields: { [at]: { merge: "append-unique" } } },
  );
  await contribute(
    f,
    "two",
    {
      rules: { example: ["error", { allow: ["two"] }] },
    },
    { fields: { [at]: { merge: "append-unique", replaces: "one" } } },
  );
  await writeTarget(f, { rules: { example: ["warn", { allow: ["local"] }] } });
  const initial = await f.load(["one", "two"]);
  const replaced = await output(f, ["one", "two"]);
  assert.deepEqual(replaced, { rules: { example: ["error", { allow: ["local", "two"] }] } });
  await writeTarget(f, replaced);
  assert.deepEqual(await output(f, ["one"], initial.bundles), {
    rules: { example: ["error", { allow: ["local", "one"] }] },
  });
});
