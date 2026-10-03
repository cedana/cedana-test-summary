const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const { parseReports } = require('../src/junit');
const { renderMarkdown, renderSlack, duration } = require('../src/render');
const { findJob } = require('../src/github');
const { describeFailures } = require('../src/ai');

const fixtures = path.join(__dirname, 'fixtures');
const files = fs
    .readdirSync(fixtures, { recursive: true })
    .filter((f) => f.endsWith('.xml'))
    .map((f) => path.join(fixtures, f))
    .sort();

const jobs = [
    { id: 1, name: 'Test / Basic (amd64)', status: 'completed', conclusion: 'failure', html_url: 'https://gh/job/1' },
    { id: 2, name: 'Test / Plugin (runc, amd64)', status: 'completed', conclusion: 'success', html_url: 'https://gh/job/2' },
    { id: 3, name: 'Test / Unit (amd64)', status: 'completed', conclusion: 'failure', html_url: 'https://gh/job/3' },
    { id: 4, name: 'Test / Post Summary', status: 'in_progress', conclusion: null, html_url: 'https://gh/job/4' },
    { id: 5, name: 'Bench / Run (x)', status: 'completed', conclusion: 'failure', html_url: 'https://gh/job/5' },
];

function report() {
    const groups = parseReports(files);
    for (const group of groups) group.job = findJob(jobs, group.label) || null;
    const totals = { passed: 0, failed: 0, skipped: 0 };
    for (const g of groups) {
        totals.passed += g.passed;
        totals.failed += g.failed;
        totals.skipped += g.skipped;
    }
    const failedJobs = [{ name: 'Test / Unit (amd64)', html_url: 'https://gh/job/3', conclusion: 'failure', reason: 'failed without a test report' }];
    const context = { runUrl: 'https://gh/run/1', runNumber: 7, runAttempt: 1, branch: 'main', sha: 'abcdef1234', commitUrl: 'https://gh/c' };
    return { title: 'Tests', groups, totals, failedJobs, analysis: '', context, marker: '<!-- m -->' };
}

test('parses and groups bats JUnit reports by testsuites name', () => {
    const groups = parseReports(files);
    assert.equal(groups.length, 2);

    const basic = groups.find((g) => g.label === 'Basic (amd64)');
    assert.equal(basic.files.length, 2);
    assert.equal(basic.multiVariant, true);
    assert.deepEqual([basic.total, basic.passed, basic.failed, basic.skipped], [6, 4, 1, 1]);
    assert.equal(basic.time, 21.5);

    const failed = basic.tests.find((t) => t.status === 'failed');
    assert.equal(failed.suite, 'dump.bats');
    assert.equal(failed.variant, 'persistent');
    assert.match(failed.message, /`\[ "\$status" -eq 0 \]' failed/);
    assert.match(failed.message, /connection refused <tcp>/);

    // Without a name attribute, the label falls back to the directory (artifact) name.
    const runc = groups.find((g) => g.label === 'test-report-amd64-runc');
    assert.equal(runc.multiVariant, false);
    assert.deepEqual([runc.total, runc.passed], [2, 2]);
});

test('matches report labels to nested workflow job names', () => {
    assert.equal(findJob(jobs, 'Basic (amd64)').id, 1);
    assert.equal(findJob(jobs, 'Plugin (runc, amd64)').id, 2);
    assert.equal(findJob(jobs, 'Basic'), undefined);
});

test('renders markdown with failures first, links, and the marker', () => {
    const md = renderMarkdown(report());
    assert.ok(md.startsWith('<!-- m -->\n## ❌ Tests'));
    assert.match(md, /\*\*1 failed\*\* · 6 passed · 1 skipped · 2 suites/);
    assert.match(md, /<summary>❌ <b>Basic \(amd64\)<\/b> · 1 of 6 failed · <a href="https:\/\/gh\/job\/1">logs<\/a><\/summary>/);
    assert.match(md, /\*\*dump\.bats › dump process \(tcp\)\*\* _persistent_/);
    assert.match(md, /connection refused <tcp>/);
    assert.match(md, /### Failed jobs\n\n- \[Test \/ Unit \(amd64\)\]\(https:\/\/gh\/job\/3\) — failed without a test report/);
    assert.match(md, /\| ❌ \[Basic \(amd64\)\]\(https:\/\/gh\/job\/1\) \| 4 \| 1 \| 1 \| 22s \|/);
    assert.match(md, /Run \[#7\]\(https:\/\/gh\/run\/1\) · `main` · \[abcdef1\]/);
});

test('renders a compact passing summary', () => {
    const r = report();
    r.groups = r.groups.filter((g) => g.failed === 0);
    r.totals = { passed: 2, failed: 0, skipped: 0 };
    r.failedJobs = [];
    const md = renderMarkdown(r);
    assert.match(md, /## ✅ Tests\n\n2 passed · 1 suite/);
    assert.doesNotMatch(md, /### Failures/);
});

test('renders Slack blocks within limits', () => {
    const r = report();
    r.analysis = '- **dump.bats** fails on `connection refused`\n- Unit job crashed';
    const { blocks } = renderSlack(r);
    assert.equal(blocks[0].type, 'header');
    assert.equal(blocks[0].text.text, ':x: Tests');
    assert.equal(blocks[1].accessory.url, 'https://gh/run/1');
    assert.match(blocks[1].text.text, /^\*1 failed\* · 6 passed/);
    const failing = blocks.find((b) => b.text?.text.startsWith(':x: *<https://gh/job/1|Basic (amd64)>*'));
    assert.match(failing.text.text, /• dump\.bats › dump process \(tcp\) _persistent_/);
    const analysis = blocks.find((b) => b.text?.text.startsWith(':robot_face:'));
    assert.match(analysis.text.text, /\*dump\.bats\*.*fails on `connection refused`/);
    assert.equal(blocks.at(-1).type, 'context');
    assert.ok(blocks.length <= 50);
});

test('describes failures for analysis', () => {
    const r = report();
    const text = describeFailures(r.groups, r.failedJobs);
    assert.match(text, /^### Basic \(amd64\) › dump\.bats › dump process \(tcp\) \(persistent\)\n\(in test file/m);
    assert.match(text, /### Job Test \/ Unit \(amd64\): failure, failed without a test report/);
});

test('formats durations', () => {
    assert.equal(duration(0.4), '');
    assert.equal(duration(45), '45s');
    assert.equal(duration(723), '12m 3s');
    assert.equal(duration(3600), '1h');
    assert.equal(duration(3725), '1h 2m');
});
