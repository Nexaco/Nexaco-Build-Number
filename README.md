# Nexaco Build Number

A GitHub Action that generates a **sequential, monotonically increasing build number** for your workflow runs and makes it available as an output, as an environment variable, and as a file.

The counter is stored inside the repository itself as a lightweight git tag (`build-number-<n>`), so it survives across workflows, across workflow file renames, and across repository clones — something `github.run_number` does not do.

```yaml
- uses: Nexaco/Nexaco-Build-Number@v2.3
  with:
    token: ${{ secrets.GITHUB_TOKEN }}

- run: echo "Building version 1.0.$BUILD_NUMBER"
```

---

## Table of contents

- [Why](#why)
- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [Inputs](#inputs)
- [Outputs](#outputs)
- [Required permissions](#required-permissions)
- [Sharing the build number across jobs](#sharing-the-build-number-across-jobs)
- [Multiple independent counters (`prefix`)](#multiple-independent-counters-prefix)
- [Setting or resetting the counter](#setting-or-resetting-the-counter)
- [Versions and Node runtime](#versions-and-node-runtime)
- [Caveats and limitations](#caveats-and-limitations)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [License and credits](#license-and-credits)

---

## Why

GitHub provides `github.run_number`, but it has real limitations:

| | `github.run_number` | Nexaco Build Number |
|---|---|---|
| Scope | Per workflow file | Per repository (or per `prefix`) |
| Survives a workflow rename | No — resets to 1 | Yes |
| Shared between different workflows | No | Yes |
| Can be set/reset manually | No | Yes (push a tag) |
| Visible outside Actions | No | Yes (it is a git tag) |

If you need a single build number shared by, say, `build.yml`, `release.yml` and `nightly.yml`, or a number you can bump/reset by hand, this action gives you that.

## How it works

On the first run inside a workflow the action:

1. Queries the GitHub API for refs matching `refs/tags/<prefix>build-number-*`.
2. Takes the highest number found (or starts at **1** if there is none).
3. Creates a new tag `<prefix>build-number-<n+1>` pointing at `GITHUB_SHA`, the commit that triggered the run.
4. Deletes the older `build-number-*` tags, so normally exactly one counter tag exists at any time.
5. Exposes the value in three ways:
   - step output `build_number`
   - environment variable `BUILD_NUMBER` (available to all following steps of the job)
   - a file named `BUILD_NUMBER` in the workspace root, so it can be passed to other jobs as an artifact

If the file `BUILD_NUMBER/BUILD_NUMBER` already exists in the workspace (the layout produced by `actions/download-artifact`), the action **does not** generate a new number: it reads the existing one and just re-exports it. That is what makes multi-job workflows share a single number — see [Sharing the build number across jobs](#sharing-the-build-number-across-jobs).

No repository checkout is required to generate the number; everything is done through the GitHub REST API.

## Quick start

```yaml
name: Build

on: [push]

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: write        # needed to create and delete the counter tag
    steps:
      - uses: actions/checkout@v4

      - name: Generate build number
        id: buildnumber
        uses: Nexaco/Nexaco-Build-Number@v2.3
        with:
          token: ${{ secrets.GITHUB_TOKEN }}

      # 1) as an environment variable
      - run: echo "Build number is $BUILD_NUMBER"

      # 2) as a step output
      - run: echo "Build number is ${{ steps.buildnumber.outputs.build_number }}"

      # 3) typical use: a full version string
      - run: echo "VERSION=1.4.${{ steps.buildnumber.outputs.build_number }}" >> $GITHUB_ENV
```

## Inputs

| Name | Required | Default | Description |
|---|---|---|---|
| `token` | Only when generating a new number | — | A GitHub token with write access to the repository contents, used to create and delete the counter tag. Normally `${{ secrets.GITHUB_TOKEN }}`. Not required in later jobs that only read a previously generated number from an artifact. |
| `prefix` | No | — | Prefix for the tag, producing `<prefix>-build-number-<n>`. Use it to keep several independent counters in the same repository. |

> There is **no default** for `token`: if you omit it in the job that generates the number, the action fails with `ERROR: Environment variable INPUT_TOKEN is not defined.`

## Outputs

| Name | Description |
|---|---|
| `build_number` | The generated (or reused) build number, e.g. `42`. |

In addition the action sets:

- the environment variable `BUILD_NUMBER` for the remaining steps of the job;
- a file `BUILD_NUMBER` in the workspace root containing the number (only when the number is generated).

## Required permissions

The action creates and deletes git tags, so the token must be allowed to write repository contents.

With the default `GITHUB_TOKEN`, add to the job (or to the workflow):

```yaml
permissions:
  contents: write
```

If your repository or organisation sets workflow permissions to *read-only* by default, this is mandatory — otherwise the tag creation fails with HTTP 403. A PAT with `repo` scope works as well, if you need the tag push to trigger other workflows (events caused by `GITHUB_TOKEN` do not trigger further workflow runs).

## Sharing the build number across jobs

Every job runs on a fresh machine, so the number must be handed over explicitly. Upload it as an artifact in the first job and download it in the following ones — the action detects the downloaded file and reuses the value instead of incrementing the counter.

```yaml
jobs:
  first:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: Nexaco/Nexaco-Build-Number@v2.3
        with:
          token: ${{ secrets.GITHUB_TOKEN }}

      - run: echo "Generated $BUILD_NUMBER"

      - uses: actions/upload-artifact@v4
        with:
          name: BUILD_NUMBER
          path: BUILD_NUMBER

  second:
    runs-on: ubuntu-latest
    needs: first
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: BUILD_NUMBER
          path: BUILD_NUMBER          # produces ./BUILD_NUMBER/BUILD_NUMBER

      - uses: Nexaco/Nexaco-Build-Number@v2.3   # no token needed here

      - run: echo "Reusing $BUILD_NUMBER"
```

Two details matter:

- the artifact **name** and the download **path** must both be `BUILD_NUMBER`, because the action looks for exactly `BUILD_NUMBER/BUILD_NUMBER`;
- `token` can be omitted in the reusing jobs, since no API call is made.

A simpler alternative, if you do not need the file: expose the value as a job output and read it with `needs.<job>.outputs.<name>`.

```yaml
jobs:
  first:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    outputs:
      build_number: ${{ steps.bn.outputs.build_number }}
    steps:
      - id: bn
        uses: Nexaco/Nexaco-Build-Number@v2.3
        with:
          token: ${{ secrets.GITHUB_TOKEN }}

  second:
    runs-on: ubuntu-latest
    needs: first
    steps:
      - run: echo "Build number is ${{ needs.first.outputs.build_number }}"
```

## Multiple independent counters (`prefix`)

Use `prefix` when a single repository needs more than one counter, for example one per component or per release channel:

```yaml
- uses: Nexaco/Nexaco-Build-Number@v2.3
  with:
    token: ${{ secrets.GITHUB_TOKEN }}
    prefix: backend        # tags: backend-build-number-<n>

- uses: Nexaco/Nexaco-Build-Number@v2.3
  with:
    token: ${{ secrets.GITHUB_TOKEN }}
    prefix: frontend       # tags: frontend-build-number-<n>
```

Each prefix keeps its own sequence. Note that the workspace file is still called `BUILD_NUMBER`, so if you generate two counters in the same job, read the values from the step outputs rather than from the file or the environment variable.

## Setting or resetting the counter

Because the counter *is* a git tag, you control it with plain git. To make the next build number `1000`, create the tag manually:

```bash
git tag build-number-999
git push origin build-number-999
```

The next run reads `999` and generates `1000`, then deletes the old tag. The same works with a prefix (`backend-build-number-999`).

To start over from 1, delete every `build-number-*` tag:

```bash
git push --delete origin build-number-42
git tag -d build-number-42
```

## Versions and Node runtime

| Ref | Node runtime declared in `action.yml` |
|---|---|
| `@v2.3` | `node24` |
| `@v2.2` | `node20` |
| `@v2.1`, `@v2.0`, `@v1.0` | older runtimes |

Pin an explicit tag (`@v2.3`) rather than a branch. Use `@v2.3` on current GitHub-hosted runners; if you run on self-hosted runners with an older runner agent that does not support the Node 24 runtime, stay on `@v2.2`.

## Caveats and limitations

- **Concurrency.** The counter is read and written in two separate API calls, so two runs starting at the same time can read the same value and produce a duplicate or a failed tag creation. If you trigger many parallel runs, guard the job with a [`concurrency`](https://docs.github.com/actions/using-jobs/using-concurrency) group.
- **At most 5 leftover counter tags.** If the API returns more than 5 matching `build-number-*` refs, the action fails on purpose (`Too many build-number- refs in repository`) rather than guessing. It is a safety net against a repository full of stray tags — see [Troubleshooting](#troubleshooting).
- **Tag deletion is best effort.** If deleting an old counter tag fails, the run logs a warning and keeps going; the tag is cleaned up on a later run (as long as you stay under the limit above).
- **The tag points at `GITHUB_SHA`.** For `pull_request` events that is the merge commit created by GitHub, not the head of the branch.
- **`GITHUB_TOKEN` does not trigger other workflows.** Tags created with the default token will not start workflows listening on `push: tags`. Use a PAT if you need that.
- **Prefix and file name.** The `BUILD_NUMBER` file is not namespaced by prefix, so multiple counters in the same job cannot both be passed via the file/artifact mechanism.

## Troubleshooting

**`ERROR: Environment variable INPUT_TOKEN is not defined.`**
The job is generating a new number but no `token` was passed. Add `token: ${{ secrets.GITHUB_TOKEN }}`.

**`Failed to create new build-number ref. Status: 403`**
The token cannot write to the repository. Add `permissions: contents: write` to the job, or check the organisation's default workflow permissions.

**`ERROR: Too many build-number- refs in repository, found N, expected only 1.`**
Stray counter tags accumulated (for example because deletions kept failing). List and clean them up, keeping only the highest one:

```bash
git ls-remote --tags origin "*build-number-*"
git push --delete origin build-number-3 build-number-4
```

**The number does not increase between jobs of the same workflow.**
That is by design when the `BUILD_NUMBER/BUILD_NUMBER` file is present — the number is generated once per workflow run, not once per job.

**The number restarts from 1.**
The counter tag was deleted, or the repository was recreated/forked without tags. Recreate the tag manually as shown in [Setting or resetting the counter](#setting-or-resetting-the-counter).

## Development

The action runs the bundled file `dist/index.js`, which is generated from `src/main.js` with [`@vercel/ncc`](https://github.com/vercel/ncc). **The `dist/` folder must be committed** — GitHub Actions does not install dependencies for JavaScript actions.

```bash
npm install
npm run build     # ncc build src/main.js -o dist
git add dist
```

Project layout:

```
action.yml        # action metadata: inputs, outputs, runtime, entry point
src/main.js       # source
dist/index.js     # bundled output, committed and executed by the runner
```

To release a new version, bump the runtime/version references, rebuild `dist/`, commit and push a new tag (`v2.4`, …).

## License and credits

Released under the ISC license (see `package.json`).

The approach — a repository-scoped counter kept as a git tag, with the artifact handover between jobs — follows the design popularised by [einaregilsson/build-number](https://github.com/einaregilsson/build-number). This repository is the Nexaco maintained variant, kept up to date with current Actions runtimes.
