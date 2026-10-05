const core = require('@actions/core');
const glob = require('@actions/glob');
const { parseReports } = require('./junit');
const { listJobs, findJob, collectFailedJobs, findPullRequest, upsertComment } = require('./github');
const { renderMarkdown, renderSlack } = require('./render');
const { renderMatrixPng } = require('./image');
const { publishAsset } = require('./assets');
const { analyze } = require('./ai');

const SERVER_URL = process.env.GITHUB_SERVER_URL || 'https://github.com';
const REPOSITORY = process.env.GITHUB_REPOSITORY;
const RUN_ID = process.env.GITHUB_RUN_ID;
const SHA = process.env.GITHUB_SHA;

async function run() {
    const patterns = core.getInput('reports', { required: true });
    const title = core.getInput('title') || 'Tests';
    const token = core.getInput('github-token', { required: true });
    const jobsFilter = new RegExp(core.getInput('jobs-filter') || '.*');
    const stepSummary = core.getBooleanInput('step-summary');
    const prComment = core.getBooleanInput('pr-comment');
    const webhookUrl = core.getInput('slack-webhook-url');
    const anthropicApiKey = core.getInput('anthropic-api-key');
    const anthropicModel = core.getInput('anthropic-model') || 'claude-opus-5-5';
    const imageBranch = core.getInput('image-branch');
    const imageRetentionDays = Number(core.getInput('image-retention-days') || 30);
    const matrix = { sections: core.getInput('matrix-sections'), split: core.getInput('matrix-split') };
    const dryRun = core.getBooleanInput('dry-run');

    const files = await (await glob.create(patterns)).glob();
    core.info(`Found ${files.length} report file(s)`);
    const groups = parseReports(files, core.info);

    let jobs = [];
    if (RUN_ID) {
        try {
            jobs = await listJobs(token, REPOSITORY, RUN_ID);
        } catch (error) {
            core.warning(`Could not list workflow jobs (needs actions: read): ${error.message}`);
        }
    }
    for (const group of groups) {
        group.job = findJob(jobs, group.label, jobsFilter) || null;
        if (!group.job) core.info(`No workflow job matches report "${group.label}"`);
    }
    const failedJobs = collectFailedJobs(jobs, groups, jobsFilter);

    const totals = { total: 0, passed: 0, failed: 0, skipped: 0, flaky: 0 };
    for (const group of groups) {
        totals.total += group.total;
        totals.passed += group.passed;
        totals.failed += group.failed;
        totals.skipped += group.skipped;
        totals.flaky += group.flaky;
    }

    // Wall-clock time of the run's test jobs, and the sum of all test durations.
    const timedJobs = jobs.filter((j) => j.status === 'completed' && j.started_at && j.completed_at && jobsFilter.test(j.name));
    const timing = { wall: 0, tests: groups.reduce((sum, g) => sum + g.time, 0) };
    if (timedJobs.length > 0) {
        const started = Math.min(...timedJobs.map((j) => Date.parse(j.started_at)));
        const completed = Math.max(...timedJobs.map((j) => Date.parse(j.completed_at)));
        timing.wall = (completed - started) / 1000;
    }

    let imageUrl = '';
    if (imageBranch && groups.length > 0) {
        try {
            const png = await renderMatrixPng(groups, matrix);
            const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'tests';
            const file = `${new Date().toISOString().slice(0, 10)}/${RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT || 1}-${slug}.png`;
            if (dryRun) {
                core.info(`Dry run; test matrix image (${png.length} bytes) not published as ${file}`);
            } else {
                imageUrl = await publishAsset({
                    token,
                    repository: REPOSITORY,
                    branch: imageBranch,
                    path: file,
                    content: png,
                    retentionDays: imageRetentionDays,
                });
                core.info(`Published test matrix image to ${imageUrl}`);
            }
        } catch (error) {
            core.warning(`Could not publish test matrix image (needs contents: write): ${error.message}`);
        }
    }

    let pullRequest = null;
    try {
        pullRequest = await findPullRequest(token, REPOSITORY, SHA);
    } catch (error) {
        core.warning(`Could not resolve pull request: ${error.message}`);
    }

    const context = {
        runUrl: RUN_ID ? `${SERVER_URL}/${REPOSITORY}/actions/runs/${RUN_ID}` : '',
        runNumber: process.env.GITHUB_RUN_NUMBER,
        runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT || 1),
        branch: process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || '',
        sha: SHA || '',
        commitUrl: SHA ? `${SERVER_URL}/${REPOSITORY}/commit/${SHA}` : '',
        pullRequest,
    };

    let analysis = '';
    if (anthropicApiKey && (totals.failed > 0 || failedJobs.length > 0)) {
        try {
            analysis = await analyze({ apiKey: anthropicApiKey, model: anthropicModel, groups, failedJobs, log: core.info });
        } catch (error) {
            core.warning(`Analysis unavailable: ${error.message}`);
        }
    }

    const marker = `<!-- cedana-test-summary: ${title} -->`;
    const report = { title, groups, totals, failedJobs, analysis, context, marker, imageUrl, timing };
    const markdown = renderMarkdown(report);
    const payload = renderSlack(report);
    const conclusion = totals.failed > 0 || failedJobs.length > 0 ? 'failure' : 'success';

    core.setOutput('conclusion', conclusion);
    core.setOutput('passed', totals.passed);
    core.setOutput('failed', totals.failed);
    core.setOutput('skipped', totals.skipped);
    core.setOutput('markdown', markdown);
    core.setOutput('payload', JSON.stringify(payload));
    core.setOutput('image-url', imageUrl);
    core.info(
        `${title}: ${totals.passed} passed, ${totals.failed} failed, ${totals.skipped} skipped, ${totals.flaky} flaky, ${failedJobs.length} failed job(s)`
    );

    if (stepSummary) {
        await core.summary.addRaw(markdown, true).write();
    }

    if (dryRun) {
        core.info('Dry run; nothing posted. Markdown:');
        core.info(markdown);
        core.info('Slack payload:');
        core.info(JSON.stringify(payload, null, 2));
        return;
    }

    if (prComment) {
        if (pullRequest) {
            await upsertComment(token, REPOSITORY, pullRequest.number, marker, markdown);
            core.info(`Posted summary to pull request #${pullRequest.number}`);
        } else {
            core.info('No pull request for this run; skipping comment');
        }
    }

    if (webhookUrl) {
        const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const responseText = await response.text();
        if (!response.ok) {
            throw new Error(`Slack webhook returned ${response.status}: ${responseText}`);
        }
        core.info('Posted summary to Slack');
    }
}

run().catch((error) => core.setFailed(error.message));
