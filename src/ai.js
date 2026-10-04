const Anthropic = require('@anthropic-ai/sdk');

const MAX_INPUT_CHARS = 80000;
const MAX_MESSAGE_LINES = 60;

const SYSTEM = `You summarize CI test failures for the engineers who will fix them.
Write 2 to 5 short bullet points in GitHub-flavored markdown. Group failures that share a
root cause, name the affected suites and tests, and quote the decisive error line in inline
code. Say when failures look environmental (timeouts, infrastructure, flakiness) rather than
product regressions. No preamble, no headings, no closing remarks.`;

function describeFailures(groups, failedJobs) {
    const parts = [];
    let size = 0;
    let omitted = 0;
    for (const group of groups) {
        for (const test of group.tests.filter((t) => t.status === 'failed')) {
            const suite = group.multiVariant && test.variant ? `${test.suite} (${test.variant})` : test.suite;
            const message = test.message.split('\n').slice(0, MAX_MESSAGE_LINES).join('\n');
            const part = `### ${group.label} › ${suite} › ${test.name}\n${message}\n`;
            if (size + part.length > MAX_INPUT_CHARS) {
                omitted++;
                continue;
            }
            parts.push(part);
            size += part.length;
        }
    }
    if (omitted > 0) parts.push(`(${omitted} more failures omitted for length)\n`);
    for (const job of failedJobs) {
        parts.push(`### Job ${job.name}: ${job.conclusion}, ${job.reason}\n`);
    }
    return parts.join('\n');
}

// Returns a markdown analysis of the failures, or '' when unavailable.
async function analyze({ apiKey, model, groups, failedJobs, log }) {
    const input = describeFailures(groups, failedJobs);
    if (!input.trim()) return '';

    const client = new Anthropic({ apiKey, timeout: 120000, maxRetries: 1 });
    const response = await client.messages.create({
        model,
        max_tokens: 1024,
        system: SYSTEM,
        messages: [{ role: 'user', content: `Test failures from this CI run:\n\n${input}` }],
    });
    if (response.stop_reason === 'refusal') {
        log(`Analysis declined (${response.stop_details?.category || 'unspecified'})`);
        return '';
    }
    return response.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim();
}

module.exports = { analyze, describeFailures };
