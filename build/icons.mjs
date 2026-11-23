#!/usr/bin/env node
// Generates every Synapse icon from resources/icons/mark.svg into
// resources/generated/, plus resources/generated/overlay.json, which
// build/prepare.mjs uses to replace upstream's icons. Run it after changing
// the art, and commit the output:
//
//   node build/icons.mjs
//
// Needs Playwright with Chromium (rasterizing SVG). ICO, ICNS and BMP
// containers are written here, so no other image tools are needed.
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { ROOT } from "./lib.mjs";

const { chromium } = createRequire(import.meta.url)("playwright");
const SRC = path.join(ROOT, "resources", "icons");
const OUT = path.join(ROOT, "resources", "generated");

// ---------------------------------------------------------------------------
// Art

const markSource = fs.readFileSync(path.join(SRC, "mark.svg"), "utf8").replace(/<!--[\s\S]*?-->/g, "").trim();
const BG_DEFS = `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2e2a7a"/><stop offset="1" stop-color="#5b3fd1"/></linearGradient></defs>`;
const svg = (body, w = 1024, h = 1024) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${body}</svg>`;
const scaled = (body, s) => `<g transform="translate(512 512) scale(${s}) translate(-512 -512)">${body}</g>`;

/** App icon with the macOS grid: 824 px rounded square inside 1024. */
const appIcon = () => svg(`${BG_DEFS}<rect x="100" y="100" width="824" height="824" rx="185" fill="url(#bg)"/>${markSource}`);
/** Full-bleed rounded square for Windows, Linux and the web. */
const squareBody = () => `${BG_DEFS}<rect x="16" y="16" width="992" height="992" rx="224" fill="url(#bg)"/>${scaled(markSource, 1.14)}`;
const squareIcon = () => svg(squareBody());
/** The mark alone, light strokes, for tiles on a colored background. */
const markOnly = () => svg(scaled(markSource, 1.25));
/** One-color mark (watermarks, activity bar). */
function monoMark(color, opacity = 1, scale = 1.25) {
  const body = markSource
    .replace(/<circle[^>]*opacity="0\.28"[^>]*\/>/, "")
    .replace(/(stroke|fill)="#[0-9a-fA-F]{3,6}"/g, (_m, attr) => `${attr}="${color}"`);
  return svg(`<g opacity="${opacity}">${scaled(body, scale)}</g>`);
}

/** File-type icon: a document with the extension and a small Synapse badge. No third-party logos. */
function fileIcon(label) {
  const size = label.length <= 2 ? 250 : label.length === 3 ? 200 : 160;
  const lines = [380, 450, 520, 590].map((y, i) => `<rect x="300" y="${y}" width="${i % 2 ? 300 : 400}" height="34" rx="17" fill="#d8d4ee"/>`).join("");
  const text = label
    ? `<text x="500" y="${label.length <= 2 ? 600 : 580}" text-anchor="middle" font-family="Inter, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-weight="800" font-size="${size}" fill="#4a3cc0" letter-spacing="-4">${label}</text>`
    : lines;
  return svg(
    `${BG_DEFS}` +
      `<path d="M210 60 H640 L840 260 V914 Q840 964 790 964 H260 Q210 964 210 914 Z" fill="#fbfbfe" stroke="#c9c4e6" stroke-width="16"/>` +
      `<path d="M640 60 V210 Q640 260 690 260 H840 Z" fill="#e3def8" stroke="#c9c4e6" stroke-width="16" stroke-linejoin="round"/>` +
      text +
      `<g transform="translate(590 640) scale(0.36)">${squareBody()}</g>`,
  );
}

/** Installer wizard side image (tall). */
function innoBig(w, h) {
  const s = (w * 0.72) / 824;
  const cx = w / 2;
  const cy = h * 0.36;
  return svg(
    `<defs><linearGradient id="v" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2e2a7a"/><stop offset="1" stop-color="#5b3fd1"/></linearGradient></defs>` +
      `<rect width="${w}" height="${h}" fill="url(#v)"/>` +
      `<g transform="translate(${cx} ${cy}) scale(${s * 1.3}) translate(-512 -512)">${markSource}</g>` +
      `<text x="${cx}" y="${h * 0.62}" text-anchor="middle" font-family="Inter, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-weight="700" font-size="${w * 0.17}" fill="#efeaff">Synapse</text>`,
    w,
    h,
  );
}

