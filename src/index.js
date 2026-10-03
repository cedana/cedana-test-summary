const core = require('@actions/core');
const glob = require('@actions/glob');
const { parseReports } = require('./junit');
const { listJobs, findJob, findPullRequest, upsertComment } = require('./github');
const { renderMarkdown, renderSlack } = require('./render');
const { analyze } = require('./ai');

const SERVER_URL = process.env.GITHUB_SERVER_URL || 'https://github.com';
const REPOSITORY = process.env.GITHUB_REPOSITORY;
const RUN_ID = process.env.GITHUB_RUN_ID;
const SHA = process.env.GITHUB_SHA;

// Jobs that failed, grouped with the reason the summary cares about: no test
// report was produced (crashed, timed out, failed before tests ran), or the
// tests all passed but the job still failed.
function collectFailedJobs(jobs, groups, filter) {
    const reported = new Map();
    for (const group of groups) {
        if (group.job) reported.set(group.job.id, group);
    }
    const failed = [];
    for (const job of jobs) {
        if (job.status !== 'completed' || !['failure', 'cancelled', 'timed_out'].includes(job.conclusion)) continue;
        if (!filter.test(job.name)) continue;
        const group = reported.get(job.id);
        if (group && group.failed > 0) continue;
        const outcome = job.conclusion === 'failure' ? 'failed' : job.conclusion.replace('_', ' ');
        failed.push({
            id: job.id,
            // Drop the caller prefixes of reusable workflows ("Test / GPU / CUDA (...)").
            name: job.name.split(' / ').pop(),
            html_url: job.html_url,
            conclusion: job.conclusion,
            reason: group ? `tests passed, job ${outcome}` : `${outcome} without a test report`,
        });
    }
    return failed.sort((a, b) => a.name.localeCompare(b.name));
}

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
    const dryRun = core.getBooleanInput('dry-run');

    const files = await (await glob.create(patterns)).glob();
    core.info(`Found ${files.length} report file(s)`);
    const groups = parseReports(files);

    let jobs = [];
    if (RUN_ID) {
        try {
            jobs = await listJobs(token, REPOSITORY, RUN_ID);
        } catch (error) {
            core.warning(`Could not list workflow jobs (needs actions: read): ${error.message}`);
        }
    }
    for (const group of groups) {
        group.job = findJob(jobs, group.label) || null;
        if (!group.job) core.info(`No workflow job matches report "${group.label}"`);
    }
    const failedJobs = collectFailedJobs(jobs, groups, jobsFilter);

    const totals = { total: 0, passed: 0, failed: 0, skipped: 0 };
    for (const group of groups) {
        totals.total += group.total;
        totals.passed += group.passed;
        totals.failed += group.failed;
        totals.skipped += group.skipped;
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
    const report = { title, groups, totals, failedJobs, analysis, context, marker };
    const markdown = renderMarkdown(report);
    const payload = renderSlack(report);
    const conclusion = totals.failed > 0 || failedJobs.length > 0 ? 'failure' : 'success';

    core.setOutput('conclusion', conclusion);
    core.setOutput('passed', totals.passed);
    core.setOutput('failed', totals.failed);
    core.setOutput('skipped', totals.skipped);
    core.setOutput('markdown', markdown);
    core.setOutput('payload', JSON.stringify(payload));
    core.info(`${title}: ${totals.passed} passed, ${totals.failed} failed, ${totals.skipped} skipped, ${failedJobs.length} failed job(s)`);

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
