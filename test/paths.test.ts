import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { resolveSafeConfigDir } from "../src/paths.js";

describe("resolveSafeConfigDir", () => {
  it("accepts a normal absolute path", () => {
    const out = resolveSafeConfigDir(join(tmpdir(), "rotator-test"), "argv");
    assert.equal(out, join(tmpdir(), "rotator-test"));
  });

  it("accepts a normal relative path", () => {
    const out = resolveSafeConfigDir("./rotator-data", "argv");
    // The function calls resolve() which normalises "./rotator-data" to
    // "<cwd>/rotator-data"; we don't assert the full path, just that
    // it doesn't throw and doesn't contain "..".
    assert.ok(!out.split(sep).includes(".."));
  });

  it("rejects a path with a .. segment pointing outside (argv)", () => {
    assert.throws(
      () => resolveSafeConfigDir("/etc/rotator-data/../../passwd", "argv"),
      /Refusing --config-dir.*contains '\.\.' segment/,
    );
  });

  it("rejects a path with a .. segment pointing outside (env)", () => {
    assert.throws(
      () => resolveSafeConfigDir("/var/lib/rotator/../../../etc", "env"),
      /Refusing --config-dir="\/var\/lib\/rotator\/\.\.\/\.\.\/\.\.\/etc" from env/,
    );
  });

  it("rejects a relative path that uses .. to escape", () => {
    assert.throws(
      () => resolveSafeConfigDir("../etc/passwd", "argv"),
      /contains '\.\.' segment/,
    );
  });

  it("accepts paths that happen to contain '..' as a substring of a segment name", () => {
    // '..foo' is a single directory name, not the parent reference.
    const out = resolveSafeConfigDir("/var/lib/..foo/rotator", "argv");
    assert.ok(out.endsWith(join("var", "lib", "..foo", "rotator")));
  });
});
