const fs = require('fs');
const path = require('path');
const { Resvg, initWasm } = require('@resvg/resvg-wasm');

// Contribution-graph style matrix: one rounded square per test, laid out row
// by row in suite order, so failures cluster where their suite is. Optionally
// divided into sections laid out side by side (labelled on top, each as wide
// as its share of the tests) and into bands stacked within every section
// (labelled on the right).
const CELL = 10;
const GAP = 3;
const STEP = CELL + GAP;
const RADIUS = 2;
const PADDING = 4;
const MIN_COLS = 12;
const MAX_COLS = 80;
const SCALE = 2;

const FONT_FAMILY = 'Inter';
const FONT_SIZE = 11;
const FONT_COLOR = '#9da7b3'; // light enough for dark themes, still readable on white
const LETTER_SPACING = 0.6;
const CHAR_WIDTH = FONT_SIZE * 0.66 + LETTER_SPACING; // rough advance for upper-case Inter
const HEADER_HEIGHT = 20; // section labels above the squares
const LABEL_GAP = 10; // between the squares and the band labels on the right
const SECTION_GAP = 2 * STEP;
const BAND_GAP = STEP;

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
// A label may reference capture groups of its regex ($1, $2, ...), in which
// case the line expands into one bucket per distinct captured value.
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
    for (const bucket of buckets) {
        const match = bucket.regex && bucket.regex.exec(label);
        if (!match) continue;
        const name = bucket.label.replace(/\$(\d+)/g, (_, i) => match[i] || '');
        // Remember expansions, in order of appearance, so they are laid out where the line sits.
        if (name !== bucket.label && !(bucket.expanded ||= []).includes(name)) bucket.expanded.push(name);
        return name;
    }
    const rest = buckets.find((b) => !b.regex);
    return rest ? rest.label : 'Other';
}

// Buckets that have tests, in spec order (unlisted catch-all last).
function activeBuckets(buckets, counts) {
    const order = buckets.flatMap((b) => b.expanded || [b.label]);
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

function renderMatrixSvg(groups, { sections = '', split = '' } = {}) {
    const sectionBuckets = parseBuckets(sections);
    const splitBuckets = parseBuckets(split);

    // cells: section -> band -> colors, in suite order.
    const cells = new Map();
    const sectionCounts = new Map();
    const splitCounts = new Map();
    let total = 0;
    for (const group of [...groups].sort((a, b) => a.label.localeCompare(b.label))) {
        const section = sectionBuckets.length > 0 ? bucketOf(sectionBuckets, group.label) : '';
        const band = splitBuckets.length > 0 ? bucketOf(splitBuckets, group.label) : '';
        if (!cells.has(section)) cells.set(section, new Map());
        const row = cells.get(section);
        if (!row.has(band)) row.set(band, []);
        row.get(band).push(...group.tests.map(cellColor));
        sectionCounts.set(section, (sectionCounts.get(section) || 0) + group.tests.length);
        splitCounts.set(band, (splitCounts.get(band) || 0) + group.tests.length);
        total += group.tests.length;
    }

    const activeSections = activeBuckets(sectionBuckets, sectionCounts);
    const activeBands = activeBuckets(splitBuckets, splitCounts);
    const showSections = activeSections.length > 1;
    const showSplit = activeBands.length > 1;
    const columns = showSections ? activeSections : [null];
    const bands = showSplit ? activeBands : [null];
    // Colors of one cell, merging along a collapsed dimension in suite order.
    const colorsAt = (section, band) => {
        const out = [];
        for (const [s, row] of cells) {
            if (section !== null && s !== section) continue;
            for (const [b, colors] of row) {
                if (band !== null && b !== band) continue;
                out.push(...colors);
            }
        }
        return out;
    };

    // Section widths proportional to their share of the tests, never narrower
    // than the label on top; band heights shared across sections.
    const { cols: totalCols } = layout(total);
    const colsOf = columns.map((section) => {
        if (section === null) return totalCols;
        const count = bands.reduce((sum, band) => sum + colorsAt(section, band).length, 0);
        const labelCols = Math.ceil((section.length * CHAR_WIDTH + GAP) / STEP);
        return Math.max(1, labelCols, Math.ceil((totalCols * count) / total));
    });
    const rowsOf = bands.map((band) =>
        Math.max(1, ...columns.map((section, i) => Math.ceil(colorsAt(section, band).length / colsOf[i])))
    );

    const rect = (x, y, color) => `<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="${RADIUS}" fill="${color}"/>`;
    const text = (x, y, content) =>
        `<text x="${x}" y="${y}" font-family="${FONT_FAMILY}" font-size="${FONT_SIZE}" letter-spacing="${LETTER_SPACING}" fill="${FONT_COLOR}">${escapeXml(content.toUpperCase())}</text>`;

    const parts = [];
    const top = PADDING + (showSections ? HEADER_HEIGHT : 0);
    const bandY = [];
    let y = top;
    bands.forEach((band, b) => {
        bandY.push(y);
        y += rowsOf[b] * STEP - GAP + BAND_GAP;
    });
    const gridBottom = y - BAND_GAP;

    let x = PADDING;
    columns.forEach((section, i) => {
        if (section !== null) parts.push(text(x, PADDING + FONT_SIZE, section));
        bands.forEach((band, b) => {
            colorsAt(section, band).forEach((color, k) => {
                parts.push(rect(x + (k % colsOf[i]) * STEP, bandY[b] + Math.floor(k / colsOf[i]) * STEP, color));
            });
        });
        x += colsOf[i] * STEP - GAP + SECTION_GAP;
    });
    const gridRight = x - SECTION_GAP;

    let width = gridRight + PADDING;
    if (showSplit) {
        bands.forEach((band, b) => parts.push(text(gridRight + LABEL_GAP, bandY[b] + CELL - 1, band)));
        width = gridRight + LABEL_GAP + Math.ceil(Math.max(...bands.map((band) => band.length)) * CHAR_WIDTH) + PADDING;
    }
    const height = gridBottom + PADDING;

    return (
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
        parts.join('') +
        '</svg>'
    );
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
