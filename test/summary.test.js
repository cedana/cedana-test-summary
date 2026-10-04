const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const { parseReports } = require('../src/junit');
const { renderMarkdown, renderSlack, duration } = require('../src/render');
const { renderMatrixSvg, renderMatrixPng, layout, COLORS } = require('../src/image');
const { findJob, collectFailedJobs } = require('../src/github');
const { describeFailures } = require('../src/ai');

const fixtures = path.join(__dirname, 'fixtures');
const files = fs
    .readdirSync(fixtures, { recursive: true })
    .filter((f) => f.endsWith('.xml'))
    .map((f) => path.join(fixtures, f))
    .sort();

const jobs = [
    { id: 1, name: 'Test / Basic (amd64)', status: 'completed', conclusion: 'failure', html_url: 'https://gh/job/1', steps: [{ status: 'completed', conclusion: 'success' }] },
    { id: 2, name: 'Test / Plugin (runc, amd64)', status: 'completed', conclusion: 'success', html_url: 'https://gh/job/2', steps: [{ status: 'completed', conclusion: 'success' }] },
    { id: 3, name: 'Test / Unit (amd64)', status: 'completed', conclusion: 'failure', html_url: 'https://gh/job/3', steps: [{ status: 'completed', conclusion: 'success' }] },
    { id: 4, name: 'Test / Post Summary', status: 'in_progress', conclusion: null, html_url: 'https://gh/job/4', runner_name: 'me', steps: [] },
    { id: 5, name: 'Bench / Run (x)', status: 'completed', conclusion: 'failure', html_url: 'https://gh/job/5', steps: [{ status: 'completed', conclusion: 'success' }] },
    { id: 6, name: 'Test / GPU / CUDA (13-2, streamer, arm64)', status: 'completed', conclusion: 'failure', html_url: 'https://gh/job/6', steps: [{ status: 'completed', conclusion: 'success' }] },
    { id: 7, name: 'Test / Kubernetes / Post Summary', status: 'completed', conclusion: 'cancelled', html_url: 'https://gh/job/7', steps: [] },
    { id: 8, name: 'Test / Kubernetes / Kubernetes (GKE, CPU, streamer, storage/s3, amd64)', status: 'completed', conclusion: 'cancelled', html_url: 'https://gh/job/8', steps: [{ status: 'completed', conclusion: 'success' }] },
    { id: 9, name: 'Test / Slurm / Slurm (CPU, x)', status: 'completed', conclusion: 'cancelled', html_url: 'https://gh/job/9', steps: [] },
];

function report() {
    const groups = parseReports(files);
    for (const group of groups) group.job = findJob(jobs, group.label) || null;
    const totals = { passed: 0, failed: 0, skipped: 0, flaky: 0 };
    for (const g of groups) {
        totals.passed += g.passed;
        totals.failed += g.failed;
        totals.skipped += g.skipped;
        totals.flaky += g.flaky;
    }
    const failedJobs = collectFailedJobs(jobs, groups, /^Test \/ /, 'me');
    const context = {
        runUrl: 'https://gh/run/1',
        runNumber: 7,
        runAttempt: 2,
        branch: 'main',
        sha: 'abcdef1234',
        commitUrl: 'https://gh/c',
        pullRequest: { number: 42, url: 'https://gh/pr/42' },
    };
    const timing = { wall: 3725, tests: 14520 };
    return { title: 'Tests', groups, totals, failedJobs, analysis: '', context, marker: '<!-- m -->', imageUrl: 'https://raw/matrix.png', timing };
}

