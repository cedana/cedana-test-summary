const fs = require('fs');

const API_URL = process.env.GITHUB_API_URL || 'https://api.github.com';

async function request(token, endpoint, { method = 'GET', body } = {}) {
    const response = await fetch(`${API_URL}${endpoint}`, {
        method,
        headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
        throw new Error(`${method} ${endpoint} failed: ${response.status} ${await response.text()}`);
    }
    return response.json();
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

// All jobs of the current workflow run (latest attempt), including jobs of
// nested reusable workflows, whose names are prefixed like "Test / GPU / CUDA (...)".
async function listJobs(token, repository, runId) {
    return paginate(token, `/repos/${repository}/actions/runs/${runId}/jobs?filter=latest`, (d) => d.jobs);
}

// A report label matches the job whose display name is the label itself or
// ends with it (reusable workflows prefix the caller's job name).
function findJob(jobs, label) {
    return jobs.find((job) => job.name === label || job.name.endsWith(` / ${label}`));
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
        failed.push({
            id: job.id,
            name: baseName(job.name),
            html_url: job.html_url,
            conclusion: job.conclusion,
            reason: group ? `tests passed, job ${outcome}` : `${outcome} without a test report`,
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
