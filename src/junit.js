const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    alwaysCreateTextNode: true,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: false,
    isArray: (name) => name === 'testsuite' || name === 'testcase',
});

// The parser decodes named entities but leaves numeric ones (bats emits &#39;).
function decodeEntities(value) {
    return value
        .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

// Strip ANSI color codes, including ones whose escape byte was already dropped ("[90m").
function stripAnsi(value) {
    return value.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\[(\d{1,3}(;\d{1,3})*)?m/g, '');
}

function text(node) {
    if (node == null) return '';
    if (typeof node === 'string') return stripAnsi(decodeEntities(node));
    if (Array.isArray(node)) return node.map(text).join('\n');
    return stripAnsi(decodeEntities(node['#text'] || ''));
}

function number(value) {
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : 0;
}

// bats names suites after the test file, e.g. "test/regression/dump.bats".
function shortSuite(name) {
    return path.basename(name || '') || name || '';
}

// "report-persistent.xml" -> "persistent", "report.xml" -> "".
function variantOf(file) {
    return path.basename(file, path.extname(file)).replace(/^report-?/, '');
}

// Parse a single JUnit XML file into { label, variant, time, tests }, or null
// when the file is empty or truncated (a job cancelled while bats was running).
// The label is the <testsuites name="..."> attribute, falling back to the
// parent directory name (the artifact name, when downloaded with actions/download-artifact).
function parseReport(file) {
    const doc = parser.parse(fs.readFileSync(file, 'utf8'));
    if (!doc.testsuites && !doc.testsuite) return null;
    const root = doc.testsuites || { testsuite: doc.testsuite };
    const label = (root.name || '').trim() || path.basename(path.dirname(file));
    const variant = variantOf(file);
    // Retried tests (BATS_TEST_RETRIES) appear once per attempt; keep one entry
    // per test with the last attempt's status, flagged as flaky if it recovered.
    const tests = new Map();
    let time = 0;

    for (const suite of root.testsuite || []) {
        time += number(suite.time);
        for (const testcase of suite.testcase || []) {
            const failure = testcase.failure ?? testcase.error;
            let status = 'passed';
            let message = '';
            if (failure !== undefined) {
                status = 'failed';
                message = text(failure).trim();
            } else if (testcase.skipped !== undefined) {
                status = 'skipped';
                message = text(testcase.skipped).trim();
            }
            const suiteName = shortSuite(suite.name || testcase.classname);
            const name = (testcase.name || '').trim();
            const key = `${suiteName}\n${name}`;
            const previous = tests.get(key);
            if (previous) {
                previous.attempts += 1;
                previous.flaky = previous.flaky || (previous.status === 'failed' && status === 'passed');
                previous.status = status;
                if (message.length > previous.message.length) previous.message = message;
                previous.time += number(testcase.time);
            } else {
                tests.set(key, {
                    suite: suiteName,
                    name,
                    status,
                    message,
                    time: number(testcase.time),
                    variant,
                    attempts: 1,
                    flaky: false,
                });
            }
        }
    }

    return { label, variant, time, tests: [...tests.values()] };
}

// Parse all files and group them by label. Each group aggregates every report
// file that shares the label (e.g. the isolated and persistent runs of one job).
function parseReports(files, log = () => {}) {
    const groups = new Map();
    for (const file of files) {
        const report = parseReport(file);
        if (!report) {
            log(`Skipping empty or truncated report ${file}`);
            continue;
        }
        let group = groups.get(report.label);
        if (!group) {
            group = { label: report.label, files: [], variants: new Set(), tests: [], time: 0 };
            groups.set(report.label, group);
        }
        group.files.push(file);
        group.variants.add(report.variant);
        group.tests.push(...report.tests);
        group.time += report.time;
    }

    const result = [];
    for (const group of groups.values()) {
        const count = (status) => group.tests.filter((t) => t.status === status).length;
        result.push({
            label: group.label,
            files: group.files,
            // Only distinguish variants when a label has more than one report file.
            multiVariant: group.variants.size > 1,
            tests: group.tests,
            time: group.time,
            total: group.tests.length,
            passed: count('passed'),
            failed: count('failed'),
            skipped: count('skipped'),
            flaky: group.tests.filter((t) => t.flaky).length,
        });
    }
    return result;
}

module.exports = { parseReport, parseReports };
