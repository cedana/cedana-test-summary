const fs = require('fs');
const path = require('path');
const { Resvg, initWasm } = require('@resvg/resvg-wasm');

// Contribution-graph style matrix: one rounded square per test, laid out row
// by row in suite order, so failures cluster where their suite is. Optionally
// divided into labelled sections laid out side by side, each as wide as its
// share of the tests so all sections have the same height.
const CELL = 10;
const GAP = 3;
const STEP = CELL + GAP;
const RADIUS = 2;
const PADDING = 2;
const MIN_COLS = 12;
const MAX_COLS = 80;
const SCALE = 2;

const FONT_FAMILY = 'Inter';
const FONT_SIZE = 11;
const FONT_COLOR = '#8b949e';
const CHAR_WIDTH = FONT_SIZE * 0.58; // rough average advance for Inter
const HEADER_HEIGHT = 18; // section labels above the squares
const SECTION_GAP = 2 * STEP;

const COLORS = {
    passed: '#3fb950',
    failed: '#f85149',
    flaky: '#d29922',
    skipped: '#d0d7de',
};

function cellColor(test) {
    if (test.status === 'failed') return COLORS.failed;
    if (test.status === 'skipped') return COLORS.skipped;
    if (test.flaky) return COLORS.flaky;
    return COLORS.passed;
}

function escapeXml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// "Label=regex" per line; a line without "=" collects everything unmatched.
function parseBuckets(spec) {
    return (spec || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            const index = line.indexOf('=');
            if (index < 0) return { label: line, regex: null };
            return { label: line.slice(0, index).trim(), regex: new RegExp(line.slice(index + 1).trim()) };
        });
}

function bucketOf(buckets, label) {
    const match = buckets.find((b) => b.regex && b.regex.test(label));
    if (match) return match.label;
    const rest = buckets.find((b) => !b.regex);
    return rest ? rest.label : 'Others';
}

// Buckets that have tests, in spec order (unlisted catch-all last).
function activeBuckets(buckets, counts) {
    const order = buckets.map((b) => b.label);
    for (const label of counts.keys()) if (!order.includes(label)) order.push(label);
    return order.filter((label) => (counts.get(label) || 0) > 0);
}

// Roughly 3:1 grid for `count` squares.
function layout(count) {
    const cols = Math.min(MAX_COLS, Math.max(MIN_COLS, Math.ceil(Math.sqrt(count * 3))));
    const rows = Math.max(1, Math.ceil(count / cols));
    return {
        cols,
        rows,
        width: cols * STEP - GAP + PADDING * 2,
        height: rows * STEP - GAP + PADDING * 2,
    };
}

function renderMatrixSvg(groups, { sections = '' } = {}) {
    const buckets = parseBuckets(sections);

    // section label -> colors, in suite order.
    const colors = new Map();
    for (const group of [...groups].sort((a, b) => a.label.localeCompare(b.label))) {
        const section = buckets.length > 0 ? bucketOf(buckets, group.label) : '';
        if (!colors.has(section)) colors.set(section, []);
        colors.get(section).push(...group.tests.map(cellColor));
    }
    const counts = new Map([...colors].map(([section, list]) => [section, list.length]));
    const active = activeBuckets(buckets, counts);
    const total = [...counts.values()].reduce((sum, c) => sum + c, 0);

    const rect = (x, y, color) => `<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="${RADIUS}" fill="${color}"/>`;
    const text = (x, y, content) =>
        `<text x="${x}" y="${y}" font-family="${FONT_FAMILY}" font-size="${FONT_SIZE}" fill="${FONT_COLOR}">${escapeXml(content)}</text>`;
    const svg = (width, height, parts) =>
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join('')}</svg>`;

    // One section (or none configured): a plain grid.
    if (active.length <= 1) {
        const all = [...colors.values()].flat();
        const { cols, width, height } = layout(all.length);
        return svg(
            width,
            height,
            all.map((color, i) => rect(PADDING + (i % cols) * STEP, PADDING + Math.floor(i / cols) * STEP, color))
        );
    }

    // Sections side by side: shared row count, width proportional to size,
    // never narrower than the label above it.
    const { rows } = layout(total);
    const parts = [];
    let x = PADDING;
    for (const section of active) {
        const list = colors.get(section);
        const labelCols = Math.ceil((section.length * CHAR_WIDTH + GAP) / STEP);
        const cols = Math.max(Math.ceil(list.length / rows), labelCols, 1);
        parts.push(text(x, PADDING + FONT_SIZE, section));
        list.forEach((color, i) => parts.push(rect(x + (i % cols) * STEP, PADDING + HEADER_HEIGHT + Math.floor(i / cols) * STEP, color)));
        x += cols * STEP - GAP + SECTION_GAP;
    }
    const width = x - SECTION_GAP + PADDING;
    const height = PADDING + HEADER_HEIGHT + rows * STEP - GAP + PADDING;
    return svg(width, height, parts);
}

// The build copies the wasm and font next to the bundle; from source they live elsewhere.
function assetPath(name, fallback) {
    const bundled = path.join(__dirname, name);
    return fs.existsSync(bundled) ? bundled : path.join(__dirname, '..', fallback);
}

let wasmReady = null;
let fontBuffer = null;

async function svgToPng(svg) {
    if (!wasmReady) {
        wasmReady = initWasm(fs.readFileSync(assetPath('index_bg.wasm', 'node_modules/@resvg/resvg-wasm/index_bg.wasm')));
        fontBuffer = fs.readFileSync(assetPath('Inter-Regular.ttf', 'assets/Inter-Regular.ttf'));
    }
    await wasmReady;
    const resvg = new Resvg(svg, {
        fitTo: { mode: 'zoom', value: SCALE },
        font: { fontBuffers: [fontBuffer], defaultFontFamily: FONT_FAMILY },
    });
    return Buffer.from(resvg.render().asPng());
}

async function renderMatrixPng(groups, options) {
    return svgToPng(renderMatrixSvg(groups, options));
}

module.exports = { renderMatrixSvg, renderMatrixPng, layout, parseBuckets, bucketOf, COLORS };
