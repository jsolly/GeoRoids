# AWS static media preparation

Status: **prepared, not applied or migrated**. This repository owns its own
CloudFormation stack, immutable manifest and upload/verification tooling. All
current media stay tracked. The asset stack, uploads, access grants, DNS,
certificates and Railway configuration remain unapplied. Normal main CI and
the configured Vercel/Railway Git releases still run when this code is merged;
those code releases do not establish asset migration or cutover.

## Published scope and source exceptions

At main `1982ff0d4bfcc85dcfd913b512e570829dea6c63` the media inventory is:

| Scope | Files | Bytes | Treatment |
| --- | ---: | ---: | --- |
| Public music, Ogg and MP3 | 8 | 24,732,520 | Manifest candidates |
| Public generated M4A sound effects | 24 | 148,178 | Manifest candidates |
| Public Wiki GIFs and PNG posters | 20 | 7,178,094 | Manifest candidates |
| Published Wiki upload | 1 | 27,903 | Manifest candidate |
| Public favicon | 1 | 15,406 | Manifest candidate |
| Art, reviews and provenance | 31 | 1,039,961 | Tracked authoring sources |
| Wiki generator fonts | 2 | 825,388 | Tracked build inputs |
| Total | 87 | 33,967,450 | 54 candidates, 32,102,101 bytes |

`scripts/assets/references.ts` follows actual production sound/music catalogs,
parsed published Wiki articles, their active demonstrations and first-party
Wiki page image metadata. The one upload, `/wiki/uploads/georoids-first-flight.png`,
is already published as the Wiki OG image. Arbitrary files under `public/` do not
become candidates just because they exist. Missing referenced bytes fail.

The art/review/provenance tree, music README and reproduction instructions,
generators, `public/wiki/media/manifest.json`, font licenses and font inputs remain
tracked. They are not blindly uploaded. Generated application JS/CSS, server
code/data, tests, private runtime state and unrelated source assets are excluded.
The Vercel immutable asset map and all 13 historical client aliases remain under
the existing build/retention mechanism. Do not remove or migrate that mechanism.

## Repository-owned storage contract

`config/aws/static-assets/template.json` prepares a separate
`georoids-static-assets` stack in `us-east-1`. It creates encrypted, versioned S3
storage with all four public-access blocks enabled and ACLs disabled, plus a
CloudFront distribution using an always-signed OAC regional S3 REST origin.
The bucket policy permits only that distribution to read `sha256/*` and requires
TLS. There are no IAM roles, credentials, custom domains, DNS or certificates.
Bucket and bucket policy retain on deletion/replacement, and the supplied stack
policy protects them from replacement/deletion updates. No lifecycle expiration
or automatic old-object cleanup is configured.

Each committed manifest row pins the existing root-relative path, full SHA-256,
byte length, content type and immutable key:

```text
sha256/<full SHA-256>/music/menu-bed.ogg
```

Content types distinguish Ogg, MP3, M4A, GIF, PNG/WebP/JPEG and ICO. Every upload
uses `Cache-Control: public, max-age=31536000, immutable` and
`If-None-Match: *`. Existing correct objects are resumable; mismatched objects
stop the upload. There is no destructive sync, delete or deliberate overwrite.
The verifier GETs every actual delivery URL and compares bytes/hash, content type
and cache header. An ETag or metadata-only check cannot prove preservation.

## Offline checks

After repository setup and locked dependency installation:

```bash
npm run assets -- inventory
npm run assets -- check
npm run check:ts
npm run test -- tests/unit/tooling/static-assets.test.ts
npm run gate
```

`inventory` deliberately regenerates the committed manifest from the current
published production catalogs; review its diff. `check` rejects changed local
bytes, stale/unpublished entries and missing published references. Its tools use
TypeScript under the existing strict project and installed `tsx`; no second
runtime, new package dependency or cross-repository runtime import is added.

The offline tests exercise source/reference completeness, missing/hash-mismatched
objects, content/cache headers, idempotency, local-byte preflight, symlinks,
conditional upload capability targets, retry limits and brief negative-cache
visibility. The real CLI runs against this checkout's manifest. Tests do not
contact AWS or launch a browser.

Changing only the package command requires a scoped Wiki source review; the
accepted note records that player rules, controls, demonstrations and published
URLs are unchanged. No player-facing Wiki article needed an edit.

## Human apply and upload

John owns infrastructure apply and access. Review the template, policy,
manifest, retention and costs before using his existing approved capability.
These are handoff commands, not permission for an agent to acquire credentials:

```bash
aws cloudformation create-stack --region us-east-1 \
  --stack-name georoids-static-assets \
  --template-body file://config/aws/static-assets/template.json \
  --stack-policy-body file://config/aws/static-assets/stack-policy.json
aws cloudformation wait stack-create-complete --region us-east-1 \
  --stack-name georoids-static-assets
aws cloudformation describe-stacks --region us-east-1 \
  --stack-name georoids-static-assets --query 'Stacks[0].Outputs'
```