/** Installer header image (small, white background). */
function innoSmall(w, h) {
  const d = Math.min(w, h);
  return svg(`<rect width="${w}" height="${h}" fill="#ffffff"/><g transform="translate(${(w - d) / 2} ${(h - d) / 2}) scale(${d / 1024})">${squareBody()}</g>`, w, h);
}

// ---------------------------------------------------------------------------
// Containers

function ico(pngs) {
  // pngs: [{ size, png }] — PNG-compressed entries (Windows Vista and later).
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, png }, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, e);
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt8(0, e + 2);
    header.writeUInt8(0, e + 3);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(png.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...pngs.map((p) => p.png)]);
}

// ICNS chunk types holding PNG data, by pixel size (and 2x variants).
const ICNS_TYPES = [
  ["icp4", 16],
  ["icp5", 32],
  ["ic11", 32],
  ["ic12", 64],
  ["ic07", 128],
  ["ic13", 256],
  ["ic08", 256],
  ["ic14", 512],
  ["ic09", 512],
  ["ic10", 1024],
];

function icns(pngBySize, maxSize) {
  const chunks = ICNS_TYPES.filter(([, s]) => s <= maxSize).map(([type, s]) => {
    const data = pngBySize.get(s);
    const head = Buffer.alloc(8);
    head.write(type, 0, "ascii");
    head.writeUInt32BE(8 + data.length, 4);
    return Buffer.concat([head, data]);
  });
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write("icns", 0, "ascii");
  head.writeUInt32BE(8 + body.length, 4);
  return Buffer.concat([head, body]);
}

function bmp24(w, h, rgba) {
  const rowSize = Math.ceil((w * 3) / 4) * 4;
  const buf = Buffer.alloc(54 + rowSize * h);
  buf.write("BM", 0, "ascii");
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(54, 10);
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28);
  buf.writeUInt32LE(rowSize * h, 34);
  buf.writeInt32LE(2835, 38);
  buf.writeInt32LE(2835, 42);
  for (let y = 0; y < h; y++) {
    const row = 54 + (h - 1 - y) * rowSize;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = rgba[i + 3] / 255;
      // Composite on white (installer pages are white).
      buf[row + x * 3] = Math.round(rgba[i + 2] * a + 255 * (1 - a));
      buf[row + x * 3 + 1] = Math.round(rgba[i + 1] * a + 255 * (1 - a));
      buf[row + x * 3 + 2] = Math.round(rgba[i] * a + 255 * (1 - a));
    }
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Rasterizing

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent("<canvas id=c></canvas>");

async function raster(svgText, w, h = w) {
  const { png, rgba } = await page.evaluate(
    async ({ svgText, w, h }) => {
      const img = new Image();
      img.src = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svgText)));
      await img.decode();
      const c = document.getElementById("c");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d");
      ctx.clearRect(0, 0, w, h);
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, w, h);
      return { png: c.toDataURL("image/png").split(",")[1], rgba: Array.from(ctx.getImageData(0, 0, w, h).data) };
    },
    { svgText, w, h },
  );
  return { png: Buffer.from(png, "base64"), rgba: Uint8Array.from(rgba) };
}

async function pngSet(svgText, sizes) {
  const map = new Map();
  for (const s of sizes) map.set(s, (await raster(svgText, s)).png);
  return map;
}

// ---------------------------------------------------------------------------
// Outputs

const overlay = {};
const out = (rel, data, upstream) => {
  const file = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  for (const u of [upstream].flat().filter(Boolean)) overlay[u] = rel;
};

fs.rmSync(OUT, { recursive: true, force: true });

