const fs = require('fs');

const API_URL = process.env.GITHUB_API_URL || 'https://api.github.com';

const RETRIES = 3;
const RETRY_DELAY_MS = 2000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// GitHub API request, retried on server errors and network failures.
async function request(token, endpoint, { method = 'GET', body } = {}) {
    let lastError;
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
        if (attempt > 1) await sleep(RETRY_DELAY_MS * (attempt - 1));
        let response;
        try {
            response = await fetch(`${API_URL}${endpoint}`, {
                method,
                headers: {
                    Accept: 'application/vnd.github+json',
                    Authorization: `Bearer ${token}`,
                    'X-GitHub-Api-Version': '2022-11-28',
                    ...(body ? { 'Content-Type': 'application/json' } : {}),
                },
                body: body ? JSON.stringify(body) : undefined,
            });
        } catch (error) {
            lastError = error;
            continue;
        }
        if (response.ok) return response.json();
        lastError = new Error(`${method} ${endpoint} failed: ${response.status} ${await response.text()}`);
        if (response.status < 500) break;
    }
    throw lastError;
}

async function paginate(token, endpoint, pick, maxPages = 10) {
    const items = [];
    for (let page = 1; page <= maxPages; page++) {
        const sep = endpoint.includes('?') ? '&' : '?';
        const data = await request(token, `${endpoint}${sep}per_page=100&page=${page}`);
        const batch = pick(data);
        items.push(...batch);
        if (batch.length < 100) break;
    }
    return items;
}

// All jobs of the current workflow run attempt, including jobs of nested
// reusable workflows, whose names are prefixed like "Test / GPU / CUDA (...)".
// The per-attempt endpoint also lists jobs carried over from earlier attempts,
// and unlike `jobs?filter=latest` it stays reliable on runs with many attempts.
async function listJobs(token, repository, runId, attempt = process.env.GITHUB_RUN_ATTEMPT) {
    const endpoint = attempt
        ? `/repos/${repository}/actions/runs/${runId}/attempts/${attempt}/jobs`
        : `/repos/${repository}/actions/runs/${runId}/jobs?filter=latest`;
    return paginate(token, endpoint, (d) => d.jobs);
}

// A report label matches the job whose display name is the label itself or
// ends with it (reusable workflows prefix the caller's job name). Jobs matching
// `filter` win over others, since unrelated workflows in the same run can use
// the same job names (e.g. "Download / Plugin (runc, amd64)" vs "Test / Plugin (runc, amd64)").
function findJob(jobs, label, filter = /.*/) {
    const matches = jobs.filter((job) => job.name === label || job.name.endsWith(` / ${label}`));
    return matches.find((job) => filter.test(job.name)) || matches[0];
}

// Jobs that failed in a way the summary should surface: no test report was
// produced (crashed, timed out, failed before tests ran), or the tests passed
// but the job still failed. Jobs sharing the summary job's own name (the
// disabled summary jobs of nested workflows) and cancelled jobs that never
// started are left out.
function collectFailedJobs(jobs, groups, filter, runnerName = process.env.RUNNER_NAME) {
    const reported = new Map();
    for (const group of groups) {
        if (group.job) reported.set(group.job.id, group);
    }
    const baseName = (name) => name.split(' / ').pop();
    const self = runnerName && jobs.find((j) => j.status === 'in_progress' && j.runner_name === runnerName);
    const selfName = self ? baseName(self.name) : null;

    const failed = [];
    for (const job of jobs) {
        if (job.status !== 'completed' || !['failure', 'cancelled', 'timed_out'].includes(job.conclusion)) continue;
        if (!filter.test(job.name)) continue;
        if (selfName && baseName(job.name) === selfName) continue;
        const started = (job.steps || []).some((s) => s.status === 'completed' && s.conclusion === 'success');
        if (job.conclusion === 'cancelled' && !started) continue;
        const group = reported.get(job.id);
        if (group && group.failed > 0) continue;
        const outcome = job.conclusion === 'failure' ? 'failed' : job.conclusion.replace('_', ' ');
        // A report with no test cases (bats aborted before running anything) counts as missing results.
        const ran = group && group.total > 0;
        failed.push({
            id: job.id,
            name: baseName(job.name),
            html_url: job.html_url,
            conclusion: job.conclusion,
            missing: !ran,
            reason: ran ? `tests passed, job ${outcome}` : group ? `no tests ran, job ${outcome}` : `${outcome} without a test report`,
        });
    }
    return failed.sort((a, b) => a.name.localeCompare(b.name));
}

// The pull request for this run: from the event payload when triggered by a
// pull request, otherwise the first open pull request for the commit.
async function findPullRequest(token, repository, sha) {
    const eventPath = process.env.GITHUB_EVENT_PATH;
    if (eventPath && fs.existsSync(eventPath)) {
        const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
        const number = event.pull_request?.number ?? event.issue?.number;
        if (number) return { number, url: event.pull_request?.html_url };
    }
    if (!sha) return null;
    const pulls = await request(token, `/repos/${repository}/commits/${sha}/pulls`);
    const open = pulls.find((p) => p.state === 'open');
    return open ? { number: open.number, url: open.html_url } : null;
}

// Create or update the comment identified by `marker` on a pull request.
async function upsertComment(token, repository, number, marker, body) {
    const comments = await paginate(token, `/repos/${repository}/issues/${number}/comments`, (d) => d, 5);
    const existing = comments.find((c) => typeof c.body === 'string' && c.body.includes(marker));
    if (existing) {
        return request(token, `/repos/${repository}/issues/comments/${existing.id}`, {
            method: 'PATCH',
            body: { body },
        });
    }
    return request(token, `/repos/${repository}/issues/${number}/comments`, { method: 'POST', body: { body } });
}

module.exports = { request, listJobs, findJob, collectFailedJobs, findPullRequest, upsertComment };
