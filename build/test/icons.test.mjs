import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const gen = path.join(root, "resources", "generated");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

test("generated icons exist and are valid ICO, ICNS, BMP, PNG and SVG files", () => {
  const overlay = JSON.parse(fs.readFileSync(path.join(gen, "overlay.json"), "utf8"));
  assert.ok(Object.keys(overlay).length >= 80, "every upstream icon has a replacement");
  for (const [upstream, file] of Object.entries(overlay)) {
    const buf = fs.readFileSync(path.join(gen, file));
    assert.equal(path.extname(upstream), path.extname(file), `${file} has the same type as ${upstream}`);
    switch (path.extname(file)) {
      case ".ico": {
        assert.equal(buf.readUInt16LE(2), 1, `${file}: ICO type`);
        const n = buf.readUInt16LE(4);
        assert.ok(n >= 4, `${file}: several sizes`);
        for (let i = 0; i < n; i++) {
          const off = buf.readUInt32LE(6 + 16 * i + 12);
          assert.ok(buf.subarray(off, off + 4).equals(PNG), `${file}: entry ${i} is PNG`);
        }
        break;
      }
      case ".icns":
        assert.equal(buf.toString("ascii", 0, 4), "icns");
        assert.equal(buf.readUInt32BE(4), buf.length, `${file}: length`);
        break;
      case ".bmp":
        assert.equal(buf.toString("ascii", 0, 2), "BM");
        assert.equal(buf.readUInt16LE(28), 24, `${file}: 24-bit`);
        break;
      case ".png":
        assert.ok(buf.subarray(0, 4).equals(PNG), file);
        break;
      case ".svg":
        assert.match(buf.toString("utf8"), /^<svg [^>]*viewBox/, file);
        break;
      default:
        assert.fail(`unexpected file type: ${file}`);
    }
  }
});