// App icon.
const appPngs = await pngSet(appIcon(), [16, 32, 64, 128, 256, 512, 1024]);
const squarePngs = await pngSet(squareIcon(), [16, 20, 24, 32, 48, 64, 96, 128, 192, 256, 512, 1024]);
out("darwin/app.icns", icns(appPngs, 1024), "resources/darwin/code.icns");
const appIco = ico([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, png: squarePngs.get(size) })));
out("win32/app.ico", appIco, ["resources/win32/code.ico", "resources/win32/sessions.ico"]);
out("win32/tile-70.png", (await raster(markOnly(), 70)).png, "resources/win32/code_70x70.png");
out("win32/tile-150.png", (await raster(markOnly(), 150)).png, "resources/win32/code_150x150.png");
out("linux/app-1024.png", squarePngs.get(1024), "resources/linux/code.png");
out("server/app-192.png", squarePngs.get(192), "resources/server/code-192.png");
out("server/app-512.png", squarePngs.get(512), "resources/server/code-512.png");
out("server/favicon.ico", ico([16, 24, 32, 48, 64].map((size) => ({ size, png: squarePngs.get(size) }))), "resources/server/favicon.ico");

// Workbench art: title bar / about icon and the empty-editor watermark.
out("workbench/code-icon.svg", squareIcon(), "src/vs/workbench/browser/media/code-icon.svg");
const watermark = { light: ["#000000", 0.16], dark: ["#ffffff", 0.16], hcLight: ["#000000", 0.5], hcDark: ["#ffffff", 0.5] };
for (const [theme, [color, opacity]] of Object.entries(watermark)) {
  out(`workbench/letterpress-${theme}.svg`, monoMark(color, opacity, 1.3), `src/vs/workbench/browser/parts/editor/media/letterpress-${theme}.svg`);
}

// File-type icons (document + extension + badge).
const LABELS = {
  bat: "BAT", bower: "BWR", c: "C", config: "CFG", cpp: "C++", csharp: "C#", css: "CSS", default: "", go: "GO",
  html: "HTML", jade: "PUG", java: "JAVA", javascript: "JS", json: "{ }", less: "LESS", markdown: "MD", php: "PHP",
  powershell: "PS", python: "PY", react: "JSX", ruby: "RB", sass: "SASS", shell: "SH", sql: "SQL", typescript: "TS",
  vue: "VUE", xml: "XML", yaml: "YML",
};
const WIN32_FILE_ICONS = Object.keys(LABELS).filter((k) => k !== "bat");
for (const [name, label] of Object.entries(LABELS)) {
  const pngs = await pngSet(fileIcon(label), [16, 20, 24, 32, 48, 64, 96, 128, 256, 512]);
  out(`darwin/file-${name}.icns`, icns(pngs, 256), `resources/darwin/${name}.icns`);
  if (WIN32_FILE_ICONS.includes(name)) {
    out(`win32/file-${name}.ico`, ico([16, 20, 24, 32, 48, 64, 96, 128, 256].map((size) => ({ size, png: pngs.get(size) }))), `resources/win32/${name}.ico`);
  }
}

// Windows installer images.
const INNO_BIG = { 100: [164, 314], 125: [192, 386], 150: [246, 459], 175: [273, 556], 200: [328, 604], 225: [355, 700], 250: [410, 797] };
const INNO_SMALL = { 100: [55, 55], 125: [64, 68], 150: [83, 80], 175: [92, 97], 200: [110, 106], 225: [119, 123], 250: [138, 140] };
for (const [scale, [w, h]] of Object.entries(INNO_BIG)) out(`win32/inno-big-${scale}.bmp`, bmp24(w, h, (await raster(innoBig(w, h), w, h)).rgba), `resources/win32/inno-big-${scale}.bmp`);
for (const [scale, [w, h]] of Object.entries(INNO_SMALL)) out(`win32/inno-small-${scale}.bmp`, bmp24(w, h, (await raster(innoSmall(w, h), w, h)).rgba), `resources/win32/inno-small-${scale}.bmp`);

// Previews for people (not shipped).
out("preview/app-1024.png", appPngs.get(1024));
out("preview/square-512.png", squarePngs.get(512));

// The extension's activity bar icon (VS Code uses it as a mask: one color).
fs.writeFileSync(path.join(ROOT, "extensions", "synapse-collab", "media", "synapse.svg"), monoMark("#000000", 1, 1.4) + "\n");

fs.writeFileSync(path.join(OUT, "overlay.json"), JSON.stringify(Object.fromEntries(Object.entries(overlay).sort()), null, 2) + "\n");
await browser.close();
console.log(`wrote ${Object.keys(overlay).length} icon replacements to ${path.relative(ROOT, OUT)}`);
