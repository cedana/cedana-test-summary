const fs = require('fs');
const path = require('path');
const { Resvg, initWasm } = require('@resvg/resvg-wasm');

// Contribution-graph style matrix: one rounded square per test, laid out row
// by row in suite order, so failures cluster where their suite is.
const CELL = 10;
const GAP = 3;
const RADIUS = 2;
const PADDING = 2;
const MIN_COLS = 12;
const MAX_COLS = 80;
const SCALE = 2;

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

function layout(count) {
    const cols = Math.min(MAX_COLS, Math.max(MIN_COLS, Math.ceil(Math.sqrt(count * 3))));
    const rows = Math.max(1, Math.ceil(count / cols));
    return {
        cols,
        rows,
        width: cols * (CELL + GAP) - GAP + PADDING * 2,
        height: rows * (CELL + GAP) - GAP + PADDING * 2,
    };
}

function renderMatrixSvg(groups) {
    const colors = [];
    for (const group of [...groups].sort((a, b) => a.label.localeCompare(b.label))) {
        colors.push(...group.tests.map(cellColor));
    }
    const { cols, width, height } = layout(colors.length);
    const rects = colors.map((color, i) => {
        const x = PADDING + (i % cols) * (CELL + GAP);
        const y = PADDING + Math.floor(i / cols) * (CELL + GAP);
        return `<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="${RADIUS}" fill="${color}"/>`;
    });
    return (
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
        rects.join('') +
        '</svg>'
    );
}

let wasmReady = null;

// The build copies the wasm next to the bundle; from source it lives in node_modules.
function wasmPath() {
    const bundled = path.join(__dirname, 'index_bg.wasm');
    if (fs.existsSync(bundled)) return bundled;
    return path.join(__dirname, '..', 'node_modules', '@resvg', 'resvg-wasm', 'index_bg.wasm');
}

async function svgToPng(svg) {
    if (!wasmReady) {
        wasmReady = initWasm(fs.readFileSync(wasmPath()));
    }
    await wasmReady;
    const resvg = new Resvg(svg, { fitTo: { mode: 'zoom', value: SCALE } });
    return Buffer.from(resvg.render().asPng());
}

async function renderMatrixPng(groups) {
    return svgToPng(renderMatrixSvg(groups));
}

module.exports = { renderMatrixSvg, renderMatrixPng, layout, COLORS };
