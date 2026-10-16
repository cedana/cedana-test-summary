const fs = require('fs');
const os = require('os');
const path = require('path');
const { DefaultArtifactClient } = require('@actions/artifact');

// Artifacts named `test-summary-<slug>` carry the outputs of a summary (plus
// the one-line summary as markdown) to later jobs of the same workflow run,
// e.g. cedana-publish-summary embeds the test matrix image and that line in
// the release summary.
const ARTIFACT_PREFIX = 'test-summary-';
const ARTIFACT_FILE = 'test-summary.json';

function slugify(title) {
    return (
        title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '') || 'tests'
    );
}

async function uploadSummary(summary) {
    const name = `${ARTIFACT_PREFIX}${slugify(summary.title)}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), ARTIFACT_PREFIX));
    const file = path.join(dir, ARTIFACT_FILE);
    fs.writeFileSync(file, JSON.stringify(summary));
    await new DefaultArtifactClient().uploadArtifact(name, [file], dir);
    return name;
}

// The newest artifact of each name that was uploaded more than once in the
// run, i.e. by a job that was re-run.
function rerunArtifacts(artifacts) {
    const all = new Map();
    for (const artifact of artifacts) {
        all.set(artifact.name, [...(all.get(artifact.name) || []), artifact]);
    }
    const newest = new Map();
    for (const [name, list] of all) {
        if (list.length > 1) {
            newest.set(name, list.reduce((a, b) => (b.createdAt > a.createdAt ? b : a)));
        }
    }
    return newest;
}

// When a re-run job uploads its report under the same name again,
// actions/download-artifact keeps the artifact with the highest id, and ids
// are not ordered by creation time, so a report can be an earlier attempt's.
// Replace each report directory named after such an artifact with the newest
// one. Returns the number of directories replaced.
async function refreshRerunReports(files, log) {
    const client = new DefaultArtifactClient();
    const { artifacts } = await client.listArtifacts();
    const newest = rerunArtifacts(artifacts);
    let replaced = 0;
    for (const dir of new Set(files.map((file) => path.dirname(file)))) {
        const artifact = newest.get(path.basename(dir));
        if (!artifact) continue;
        fs.rmSync(dir, { recursive: true, force: true });
        await client.downloadArtifact(artifact.id, { path: dir });
        log(`Replaced ${dir} with the newest ${artifact.name} artifact (${artifact.id})`);
        replaced++;
    }
    return replaced;
}

module.exports = { ARTIFACT_PREFIX, ARTIFACT_FILE, slugify, uploadSummary, rerunArtifacts, refreshRerunReports };
