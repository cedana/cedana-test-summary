const fs = require('fs');
const path = require('path');
const { Resvg, initWasm } = require('@resvg/resvg-wasm');

// Contribution-graph style matrix: one rounded square per test, laid out row
// by row in suite order, so failures cluster where their suite is. Optionally
// divided into labelled bands (sections) and side-by-side columns (split).
const CELL = 10;
const GAP = 3;
const STEP = CELL + GAP;
const RADIUS = 2;
const PADDING = 2;
const MIN_COLS = 12;
const MAX_COLS = 80;
const MIN_SPLIT_COLS = 8;
const MAX_SPLIT_COLS = 40;
const SCALE = 2;

const FONT_FAMILY = 'Inter';
const FONT_SIZE = 11;
const FONT_COLOR = '#8b949e';
const CHAR_WIDTH = FONT_SIZE * 0.58; // rough average advance for Inter
const LABEL_GAP = 10; // between a band label and its squares
const HEADER_HEIGHT = 18; // split column labels above the first band
const BAND_GAP = 14;
const SPLIT_GAP = 2 * STEP;

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

function colsFor(count, min, max) {
    return Math.min(max, Math.max(min, Math.ceil(Math.sqrt(count * 3))));
}

function layout(count) {
    const cols = colsFor(count, MIN_COLS, MAX_COLS);
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

    // cells: section label -> split label -> colors, in suite order.
    const cells = new Map();
    const sectionCounts = new Map();
    const splitCounts = new Map();
    for (const group of [...groups].sort((a, b) => a.label.localeCompare(b.label))) {
        const section = sectionBuckets.length > 0 ? bucketOf(sectionBuckets, group.label) : '';
        const column = splitBuckets.length > 0 ? bucketOf(splitBuckets, group.label) : '';
        if (!cells.has(section)) cells.set(section, new Map());
        const row = cells.get(section);
        if (!row.has(column)) row.set(column, []);
        row.get(column).push(...group.tests.map(cellColor));
        sectionCounts.set(section, (sectionCounts.get(section) || 0) + group.tests.length);
        splitCounts.set(column, (splitCounts.get(column) || 0) + group.tests.length);
    }

    let bands = activeBuckets(sectionBuckets, sectionCounts);
    let columns = activeBuckets(splitBuckets, splitCounts);
    const showSections = bands.length > 1;
    const showSplit = columns.length > 1;
    if (!showSections) bands = [...sectionCounts.keys()].filter((s) => sectionCounts.get(s) > 0).slice(0, 1);
    if (!showSplit) columns = [...splitCounts.keys()].filter((c) => splitCounts.get(c) > 0).slice(0, 1);
    const colorsAt = (band, column) => {
        if (showSections && showSplit) return cells.get(band)?.get(column) || [];
        // Collapsed dimension: merge everything along it, preserving suite order.
        const out = [];
        for (const [s, row] of cells) {
            if (showSections && s !== band) continue;
            for (const [c, colors] of row) {
                if (showSplit && c !== column) continue;
                out.push(...colors);
            }
        }
        return out;
    };

    let largest = 0;
    for (const band of bands) for (const column of columns) largest = Math.max(largest, colorsAt(band, column).length);
    const cols = showSplit ? colsFor(largest, MIN_SPLIT_COLS, MAX_SPLIT_COLS) : colsFor(largest, MIN_COLS, MAX_COLS);
    const gridWidth = cols * STEP - GAP;

    const gutter = showSections ? Math.ceil(Math.max(...bands.map((b) => b.length)) * CHAR_WIDTH) + LABEL_GAP : 0;
    const top = showSplit ? HEADER_HEIGHT : 0;
    const columnX = (i) => PADDING + gutter + i * (gridWidth + SPLIT_GAP);
    const width = columnX(columns.length - 1) + gridWidth + PADDING;

    const text = (x, y, content, anchor = 'start') =>
        `<text x="${x}" y="${y}" font-family="${FONT_FAMILY}" font-size="${FONT_SIZE}" fill="${FONT_COLOR}" text-anchor="${anchor}">${escapeXml(content)}</text>`;

    const parts = [];
    if (showSplit) {
        columns.forEach((column, i) => parts.push(text(columnX(i), PADDING + FONT_SIZE, column)));
    }

    let y = PADDING + top;
    bands.forEach((band, bandIndex) => {
        if (bandIndex > 0) y += BAND_GAP;
        let rows = 1;
        columns.forEach((column, i) => {
            const colors = colorsAt(band, column);
            rows = Math.max(rows, Math.ceil(colors.length / cols));
            colors.forEach((color, k) => {
                const x = columnX(i) + (k % cols) * STEP;
                const cy = y + Math.floor(k / cols) * STEP;
                parts.push(`<rect x="${x}" y="${cy}" width="${CELL}" height="${CELL}" rx="${RADIUS}" fill="${color}"/>`);
            });
        });
        if (showSections) parts.push(text(PADDING + gutter - LABEL_GAP, y + CELL - 1, band, 'end'));
        y += rows * STEP - GAP;
    });
    const height = y + PADDING;

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
