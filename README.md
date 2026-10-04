# cedana-test-summary

GitHub action that turns JUnit XML test reports into one concise summary, posted to the job summary, the pull request (one comment, updated on every run), and Slack ([Block Kit](https://api.slack.com/block-kit)).

The summary leads with what matters: a test matrix image (one square per test, failures in red), failed tests with their output and a link to the job logs, jobs that failed without producing a report (crashes, timeouts), flaky tests, and optionally a short Claude analysis of the failures. Passing suites are folded into a single table, and the footer carries the run, attempt, branch, commit, and timing.

## Usage

Test jobs upload their JUnit reports as artifacts, and one job at the end downloads them all and posts the summary:

```yaml
jobs:
  test:
    name: Basic
    strategy:
      matrix:
        arch: [amd64, arm64]
    steps:
      - run: bats --report-formatter junit --output /tmp test/
      - name: Label report
        if: always()
        run: sed -i 's|<testsuites |<testsuites name="Basic (${{ matrix.arch }})" |' /tmp/report.xml
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: test-report-${{ matrix.arch }}
          path: /tmp/report*.xml

  summary:
    if: always()
    needs: test
    runs-on: ubuntu-latest
    permissions:
      actions: read
      contents: write
      pull-requests: write
    steps:
      - uses: actions/download-artifact@v4
        with:
          pattern: test-report-*
          path: report
      - uses: cedana/cedana-test-summary@v1
        with:
          reports: report/**/*.xml
          image-branch: test-summary-assets
          slack-webhook-url: ${{ secrets.SLACK_WEBHOOK_URL }}
```

### Report format

Plain JUnit XML, as emitted by bats (`--report-formatter junit`) and most other test runners. No conversion step is needed.

Reports are grouped by the `name` attribute of the `<testsuites>` root element, which bats leaves empty; set it to the job's display name as shown in GitHub (for a job named `Basic` with a matrix over `arch`, that is `Basic (amd64)`). The action then links each group to its job logs, and knows which jobs failed without producing a report. When the attribute is missing, the parent directory name (the artifact name) is used and no job link is resolved.

Several report files may share one name (for example an isolated and a persistent run of the same suite); they are aggregated, and the file name distinguishes failures (`report-persistent.xml` → `persistent`).

### Test matrix image

GitHub comments and Slack webhooks can only embed images by public URL, so the matrix is committed to a branch of the repository (`image-branch`, created when missing) and referenced through raw.githubusercontent.com. The branch is rewritten as a single commit on every run and images older than `image-retention-days` are dropped, so it never grows beyond a few weeks of images. This requires a public repository and `contents: write`.

The matrix can be divided into labelled bands (`matrix-sections`) and side-by-side columns (`matrix-split`). Both take one bucket per line as `Label=regex`, matched against the suite names in order; a line without a regex collects whatever is left. A division is only drawn when more than one of its buckets has tests, so a run with a single kind of suite still renders as one plain grid.

```yaml
          matrix-sections: |
            Kubernetes=^Kubernetes
            SLURM=^Slurm
            Others
          matrix-split: |
            CPU
            CUDA=\b(CUDA|GPU)\b
```

Labels use the bundled [Inter](https://rsms.me/inter/) font (SIL Open Font License, see `assets/`).

### Permissions

`actions: read` to list the jobs of the run, `pull-requests: write` to comment, `contents: write` to publish the image. Without `actions: read` the summary is still posted, without job links or failed-job detection; without `contents: write` it is posted without the image.

## Inputs

| Input | Description | Default |
| --- | --- | --- |
| `reports` | Glob patterns (one per line) for the JUnit XML reports | `**/*.xml` |
| `title` | Summary title; also identifies the pull request comment to update | `Tests` |
| `github-token` | Token used to list jobs and comment | `github.token` |
| `jobs-filter` | Regex on job names; only matching jobs are reported when they fail without a report | every job |
| `step-summary` | Write to the GitHub step summary | `true` |
| `pr-comment` | Post or update the pull request comment | `true` |
| `slack-webhook-url` | Slack incoming webhook URL; skipped when empty | — |
| `anthropic-api-key` | Enables a short Claude analysis of the failures | — |
| `anthropic-model` | Model used for the analysis | `claude-opus-5-5` |
| `image-branch` | Branch to publish the test matrix image to; disabled when empty | — |
| `image-retention-days` | Days to keep published images | `30` |
| `matrix-sections` | Bands of the matrix, one `Label=regex` per line | — |
| `matrix-split` | Side-by-side columns of each band, one `Label=regex` per line | — |
| `dry-run` | Build the summary without posting | `false` |

## Outputs

| Output | Description |
| --- | --- |
| `conclusion` | `success` when every test passed and no job failed, otherwise `failure` |
| `passed`, `failed`, `skipped` | Test counts |
| `markdown` | The summary as GitHub-flavored markdown |
| `payload` | The Slack Block Kit payload |
| `image-url` | URL of the published test matrix image, when enabled |

## Development

```sh
npm install
npm test
npm run build   # bundles src/index.js -> dist/index.js (commit dist!)
```

Dry run against a real workflow run, using its job list but local reports:

```sh
GITHUB_REPOSITORY=cedana/cedana GITHUB_RUN_ID=<run id> \
GITHUB_OUTPUT=/tmp/out GITHUB_STEP_SUMMARY=/tmp/sum \
INPUT_REPORTS='test/fixtures/**/*.xml' INPUT_GITHUB-TOKEN=$(gh auth token) \
INPUT_STEP-SUMMARY=false INPUT_PR-COMMENT=false INPUT_DRY-RUN=true \
node dist/index.js
```