test('parses and groups bats JUnit reports by testsuites name', () => {
    const skipped = [];
    const groups = parseReports(files, (m) => skipped.push(m));
    assert.deepEqual(
        groups.map((g) => g.label).sort(),
        ['Basic (amd64)', 'CUDA (13-2, streamer, arm64)', 'test-report-amd64-runc']
    );
    // Empty files (jobs cancelled mid-run) are skipped rather than reported as 0 tests.
    assert.equal(skipped.length, 1);
    assert.match(skipped[0], /test-report-amd64-k8s-cancelled\/report\.xml/);

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

test('collapses retried tests and flags the ones that recovered as flaky', () => {
    const cuda = parseReports(files).find((g) => g.label === 'CUDA (13-2, streamer, arm64)');
    assert.deepEqual([cuda.total, cuda.passed, cuda.failed, cuda.flaky], [3, 2, 1, 1]);

    const restore = cuda.tests.find((t) => t.name === 'stream restore GPU process');
    assert.equal(restore.status, 'failed');
    assert.equal(restore.attempts, 2);
    assert.equal(restore.flaky, false);
    assert.match(restore.message, /^tags: gpu restore streamer/);
    assert.match(restore.message, /23:21:09 INF restoring GPU interception plugin=gpu/, 'ANSI codes stripped');

    const dump = cuda.tests.find((t) => t.name === 'stream dump GPU container');
    assert.equal(dump.status, 'passed');
    assert.equal(dump.flaky, true);
});

test('matches report labels to nested workflow job names', () => {
    assert.equal(findJob(jobs, 'Basic (amd64)').id, 1);
    assert.equal(findJob(jobs, 'Plugin (runc, amd64)').id, 2);
    assert.equal(findJob(jobs, 'Basic'), undefined);
});

test('lists failed jobs without reports, skipping summary siblings and never-started jobs', () => {
    const { failedJobs } = report();
    assert.deepEqual(
        failedJobs.map((j) => [j.name, j.reason]),
        [
            ['Kubernetes (GKE, CPU, streamer, storage/s3, amd64)', 'cancelled without a test report'],
            ['Unit (amd64)', 'failed without a test report'],
        ]
    );
});

test('renders markdown with failures first, links, and the marker', () => {
    const md = renderMarkdown(report());
    assert.ok(
        md.startsWith(
            '<!-- m -->\n## Tests\n\n❌ **2 failed** · 8 passed · 1 skipped · 1 flaky · 3 suites · **2 failed jobs**\n\n![Test matrix](https://raw/matrix.png)\n'
        ),
        md.slice(0, 200)
    );
    assert.match(md, /<summary>❌ <b>Basic \(amd64\)<\/b> · 1 of 6 failed · <a href="https:\/\/gh\/job\/1">logs<\/a><\/summary>/);
    assert.match(md, /\*\*dump\.bats › dump process \(tcp\)\*\* _persistent_/);
    assert.match(md, /connection refused <tcp>/);
    // Long output keeps the head and the tail.
    assert.match(md, /`cedana restore job "\$jid"' failed\n.*\n… \(6 lines omitted\) …\nline 11\n/);
    assert.match(md, /Error: restore failed: controller exited with status 15\n```/);
    assert.match(md, /### Failed jobs\n\n- \[Kubernetes \(GKE.*\n- \[Unit \(amd64\)\]\(https:\/\/gh\/job\/3\) — failed without a test report/);
    assert.match(md, /<summary>⚠️ 1 flaky test \(passed on retry\)<\/summary>\n\n- \[CUDA \(13-2, streamer, arm64\)\]\(https:\/\/gh\/job\/6\) › gpu\\_streamer\.bats › stream dump GPU container/);
    assert.match(md, /\| ❌ \[Basic \(amd64\)\]\(https:\/\/gh\/job\/1\) \| 4 \| 1 \| 1 \| 22s \|/);
    assert.ok(
        md.endsWith(
            '<sub>[Run #7](https://gh/run/1) · _attempt 2_ · `main` · [abcdef1](https://gh/c) · 1h 2m wall-clock · 4h 2m of tests</sub>'
        ),
        md.slice(-200)
    );
});

test('renders a compact passing summary', () => {
    const r = report();
    r.groups = r.groups.filter((g) => g.label === 'test-report-amd64-runc');
    r.totals = { passed: 2, failed: 0, skipped: 0, flaky: 0 };
    r.failedJobs = [];
    r.imageUrl = '';
    r.timing = { wall: 0, tests: 3 };
    r.context.runAttempt = 1;
    const md = renderMarkdown(r);
    assert.match(md, /## Tests\n\n✅ 2 passed · 1 suite\n\n<details>/);
    assert.doesNotMatch(md, /### Failures/);
    assert.doesNotMatch(md, /flaky|!\[Test matrix\]|attempt|wall-clock/);
    assert.match(md, /<sub>.* · 3s of tests<\/sub>$/);
});

test('renders Slack blocks within limits', () => {
    const r = report();
    r.analysis = '- **dump.bats** fails on `connection refused`\n- Unit job crashed';
    const { blocks } = renderSlack(r);
    assert.equal(blocks[0].type, 'header');
    assert.equal(blocks[0].text.text, 'Tests');
    assert.equal(blocks[1].accessory.url, 'https://gh/run/1');
    assert.match(blocks[1].text.text, /^:x: \*2 failed\* · 8 passed/);
    assert.deepEqual(blocks[2], {
        type: 'image',
        image_url: 'https://raw/matrix.png',
        alt_text: 'Test matrix: 2 failed · 8 passed · 1 skipped · 1 flaky · 3 suites · 2 failed jobs',
    });
    const failing = blocks.find((b) => b.text?.text.startsWith(':x: *<https://gh/job/1|Basic (amd64)>*'));
    assert.match(failing.text.text, /• dump\.bats › dump process \(tcp\) _persistent_/);
    const flaky = blocks.find((b) => b.text?.text.startsWith(':warning: *1 flaky test*'));
    assert.match(flaky.text.text, /• <https:\/\/gh\/job\/6\|CUDA \(13-2, streamer, arm64\)> › gpu_streamer\.bats › stream dump GPU container/);
    const analysis = blocks.find((b) => b.text?.text.startsWith(':robot_face:'));
    assert.match(analysis.text.text, /\*dump\.bats\*.*fails on `connection refused`/);
    assert.deepEqual(
        blocks.at(-1).elements.map((e) => e.text),
        [
            '<https://gh/run/1|Run #7>',
            '_attempt 2_',
            '<https://gh/pr/42|PR #42>',
            '`main`',
            '<https://gh/c|abcdef1>',
            '1h 2m wall-clock',
            '4h 2m of tests',
        ]
    );
    assert.ok(blocks.length <= 50);
});

test('renders the test matrix as one square per test in suite order', async () => {
    const r = report();
    const svg = renderMatrixSvg(r.groups);
    const rects = svg.match(/<rect /g).length;
    assert.equal(rects, 11);
    const fills = [...svg.matchAll(/fill="(#[0-9a-f]{6})"/g)].map((m) => m[1]);
    // Basic (amd64) comes first: isolated run (4 tests, one skipped) then persistent (1 pass, 1 fail).
    assert.deepEqual(fills.slice(0, 6), [COLORS.passed, COLORS.passed, COLORS.skipped, COLORS.passed, COLORS.passed, COLORS.failed]);
    // CUDA: pass, fail, flaky.
    assert.deepEqual(fills.slice(6, 9), [COLORS.passed, COLORS.failed, COLORS.flaky]);
    assert.deepEqual(layout(1500), { cols: 68, rows: 23, width: 885, height: 300 });

    const png = await renderMatrixPng(r.groups);
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});

test('describes failures for analysis', () => {
    const r = report();
    const text = describeFailures(r.groups, r.failedJobs);
    assert.match(text, /^### Basic \(amd64\) › dump\.bats › dump process \(tcp\) \(persistent\)\n\(in test file/m);
    assert.match(text, /### Job Unit \(amd64\): failure, failed without a test report/);
});

test('formats durations', () => {
    assert.equal(duration(0.4), '');
    assert.equal(duration(45), '45s');
    assert.equal(duration(723), '12m 3s');
    assert.equal(duration(3600), '1h');
    assert.equal(duration(3725), '1h 2m');
});
