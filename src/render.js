const slackifyMarkdown = require('slackify-markdown');

const MAX_COMMENT_CHARS = 60000;
const MAX_FAILED_TESTS_PER_GROUP = 20;
const MAX_MESSAGE_LINES = 14;
const MESSAGE_HEAD_LINES = 4;
const MAX_MESSAGE_CHARS = 2500;
const MAX_FLAKY_TESTS = 20;

const MAX_BLOCKS = 50;
const MAX_SECTION_TEXT = 3000;
const MAX_HEADER_TEXT = 150;
const MAX_SLACK_GROUPS = 8;
const MAX_SLACK_TESTS_PER_GROUP = 6;

function n(value) {
    return value.toLocaleString('en-US');
}

function duration(seconds) {
    if (!seconds || seconds < 1) return '';
    const s = Math.round(seconds);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
    const h = Math.floor(m / 60);
    return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

function plural(count, word) {
    return `${n(count)} ${word}${count === 1 ? '' : 's'}`;
}

function escapeHtml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeMd(text) {
    return text.replace(/([*_`|[\]<>])/g, '\\$1');
}

function truncate(text, max) {
    if (text.length <= max) return text;
    return text.slice(0, max - 2).trimEnd() + ' …';
}

// Keep the start (where bats says which assertion failed) and the end (where
// the actual error usually is) of long output.
function clipMessage(message, maxLines) {
    if (maxLines <= 0) return '';
    const lines = message.split('\n');
    let out;
    if (lines.length <= maxLines) {
        out = lines.join('\n');
    } else {
        const head = Math.min(MESSAGE_HEAD_LINES, maxLines);
        const tail = maxLines - head;
        out = [
            ...lines.slice(0, head),
            `… (${lines.length - maxLines} lines omitted) …`,
            ...(tail > 0 ? lines.slice(lines.length - tail) : []),
        ].join('\n');
    }
    if (out.length > MAX_MESSAGE_CHARS) out = out.slice(0, MAX_MESSAGE_CHARS).trimEnd() + ' …';
    return out;
}

function testTitle(group, test) {
    const variant = group.multiVariant && test.variant ? test.variant : '';
    return { title: `${test.suite} › ${test.name}`, variant };
}

function failedTests(group) {
    return group.tests.filter((t) => t.status === 'failed');
}

function flakyTests(groups) {
    const flaky = [];
    for (const group of groups) {
        for (const test of group.tests) {
            if (test.flaky) flaky.push({ group, test });
        }
    }
    return flaky;
}

function link(text, url) {
    return url ? `[${text}](${url})` : text;
}

function sortGroups(groups) {
    return [...groups].sort((a, b) => b.failed - a.failed || a.label.localeCompare(b.label));
}

function summaryLine(totals, groups, failedJobs = []) {
    const parts = [];
    if (totals.failed > 0) parts.push(`**${n(totals.failed)} failed**`);
    parts.push(`${n(totals.passed)} passed`);
    if (totals.skipped > 0) parts.push(`${n(totals.skipped)} skipped`);
    if (totals.flaky > 0) parts.push(`${n(totals.flaky)} flaky`);
    parts.push(plural(groups.length, 'suite'));
    if (failedJobs.length > 0) parts.push(`**${plural(failedJobs.length, 'failed job')}**`);
    return parts.join(' · ');
}

function footerParts(context, timing, { pullRequest = false } = {}) {
    const parts = [];
    if (context.runUrl) parts.push({ text: `Run #${context.runNumber}`, url: context.runUrl });
    if (context.runAttempt > 1) parts.push({ text: `attempt ${context.runAttempt}`, italic: true });
    if (pullRequest && context.pullRequest) parts.push({ text: `PR #${context.pullRequest.number}`, url: context.pullRequest.url });
    if (context.branch) parts.push({ text: context.branch, code: true });
    if (context.sha) parts.push({ text: context.sha.slice(0, 7), url: context.commitUrl });
    if (timing?.wall) parts.push({ text: `${duration(timing.wall)} wall-clock` });
    if (timing?.tests) parts.push({ text: `${duration(timing.tests)} of tests` });
    return parts;
}

function renderMarkdown(report, messageLines = MAX_MESSAGE_LINES) {
    const { title, groups, totals, failedJobs, analysis, context, marker, imageUrl, timing } = report;
    const sorted = sortGroups(groups);
    const out = [];

    out.push(marker);
    out.push(`## ${title}`);
    out.push('');
    out.push(summaryLine(totals, groups, failedJobs));
    out.push('');
    if (imageUrl) {
        out.push(`![Test matrix](${imageUrl})`);
        out.push('');
    }

    const failing = sorted.filter((g) => g.failed > 0);
    if (failing.length > 0) {
        out.push('### ❌ Failed tests');
        out.push('');
        for (const group of failing) {
            const tests = failedTests(group);
            const logs = group.job?.html_url ? ` · <a href="${group.job.html_url}">logs</a>` : '';
            out.push('<details open>');
            out.push(
                `<summary><b>${escapeHtml(group.label)}</b> · ${n(group.failed)} of ${n(group.total)} failed${logs}</summary>`
            );
            out.push('');
            for (const test of tests.slice(0, MAX_FAILED_TESTS_PER_GROUP)) {
                const { title: t, variant } = testTitle(group, test);
                out.push(`**${escapeMd(t)}**${variant ? ` _${escapeMd(variant)}_` : ''}`);
                const message = clipMessage(test.message, messageLines);
                if (message) {
                    out.push('');
                    out.push('```');
                    out.push(message.replace(/```/g, '` ` `'));
                    out.push('```');
                }
                out.push('');
            }
            if (tests.length > MAX_FAILED_TESTS_PER_GROUP) {
                out.push(`_… ${n(tests.length - MAX_FAILED_TESTS_PER_GROUP)} more failed tests_`);
                out.push('');
            }
            out.push('</details>');
            out.push('');
        }
    }

    if (failedJobs.length > 0) {
        out.push('### 💥 Failed jobs');
        out.push('');
        for (const job of failedJobs) {
            out.push(`- ${link(escapeMd(job.name), job.html_url)} — ${job.reason}`);
        }
        out.push('');
    }

    const flaky = flakyTests(sorted);
    if (flaky.length > 0) {
        out.push('<details>');
        out.push(`<summary>${plural(flaky.length, 'flaky test')} (passed on retry)</summary>`);
        out.push('');
        for (const { group, test } of flaky.slice(0, MAX_FLAKY_TESTS)) {
            const { title: t, variant } = testTitle(group, test);
            out.push(`- ${link(escapeMd(group.label), group.job?.html_url)} › ${escapeMd(t)}${variant ? ` _${escapeMd(variant)}_` : ''}`);
        }
        if (flaky.length > MAX_FLAKY_TESTS) out.push(`- _… ${n(flaky.length - MAX_FLAKY_TESTS)} more_`);
        out.push('');
        out.push('</details>');
        out.push('');
    }

    if (analysis) {
        out.push('### Analysis');
        out.push('');
        out.push(analysis);
        out.push('');
    }

    if (sorted.length > 0) {
        out.push('<details>');
        out.push(`<summary>All ${plural(sorted.length, 'suite')}</summary>`);
        out.push('');
        out.push('| Suite | Passed | Failed | Skipped | Time |');
        out.push('|---|--:|--:|--:|--:|');
        for (const group of sorted) {
            const name = link(escapeMd(group.label), group.job?.html_url);
            const note = group.failed === 0 && group.job && group.job.conclusion !== 'success' ? ` (job ${group.job.conclusion})` : '';
            out.push(`| ${name}${note} | ${n(group.passed)} | ${n(group.failed)} | ${n(group.skipped)} | ${duration(group.time)} |`);
        }
        out.push('');
        out.push('</details>');
        out.push('');
    }

    const footer = footerParts(context, timing).map((part) => {
        let text = part.code ? `\`${part.text}\`` : escapeMd(part.text);
        if (part.italic) text = `_${text}_`;
        return link(text, part.url);
    });
    out.push(`<sub>${footer.join(' · ')}</sub>`);

    const markdown = out.join('\n');
    // Shrink failure output until the comment fits GitHub's limit.
    if (markdown.length > MAX_COMMENT_CHARS && messageLines > 0) {
        return renderMarkdown(report, messageLines > 5 ? 5 : 0);
    }
    return markdown;
}

function slackLink(text, url) {
    return url ? `<${url}|${text}>` : text;
}

function renderSlack({ title, groups, totals, failedJobs, analysis, context, imageUrl, timing }) {
    const sorted = sortGroups(groups);
    const blocks = [];

    blocks.push({
        type: 'header',
        text: { type: 'plain_text', text: truncate(title, MAX_HEADER_TEXT), emoji: true },
    });

    const summary = {
        type: 'section',
        text: { type: 'mrkdwn', text: summaryLine(totals, groups, failedJobs).replace(/\*\*/g, '*') },
    };
    if (context.runUrl) {
        summary.accessory = {
            type: 'button',
            text: { type: 'plain_text', text: 'View run', emoji: true },
            url: context.runUrl,
            action_id: 'view-run',
        };
    }
    blocks.push(summary);

    if (imageUrl) {
        blocks.push({
            type: 'image',
            image_url: imageUrl,
            alt_text: `Test matrix: ${summaryLine(totals, groups, failedJobs).replace(/\*\*/g, '')}`,
        });
    }

    const failing = sorted.filter((g) => g.failed > 0);
    if (failing.length > 0) {
        blocks.push({ type: 'divider' });
        for (const group of failing.slice(0, MAX_SLACK_GROUPS)) {
            const tests = failedTests(group);
            const lines = [
                `:x: *${slackLink(group.label, group.job?.html_url)}* · ${n(group.failed)} of ${n(group.total)} failed`,
            ];
            for (const test of tests.slice(0, MAX_SLACK_TESTS_PER_GROUP)) {
                const { title: t, variant } = testTitle(group, test);
                lines.push(`• ${t}${variant ? ` _${variant}_` : ''}`);
            }
            if (tests.length > MAX_SLACK_TESTS_PER_GROUP) {
                lines.push(`• _… ${n(tests.length - MAX_SLACK_TESTS_PER_GROUP)} more_`);
            }
            blocks.push({ type: 'section', text: { type: 'mrkdwn', text: truncate(lines.join('\n'), MAX_SECTION_TEXT) } });
        }
        if (failing.length > MAX_SLACK_GROUPS) {
            blocks.push({
                type: 'context',
                elements: [{ type: 'mrkdwn', text: `_… ${n(failing.length - MAX_SLACK_GROUPS)} more failing suites_` }],
            });
        }
    }

    if (failedJobs.length > 0) {
        const lines = [':boom: *Failed jobs*'];
        for (const job of failedJobs) lines.push(`• ${slackLink(job.name, job.html_url)} — ${job.reason}`);
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: truncate(lines.join('\n'), MAX_SECTION_TEXT) } });
    }

    const flaky = flakyTests(sorted);
    if (flaky.length > 0) {
        const lines = [`*${plural(flaky.length, 'flaky test')}* (passed on retry)`];
        for (const { group, test } of flaky.slice(0, MAX_SLACK_TESTS_PER_GROUP)) {
            const { title: t, variant } = testTitle(group, test);
            lines.push(`• ${slackLink(group.label, group.job?.html_url)} › ${t}${variant ? ` _${variant}_` : ''}`);
        }
        if (flaky.length > MAX_SLACK_TESTS_PER_GROUP) lines.push(`• _… ${n(flaky.length - MAX_SLACK_TESTS_PER_GROUP)} more_`);
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: truncate(lines.join('\n'), MAX_SECTION_TEXT) } });
    }

    if (analysis) {
        blocks.push({ type: 'divider' });
        blocks.push({
            type: 'section',
            text: { type: 'mrkdwn', text: truncate(`*Analysis*\n${slackifyMarkdown(analysis).trim()}`, MAX_SECTION_TEXT) },
        });
    }

    const elements = footerParts(context, timing, { pullRequest: true }).map((part) => {
        let text = part.code ? `\`${part.text}\`` : part.text;
        if (part.italic) text = `_${text}_`;
        return { type: 'mrkdwn', text: slackLink(text, part.url) };
    });
    blocks.push({ type: 'context', elements: elements.slice(0, 10) });

    return { blocks: blocks.slice(0, MAX_BLOCKS) };
}

module.exports = { renderMarkdown, renderSlack, duration };
