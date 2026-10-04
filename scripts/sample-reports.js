#!/usr/bin/env node
// Writes a set of fake bats JUnit reports, shaped like cedana's CI, so the
// summary can be previewed without running the real test suite.
//   node scripts/sample-reports.js <output dir>
const fs = require('fs');
const path = require('path');

const out = process.argv[2];
if (!out) {
    console.error('usage: sample-reports.js <output dir>');
    process.exit(1);
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const FAILURE = (file, line, cmd, extra) =>
    `(in test file ${file}, line ${line})\n  \`${cmd}' failed\n${extra}`;

const RESTORE_LOG = [
    '23:21:09 INF restoring GPU interception ID=4ca5b748 plugin=gpu type=process',
    '23:21:09 INF CRIU restore starting operation=restore plugin=CRIU version=40201',
    '23:21:09 DBG CRIU restore options operation=restore opts={"auto_ext_mnt":true,"evasive_devices":true}',
    '23:21:12 DBG GPU controller pool busy=0 free=0 stale=0 target=0',
    '23:21:14 DBG GPU controller exited AttachedPID=19292 ID=3dfee589 PID=19257 status=15',
    '23:21:14 ERR restore failed error="GPU controller exited with status 15" ID=4ca5b748',
].join('\n');

// label -> [{ file, tests: [[name, status, message?, retried?]] }]
function suite(file, count, prefix, overrides = {}) {
    const tests = [];
    for (let i = 0; i < count; i++) {
        const name = `${prefix} ${i + 1}`;
        tests.push([name, ...(overrides[i] || ['passed'])]);
    }
    return { file, tests };
}

const reports = {
    'Basic (amd64)': {
        isolated: [suite('test/regression/dump.bats', 40, 'dump process'), suite('test/regression/restore.bats', 30, 'restore process')],
        persistent: [suite('test/regression/dump.bats', 40, 'dump process'), suite('test/regression/restore.bats', 30, 'restore process')],
    },
    'Basic (arm64)': {
        isolated: [suite('test/regression/dump.bats', 40, 'dump process'), suite('test/regression/restore.bats', 30, 'restore process')],
        persistent: [suite('test/regression/dump.bats', 40, 'dump process'), suite('test/regression/restore.bats', 30, 'restore process')],
    },
    'Plugin (runc, amd64)': {
        isolated: [suite('test/regression/plugins/runc.bats', 47, 'run container')],
        persistent: [
            suite('test/regression/plugins/runc.bats', 47, 'run container', {
                12: ['passed', '', true], // retried once, then passed: flaky
            }),
        ],
    },
    'Plugin (runc, arm64)': { isolated: [suite('test/regression/plugins/runc.bats', 47, 'run container')], persistent: [suite('test/regression/plugins/runc.bats', 47, 'run container')] },
    'Plugin (crun, amd64)': { isolated: [suite('test/regression/plugins/crun.bats', 47, 'run container')], persistent: [suite('test/regression/plugins/crun.bats', 47, 'run container')] },
    'Plugin (crun, arm64)': { isolated: [suite('test/regression/plugins/crun.bats', 47, 'run container')], persistent: [suite('test/regression/plugins/crun.bats', 47, 'run container')] },
    'Plugin (containerd, amd64)': { isolated: [suite('test/regression/plugins/containerd.bats', 17, 'containerd')], persistent: [suite('test/regression/plugins/containerd.bats', 17, 'containerd')] },
    'Plugin (storage/cedana, amd64)': { isolated: [suite('test/regression/plugins/storage_cedana.bats', 13, 'remote dump')], persistent: [suite('test/regression/plugins/storage_cedana.bats', 13, 'remote dump')] },
    'Plugin (storage/s3, amd64)': { isolated: [suite('test/regression/plugins/storage_s3.bats', 13, 'remote dump')], persistent: [suite('test/regression/plugins/storage_s3.bats', 13, 'remote dump')] },
    'Streamer (CPU, amd64)': { isolated: [suite('test/regression/plugins/streamer.bats', 57, 'stream dump')], persistent: [suite('test/regression/plugins/streamer.bats', 57, 'stream dump')] },
    'Streamer (CPU, arm64)': { isolated: [suite('test/regression/plugins/streamer.bats', 57, 'stream dump')], persistent: [suite('test/regression/plugins/streamer.bats', 57, 'stream dump')] },
    'CUDA (12-8, default, amd64)': { isolated: [suite('test/regression/plugins/gpu.bats', 58, '[NVIDIA T4, CUDA 12.8] dump GPU process')], persistent: [suite('test/regression/plugins/gpu.bats', 58, '[NVIDIA T4, CUDA 12.8] dump GPU process')] },
    'CUDA (13-2, default, amd64)': { isolated: [suite('test/regression/plugins/gpu.bats', 58, '[NVIDIA T4, CUDA 13.2] dump GPU process')], persistent: [suite('test/regression/plugins/gpu.bats', 59, '[NVIDIA T4, CUDA 13.2] dump GPU process')] },
    'CUDA (13-2, streamer, arm64)': {
        isolated: [suite('test/regression/plugins/gpu_streamer.bats', 24, '[NVIDIA T4G, CUDA 13.2] stream dump GPU process')],
        persistent: [
            suite('test/regression/plugins/gpu_streamer_storage_cedana.bats', 12, '[NVIDIA T4G, CUDA 13.2] remote stream restore GPU process', {
                4: ['failed', FAILURE('test/regression/plugins/gpu_streamer_storage_cedana.bats', 83, 'cedana restore job "$jid"', RESTORE_LOG)],
                7: ['failed', FAILURE('test/regression/plugins/gpu_streamer_storage_cedana.bats', 106, 'cedana restore job "$jid"', RESTORE_LOG)],
                9: ['failed', FAILURE('test/regression/plugins/gpu_streamer_storage_cedana.bats', 134, 'wait_for_file "$pid_file"', 'timed out after 60s waiting for /tmp/restore.pid')],
            }),
            suite('test/regression/plugins/gpu_streamer_storage_s3.bats', 12, '[NVIDIA T4G, CUDA 13.2] remote (S3) stream restore GPU process', {
                4: ['failed', FAILURE('test/regression/plugins/gpu_streamer_storage_s3.bats', 83, 'cedana restore job "$jid"', RESTORE_LOG)],
            }),
        ],
    },
    'Kubernetes (EKS, CPU, default, storage/cedana, arm64)': { report: [suite('test/k8s/checkpoint.bats', 8, 'checkpoint pod')] },
    'Kubernetes (EKS, CPU, default, storage/s3, arm64)': { report: [suite('test/k8s/checkpoint.bats', 8, 'checkpoint pod')] },
    'Kubernetes (GKE, CPU, streamer, storage/cedana, amd64)': { report: [suite('test/k8s/checkpoint.bats', 8, 'checkpoint pod')] },
    'Kubernetes (K3s, CPU, default, storage/local, arm64)': { report: [suite('test/k8s/checkpoint.bats', 8, 'checkpoint pod', { 7: ['skipped', 'not supported on K3s'] })] },
    'Kubernetes (K3s, CPU, streamer, storage/local, arm64)': { report: [suite('test/k8s/checkpoint.bats', 8, 'checkpoint pod', { 7: ['skipped', 'not supported on K3s'] })] },
    'Kubernetes (Nebius, CUDA, default, storage/local, amd64)': {
        report: [
            suite('test/k8s/gpu.bats', 12, 'checkpoint GPU pod', {
                3: ['failed', FAILURE('test/k8s/gpu.bats', 212, 'kubectl wait --for=condition=Ready pod/$pod --timeout=300s', 'error: timed out waiting for the condition on pods/vllm-7f9c')],
            }),
        ],
    },
    'Slurm (Ansible)': { report: [suite('test/slurm/ansible.bats', 45, 'ansible')] },
    'Slurm (CPU, slurm-24-11-5-1, unpriv=0, no_root_squash)': { samples: [suite('test/slurm/samples.bats', 4, 'sample job')], preemption: [suite('test/slurm/preemption.bats', 2, 'preempt job')] },
    'Slurm (CPU, slurm-25-05-9-1, unpriv=0, no_root_squash)': { samples: [suite('test/slurm/samples.bats', 4, 'sample job')], preemption: [suite('test/slurm/preemption.bats', 2, 'preempt job')] },
    'Slurm (CPU, slurm-26-05-4-1, unpriv=0, no_root_squash)': { samples: [suite('test/slurm/samples.bats', 4, 'sample job')], preemption: [suite('test/slurm/preemption.bats', 2, 'preempt job')] },
    'Slurm (CPU, slurm-26-05-4-1, unpriv=1, root_squash)': { samples: [suite('test/slurm/samples.bats', 4, 'sample job')], preemption: [suite('test/slurm/preemption.bats', 2, 'preempt job')], unprivileged: [suite('test/slurm/unprivileged.bats', 3, 'unprivileged job')] },
    'Slurm (CUDA, slurm-26-05-4-1, unpriv=0, no_root_squash)': { samples: [suite('test/slurm/samples.bats', 3, 'sample GPU job', { 1: ['skipped', 'needs 2 GPUs'], 2: ['skipped', 'needs 2 GPUs'] })] },
};

function testcaseXml(file, [name, status, message = '', retried = false]) {
    const head = `    <testcase classname="${esc(file)}" name="${esc(name)}" time="${(Math.random() * 5 + 0.5).toFixed(3)}"`;
    const attempts = [];
    if (retried) attempts.push(`${head}>\n        <failure type="failure"></failure>\n    </testcase>`);
    if (status === 'passed') attempts.push(`${head} />`);
    if (status === 'failed') attempts.push(`${head}>\n        <failure type="failure">${esc(message)}</failure>\n    </testcase>`);
    if (status === 'skipped') attempts.push(`${head}>\n        <skipped>${esc(message)}</skipped>\n    </testcase>`);
    return attempts.join('\n');
}

let n = 0;
for (const [label, files] of Object.entries(reports)) {
    const dir = path.join(out, `test-report-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`);
    fs.mkdirSync(dir, { recursive: true });
    for (const [variant, suites] of Object.entries(files)) {
        const body = suites
            .map((s) => {
                const failures = s.tests.filter((t) => t[1] === 'failed').length;
                const skipped = s.tests.filter((t) => t[1] === 'skipped').length;
                const time = (s.tests.length * 2.3).toFixed(3);
                return (
                    `<testsuite name="${esc(s.file)}" tests="${s.tests.length}" failures="${failures}" errors="0" skipped="${skipped}" time="${time}" timestamp="2026-10-04T00:00:00" hostname="sample">\n` +
                    s.tests.map((t) => testcaseXml(s.file, t)).join('\n') +
                    '\n</testsuite>'
                );
            })
            .join('\n');
        const total = suites.reduce((sum, s) => sum + s.tests.length * 2.3, 0).toFixed(3);
        const file = variant === 'report' ? 'report.xml' : `report-${variant}.xml`;
        fs.writeFileSync(
            path.join(dir, file),
            `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="${esc(label)}" time="${total}">\n${body}\n</testsuites>\n`
        );
        n++;
    }
}
console.log(`Wrote ${n} sample reports for ${Object.keys(reports).length} suites to ${out}`);