Keep the exact `BucketName`, `DeliveryOrigin` and `DistributionId` outputs. Wait
for CloudFront deployment. Review deterministic conditional upload commands:

```bash
npm run --silent assets -- plan BUCKET_NAME
```

The plan verifies all local manifest bytes before printing one AWS CLI PUT per
object and executes none. Each command supplies the manifest's base64 SHA-256
checksum, so S3 rejects a body changed after plan generation as well
([PUT checksum contract](https://docs.aws.amazon.com/cli/latest/reference/s3api/put-object.html#options)).
John can run the reviewed commands with approved write access. An existing-key
precondition failure calls for verification, never an overwrite or `sync --delete`.
Alternatively, an approved operator can provide an external JSON object mapping
each exact immutable key to a short-lived regional S3 presigned PUT URL. Sign for
the image/audio type, cache header and `If-None-Match: *`; treat that map as a
credential and keep it outside Git.

```bash
npm run assets -- upload DELIVERY_ORIGIN BUCKET_NAME /absolute/private/put-urls.json
npm run assets -- verify DELIVERY_ORIGIN /absolute/external/georoids-media-verification.json
```

No presigning, identity discovery or credential installation happens in this
repository tool. It accepts only exact manifest keys at the supplied stack
bucket's `s3.us-east-1.amazonaws.com` endpoint, preserves session proxy and CA
trust, refuses redirects and redacts transport error URLs. Every local file is
hash-checked before the first PUT. Existing objects are checked before reusing
them; each new upload is fetched and verified. Bounded retries include delayed
reads for CloudFront's minimum S3-origin negative-cache window.

Final verification needs only public CloudFront GET access. Its optional external,
create-only receipt binds the original manifest hash, origin, object count and
time. A manifest edit during verification rejects the receipt. Keep it alongside
an independent original-source snapshot. Verification failure cannot authorize
Git removal. CloudFormation `ValidateTemplate` succeeded on November 1, 2026;
this is syntax validation, not proof of stack creation or delivery access.

## Deferred cutover and rollback

The smallest follow-up materializes hash-pinned AWS objects into the existing
same-origin developer/build inputs before Wiki validation, compilation and
retention hashing. AWS becomes durable media storage; Vercel continues serving
unchanged public paths from deployment artifacts. The current preparation adds
no network dependency to ordinary builds and performs no materialization or Git
removal yet.

Preserving these paths keeps both Ogg and MP3 selection, Howler decoding and
crossfades, published Wiki links, no-JavaScript posters, reduced-motion behavior
and Linux-generated GIF/poster signatures intact. Browser audio does not switch
to CloudFront, so no new CORS policy is required here. A future direct-origin
rewrite or cross-origin design needs separate review and real audio/CORS evidence;
a 302 to CloudFront does not preserve same-origin behavior.

Before removing exactly the selected tracked media:

1. Verify all 54 objects and save the exact-manifest receipt and independent
   original source snapshot. Confirm unauthenticated S3 reads fail while intended
   CloudFront URLs work.
2. Implement repository-owned atomic hydration, precise ignore rules and verified
   missing-byte recovery. Prove a fresh checkout builds using declared inputs,
   without another checkout or untracked one-off source directory. Keep fake
   transports for offline tests; describe cold-build network needs honestly.
3. Preserve local Wiki image signatures, reproducible Linux GIF/poster hashes and
   `public/wiki/media/manifest.json` evidence. Keep source/generator/font inputs.
   Preserve retained client aliases and immutable JS/CSS output.
4. Replace PagesCMS Git-backed media intake with a reviewed external upload flow
   before disabling the current editor workflow. Do not publish drafts/private
   files or reintroduce new binary uploads to Git silently.
5. Run the complete gate, Wiki media lane, independent review and exact-head draft
   PR CI. Classify server-release inputs with the existing helper: the package
   command is a server-classified manifest input even though server behavior is
   unchanged. This classification does not authorize any Railway operation.

Until then, rollback is the untouched current source and serving behavior. After
cutover, restore the previous manifest and hydrate its retained objects, or use
the independent source snapshot. Retain immutable old keys indefinitely; no Git
history rewrite, bucket deletion or old-release cleanup is part of this work.

## Cost before apply

Initial selected payload: 32.1 MB, about 0.030 GiB, 54 objects. At an illustrative
$0.03/GB-month storage rate a single retained copy would cost roughly $0.001/month;
use the actual selected region's current rate before apply. Object versions and
retained releases accumulate. Initial transfer requires up to 54 PUTs plus
verification GETs; each uncached hydration would download about 32.1 MB.

CloudFront uses PriceClass_100 with usage billing and no plan subscription. Its
requests/transfer and existing Vercel delivery costs remain traffic-dependent.
Free allowances may already be consumed elsewhere in the account. Review
[S3 pricing](https://aws.amazon.com/s3/pricing/) and
[CloudFront pricing](https://aws.amazon.com/cloudfront/pricing/) with expected
build/request volume before applying. No image-transformation service, analytics
tier or additional logging bucket is introduced.
