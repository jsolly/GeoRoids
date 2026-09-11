# Publish the wiki from Pages CMS

The GeoRoids wiki uses Pages CMS for saved editorial drafts and GitHub Actions for
publication. Editors save Markdown articles and raster images on the persistent
`codex/wiki-drafts` branch. The **Publish wiki** action creates a protected pull
request from one checked snapshot, waits for `CI / ci`, and enables squash
auto-merge into `main`.

## Live setup status

The Pages CMS GitHub App is installed and authorized for `jsolly/GeoRoids`, the
`pagescms@jsolly.com` email account has repository access, and the persistent
`codex/wiki-drafts` branch is initialized from `main`. Open the [draft editor](https://app.pagescms.org/jsolly/GeoRoids/codex%2Fwiki-drafts)
directly so the CMS stays on the editor branch instead of defaulting to `main`.
A real email-editor save roundtrip and the **Publish wiki** workflow dispatch
have been exercised. Final publish success and production merge remain pending
until a harmless saved change completes the full workflow.

Pages CMS supports email-invited collaborators who do not have a GitHub account
for day-to-day article and media editing. The email collaborator path does not
remove the setup requirement for the repository administrator: initial repository
authorization and collaborator administration require a real GitHub identity,
and the Pages CMS GitHub App must be installed and authorized for
`jsolly/GeoRoids`. See the [Pages CMS authentication documentation](https://pagescms.org/docs/development/authentication/)
for the token selection and the routes that require a GitHub user. Additional
collaborators require an explicit email address and administrator action.

If the integration is reinstalled or transferred, complete those administrator
steps before using the email editor. Do not recreate or force-push
`codex/wiki-drafts`; Pages CMS saves editor commits there.

## Configure the Pages CMS action

The root `.pages.yml` file must keep the wiki collection on `content/wiki`, the
image media source on `public/wiki/uploads`, and the CMS branch on
`codex/wiki-drafts`. The image source accepts `png`, `jpg`, `jpeg`, and `webp`
files. The collection uses flat `*.md` files and allows rename and delete so an
editor can repair or discard an unpublished draft. The validator prevents
deleting the canonical manual entries or breaking their links. Keep published
filenames stable because the filename is the article URL. New files use the
title-based filename configured in `.pages.yml`.

Keep the repository action below in the root `actions` list. The checked-in
`.pages.yml` already contains this action. Editors do not edit `.pages.yml`.

```yaml
actions:
  - name: publish-wiki
    label: Publish wiki
    workflow: wiki-publish.yml
    ref: main
    cancelable: false
    confirm:
      title: Publish saved wiki changes?
      message: Publishes all saved articles and images present when this job starts. Later saves stay as drafts. Automated checks must pass before publication.
      button: Publish
```

`ref: main` is required. Pages CMS dispatches `wiki-publish.yml` on `main` and
includes the draft ref and the workflow ref/SHA in `inputs.payload`. The
workflow validates those values, then captures the current draft branch head
once at the start of the run. The action is a repository action, so do not
attach it only to one article or one media item.

Pages CMS action fields and the `payload` input follow the [Pages CMS Actions
configuration](https://pagescms.org/docs/configuration/actions/). The action
payload includes the source, action name, repository ref and SHA, triggering user,
and optional CMS context. The repository SHA identifies the `main` workflow
revision; it is not treated as the draft commit. The publisher captures the
actual `codex/wiki-drafts` HEAD after validating the payload.

## Give the workflow its required permissions

The workflow uses the repository's standard `GITHUB_TOKEN`. No personal access
token or GitHub App secret is required for this design. The workflow declares
these permissions:

- `contents: write` pushes the lease-guarded draft synchronization commit and
  immutable snapshot branch.
- `pull-requests: write` creates the publication pull request and enables squash
  auto-merge.
- `actions: write` dispatches the existing `ci.yml` workflow on the immutable
  snapshot branch.
- `checks: read` lets the job inspect the dispatched check run.

In the repository settings, enable Actions and enable **Allow GitHub Actions to
create and approve pull requests**. Keep `main` protected with the required
`CI / ci` check and the existing squash auto-merge policy. The publisher does
not bypass branch protection or push to `main`.

## Publish saved edits

Use this sequence for every release:

1. Open the configured Pages CMS repository.
2. Confirm that the editor is working on `codex/wiki-drafts`.
3. Save each article or image. Wait for the CMS commit to finish.
4. Refresh the collection before publishing so the list includes the latest saved
   commits. Pages CMS does not provide realtime conflict resolution for two
   editors changing the same article. Avoid editing the same article at the same
   time. If the CMS reports a conflict, refresh, inspect the saved article, and
   save again before you publish.
5. Click **Publish wiki** and confirm the dialog. The action publishes all saved
   wiki files on the draft branch, not only the entry that is open in the CMS.
6. Open the workflow run if you need progress. The run captures the draft HEAD
   once, refreshes the draft branch from `main`, then creates or reuses an
   immutable snapshot PR. Saves made after that capture stay on the draft branch
   for the next publish.
7. Wait for the workflow to report `CI / ci passed` and the PR to merge. A
   successful workflow means the protected squash auto-merge completed.

Unsaved CMS edits are not part of a publish. Save them first, then run the action
again if they belong in the same release.

## What the publisher checks

The workflow accepts a Pages CMS payload only when all of these checks pass:

- The workflow dispatch ref is `main`.
- The payload source is `pages-cms` and the action name is `publish-wiki`.
- The payload source ref is `codex/wiki-drafts`.
- The payload workflow SHA is a full commit SHA and is still an ancestor of the
  current `main` head.
- The workflow captures one full commit SHA for `codex/wiki-drafts` after the
  payload checks. That captured draft commit is the immutable snapshot source;
  a save that races after capture remains for the next publish.
- The optional context path is the wiki article collection or the wiki upload
  directory.
- Every draft change is under `content/wiki/**/*.md` or
  `public/wiki/uploads/**/*.{png,jpg,jpeg,webp}`.
- Every file in those two draft trees is a regular `100644` Git blob. Symlinks,
  submodules, executable files, SVG files, and other extensions are rejected.

The compiler accepts the Markdown serialization Pages CMS produces for saved
articles, including omitted optional empty `media` metadata, compact frontmatter
delimiters, and a missing final newline. Before creating an immutable snapshot,
the publisher normalizes changed Markdown to LF line endings and one trailing
newline so the protected PR satisfies repository Markdown checks. The persistent
draft branch keeps the CMS's saved tree for continued editing.

The publisher refreshes the current draft branch with the `main` tree before it
builds a snapshot. The refresh creates a merge commit whose tree keeps the
editor's allowed changes and takes unrelated files from `main`. A file-level
three-way check carries a main-only editorial change forward. When a prior
publisher squash is involved, the workflow relies on its full draft marker in
the protected `main` history and checks that no later main commit touched the
path. An independent same-file change, including a rollback to old published
text, stops the run. It uses `--force-with-lease` with the exact draft head it
read. If an editor saves during this operation, the lease fails and the
workflow refetches the branch. A new editor commit is never replaced by an
older push.

The snapshot is based on the captured draft SHA, not the Pages CMS workflow
SHA. The source tree is combined with the current `main` tree so an earlier
saved draft does not remove unrelated files that were published since the draft
branch was created. A save after the capture remains on the persistent draft
branch for the next publish.

The snapshot branch name includes the full captured draft SHA:
`codex/wiki-publish/<draft-sha>`. The publisher never force-updates this branch.
If the branch or its PR already exists, the workflow checks that its wiki tree
still matches the captured draft SHA and then reuses it. A mismatch stops the
run.

## Why the workflow dispatches CI explicitly

GitHub does not start another workflow when a workflow uses `GITHUB_TOKEN` to
create a pull request. That behavior would leave the publication PR without the
normal pull request CI run, so the publisher explicitly dispatches the existing
`.github/workflows/ci.yml` workflow on the immutable snapshot branch. It waits
for that run to complete successfully before it calls:

```text
gh pr merge --auto --squash --subject "docs(wiki): publish draft <draft-sha>"
```

The workflow also writes the full `GeoRoids wiki draft snapshot: <draft-sha>`
marker into the squash commit body. The marker lets a later publish distinguish
the last publisher snapshot from an independent main edit or rollback. The merge
remains subject to protected `main` and its required `CI / ci` check.
The existing `auto-merge.yml` is still the normal path for human-created PRs. A
Pages CMS PR uses the same GitHub squash auto-merge API from `wiki-publish.yml`
because the `GITHUB_TOKEN` event rule prevents `auto-merge.yml` from starting.

## Recover from a failed publish

The publisher fails before creating a PR when the payload, workflow SHA, draft
ref, file paths, or file modes are invalid. It also fails when `main` and the
draft branch have a content conflict. Those failures leave the draft branch
intact. Fix the saved draft or resolve the branch conflict, then click **Publish
wiki** again.

If `CI / ci` fails, the immutable PR remains open and no merge occurs. Inspect
the CI run, fix the source of the failure on `codex/wiki-drafts`, and publish
again. The next run creates a new snapshot branch. Do not edit an immutable
`codex/wiki-publish/*` branch.

If the PR becomes `BEHIND` or `DIRTY` while CI runs, the publisher stops instead
of changing the snapshot branch. Publish again to create a snapshot based on the
new `main` head. If a user closes a snapshot PR, the publisher will not reopen it;
publish again after checking the closed PR and its reason.

If the workflow reports that the draft branch changed during three lease retries,
the editor saved continuously during publication. Wait for the CMS save to finish
and run the action again. The workflow did not overwrite any editor commit.

## Keep the content boundary intact

The publishing workflow is intentionally independent of the game renderer and
the reproducible media generator. It publishes only Markdown under
`content/wiki/` and raster uploads under `public/wiki/uploads/`. A code change,
configuration change, generated GIF, SVG, or other file must go through the normal
development branch and pull request flow.

After a wiki PR merges, Vercel's normal `main` deployment builds the Markdown
renderer and serves the manual at `/wiki/`. The publisher does not deploy Vercel,
run the media generator, or deploy the Railway game server.
