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

module.exports = { ARTIFACT_PREFIX, ARTIFACT_FILE, slugify, uploadSummary };
