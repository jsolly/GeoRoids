# Private world backups

This implementation is disabled until explicitly configured. Local SQLite and
owned S3-compatible fixtures prove the code path. They do not establish a real
off-volume backup or a production restore drill. John owns resource creation,
credentials, production configuration, uploads of real player data and any
actual restore. Those operations require separate approval of these artifacts.

Establish volume health first. Ship the disabled backup CLI with the stopped
exploration tooling, then take and verify a fresh off-volume legacy snapshot and
rehearse its restore before exploration activation. After the exploration
transition passes its own verification, enable recurring backup scheduling.
Research ordering is not permission to migrate without recovery evidence.

## Ownership and flow

Putting this work on the existing persistence worker would delay gameplay
checkpoints behind snapshot validation and network waits. An external scheduled
service would need its own reviewed access to the mounted world and shutdown
ownership. The child process keeps disk/CPU work outside both existing workers
and lets the server kill a native SQLite hang without holding shutdown open.

`server.ts` starts an optional scheduler outside the simulation. It launches
one separate Node process, not a task on the game or persistence worker. That
process opens the source read-only and uses Node SQLite's online backup API in
16-page steps. Committed WAL content and every table, including unrelated future
tables, are included. Copying the live main file alone is never a backup.

The child reads its isolated artifact through `PRAGMA integrity_check`, foreign
key checks, table identity checks and the same saved-world, sector, pilot and
economy parsers as ordinary boot. It checks duplicate asteroid and pilot row
identities, generation, exploration and cooperative schema/records. The exploration
format owner selects the legacy atlas for prepared or stale preparation and tile
rows only for active storage. Snapshot fixtures cover all four states and verify
unchanged source rows and artifact bytes. An inspected active-format artifact still
requires the compatible reader for its restore drill; inspection does not activate
storage or certify that an older server can boot it. Validation
never constructs WorldStore, repairs rows, creates a table or rewrites the
artifact. The backup retains legacy values even where the runtime parser returns
a normalized in-memory value. SQLite integrity alone cannot prove a playable
world.

The scheduler gives each process five minutes, lowest scheduling priority and
512 MiB of JavaScript heap. Each SQLite artifact is limited to 512 MiB, with at
most two artifacts in one job. The dedicated ephemeral staging filesystem must
have at least 1,088 MiB free before work starts. Staging must be outside the
canonical source-world directory, including symlinks. The known persistent
volume is 1,024 MiB, so it cannot satisfy this policy and must not hold backup
staging. These are hard rejection limits, not truncation rules. Native
allocations also share the server container's RAM. Review container memory and
volume headroom before activation; raise the reviewed policy in code if the
world outgrows it. Sector rows and pilot rows are inspected through SQLite
iterators. The legacy atlas, an individual sector and duplicate-asteroid
identity index still need memory. No second complete world is loaded for backup
validation.

Objects use deterministic UTC slots `daily/world-identity/YYYY-MM-DD.sqlite` and
`weekly/world-identity/YYYY-MM-DD.sqlite`. The weekly date is Monday; the first
successful daily backup of that week fills it. Uploads use `If-None-Match: *`,
SSE-S3 AES256 and SHA256 checksum metadata. After upload, the child streams an
actual GET into a new file, checks its exact SHA256 and length, then repeats
SQLite/domain checks. It checks the returned SHA against the uploaded artifact
when its conditional upload succeeded. Each slot attempts its conditional PUT
before GET. A missing GetObject returns 403 without ListBucket permission, so
the worker does not probe for absence or mistake access denial for a missing
backup. A concurrent winner or response-lost retry is independently validated
and reused. Existing slots are never overwritten. Each namespace is the SHA256
of seed, start time and generation, which ordinary checkpoints preserve. A
deliberate generation reset creates a fresh namespace immediately, even within
the same day or week. Reuse also checks that the downloaded world's identity
matches the namespace. An accidentally shared bucket cannot turn another world's
slot into a successful backup for this world. A completed run sleeps until the
next UTC day; failures retry after 15 minutes. If a job crosses midnight, the
scheduler immediately checks the new UTC day. Restart takes a fresh bounded
local snapshot and attempts the current slots. Existing objects win the
conditional writes and undergo exact verification, so a restart cannot postpone
backup for another day or require bucket listing. There is no catch-up fiction
for days the service was down.

The bucket expires daily objects after 30 days and weekly objects after 84 days.
S3 lifecycle deletion is asynchronous and can occur after the expiry date. There
is no versioning or delete permission for the uploader, so conditional writes
cannot accumulate hidden old versions. Artifact SHA256, hashed world identity
and counts are safe receipts; names, credentials, row values, database paths and
raw SDK/validation errors are never included in backup logs. The server emits
`backup_verified`, `backup_failed` or `backup_deadline`. A child failure emits
one fixed error event and exits nonzero. Shutdown kills and awaits its owned
child before closing persistence. A killed child can leave its private staging
directory; the next job removes only recognizable directories whose owning
process no longer exists.

A backup is consistent at a committed SQLite point during the online copy. It
can lag current in-memory gameplay by the normal write-behind checkpoint period.
A successful S3 verification does not certify a restore drill.

## Review the AWS resources

The [resource validation review](world-backup-resource-review.md) records the
exact template, validator results and proposed dispositions of managed-rule flags.

Review `config/aws/world-backups/template.json`, `stack-policy.json`,
`uploader-policy.json` and `restore-policy.json`. The template creates one
private bucket with all four public access blocks, bucket-owner-enforced
ownership, AES256 default encryption and explicit TLS/encryption/create-only
bucket denies. There is no website endpoint, public read grant, CloudFront
distribution or ACL. The bucket and policy have Retain deletion/replacement
policies. The stack policy rejects their deletion or replacement during updates.
Enable stack termination protection at creation. These controls protect
accidental infrastructure removal; the account owner can still change policies
deliberately.

The uploader needs only `s3:PutObject` and `s3:GetObject` on the two prefixes.
It has no listing, deletion, bucket administration or IAM access. Restore uses a
separate read-only principal. The policy files are review templates and refuse
to name a real resource until their bucket ARN placeholder is replaced. Choose a
supported credential delivery mechanism separately. No user, key, secret, role
trust policy or credentials were created by this implementation.

John selected the connected AWS account and us-east-1 for these backups. That
selects the target only. Resource creation, access and activation still require
review and separate approval. Keep exact account identity in the private
approval record; the template uses CloudFormation pseudo parameters and no
account ID. Prefer the connected AWS MCP tools for the eventual read-only
resource review and approved operations, explicitly targeting us-east-1. Do not
create another login or credential to prepare these artifacts.

No repository AWS CLI profile is documented. The CLI fallback below must not run
until John identifies a named profile for the selected account. It has no
default profile or region fallback. If using the connected MCP, no CLI profile
is needed. The proposed stack name is `georoids-world-backups-production`, in
us-east-1 and the selected connected account ending 6323. Before any cloud
operation, record the exact account identity privately, stack name, returned
bucket ARN and credential principal.

The following commands are a proposed human-owned apply plan, not operations
performed by this change. Fill the reviewed profile and stack name in your local
shell:

```sh
: "${GEOROIDS_AWS_PROFILE:?Set the reviewed repository AWS profile}"
GEOROIDS_BACKUP_REGION=us-east-1
GEOROIDS_BACKUP_STACK=georoids-world-backups-production
aws --profile "$GEOROIDS_AWS_PROFILE" --region "$GEOROIDS_BACKUP_REGION" sts get-caller-identity
aws --profile "$GEOROIDS_AWS_PROFILE" --region "$GEOROIDS_BACKUP_REGION" cloudformation create-stack \
  --stack-name "$GEOROIDS_BACKUP_STACK" \
  --template-body file://config/aws/world-backups/template.json \
  --stack-policy-body file://config/aws/world-backups/stack-policy.json \
  --enable-termination-protection
aws --profile "$GEOROIDS_AWS_PROFILE" --region "$GEOROIDS_BACKUP_REGION" cloudformation wait stack-create-complete \
  --stack-name "$GEOROIDS_BACKUP_STACK"
aws --profile "$GEOROIDS_AWS_PROFILE" --region "$GEOROIDS_BACKUP_REGION" cloudformation describe-stacks \
  --stack-name "$GEOROIDS_BACKUP_STACK"
```

Before giving the uploader credentials, inspect the actual bucket's public
access blocks, encryption, policy, lifecycle, stack policy and termination
protection. The bucket name is CloudFormation-generated, not guessed.
CloudFormation schema/compliance validation and independent review remain
pending. The local policy fixture checks authored policy contracts only.

## Proposed access and cost

The resource request is exactly `AWS::S3::Bucket` and `AWS::S3::BucketPolicy` in
the named stack. It permits CloudFormation CreateStack, its read-only status and
output checks, and the S3
bucket/encryption/public-block/ownership/lifecycle/policy operations needed by
that template. There is no DNS, CloudFront, KMS, versioning, volume expansion,
database migration or player-data upload in resource creation. Creating the
stack, its IAM access and the first real upload are separate review items, even
when approved together in one concrete plan.

A workable uploader option is a dedicated IAM user named
`georoids-world-backup-uploader-production`, with no console password or group
membership. John creates it and binds the reviewed uploader policy after
replacing the bucket ARN placeholder with the actual output. The exact IAM
operations are CreateUser, PutUserPolicy and CreateAccessKey. This identity has
only PutObject/GetObject on `daily/*` and `weekly/*`; it has no IAM, ListBucket,
DeleteObject or bucket administration rights. Do not attach broad AWS-managed S3
policies. No Railway workload OIDC integration is documented here, so this plan
does not assume one exists.

John creates one access key and seals its values directly into the selected
Railway service's secret variables `AWS_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY`. Agents do not create, read, print, paste or retain the
secret. Keep `GEOROIDS_BACKUP_ENABLED` absent or `0` while provisioning and
testing an approved one-shot command. Record the credential owner and rotation
date. Rotation creates a second key, replaces the sealed variables, restarts and
verifies an exact S3 backup, then deactivates and deletes the old key after the
new one succeeds. Rotation and revocation are separate human-owned operations.

Restore uses the separate GetObject-only policy bound to John's approved
existing human principal, never the uploader key. The exact principal binding
and local named AWS profile are still required inputs; none was invented or
created. The connected AWS MCP identity can perform separately approved
checks/downloads if its existing permissions cover them. A local CLI fallback
must name the reviewed restore profile. The policies deliberately omit listing;
select exact keys from the safe day/world-identity receipts.

For one stable world at the 512 MiB cap, 30 daily plus 12 weekly artifacts total
about 21 GiB before asynchronous lifecycle deletion. Generation resets retain
older namespaces until their own expiry. Charges come from S3 Standard storage,
PUT/GET requests and data transfer out to Railway or the restore machine. Each
daily verification downloads at most two 512 MiB artifacts, about 30 GiB per
30-day month at the cap, plus restarts, retries and restore drills. There are
roughly 60 conditional PUT attempts and 60 GETs per 30-day month, plus retries
and restarts. About 30 daily objects and four or five weekly objects are
created. Conditional attempts may also transmit upload bytes, which can incur
Railway data-transfer charges. Actual world sizes may be much smaller. Check
current us-east-1/account pricing and Railway ephemeral disk/CPU costs before
approval; no dollar estimate or free tier is assumed. SSE-S3 needs no separate
KMS key or KMS requests.

## Pre-migration recovery proof

After resource/access approval and volume-health verification, deploy the
reviewed legacy-compatible backup and offline exploration tools with scheduling
disabled. Before exploration activation, John arranges a stopped-writer
maintenance window through the established Railway procedure. Do not assume a
remote working directory or that a stopped service supports SSH. Confirm the
reviewed application root, volume path and actual approved maintenance access.

Run one separately approved backup command against the existing legacy world,
using sealed uploader credentials and the reviewed private bucket. The command's
`GEOROIDS_BACKUP_ENABLED=1` applies to that process only; it does not enable the
server scheduler. Verify the actual off-volume GET digest and download that
exact artifact with separate restore access. Run the isolated restore rehearsal
and retain its safe evidence before authorizing exploration activation. If any
step fails, keep the original world and do not activate the transition. Retain
the platform volume backup as well. The local fixture proof below does not
satisfy this production preflight.

## Activate and observe

After reviewing the private bucket and credential delivery, John configures the
exact production Railway service using its established human-owned workflow:

```text
GEOROIDS_BACKUP_ENABLED=1
GEOROIDS_BACKUP_BUCKET=<reviewed private bucket name>
GEOROIDS_BACKUP_REGION=us-east-1
GEOROIDS_BACKUP_STAGING=/tmp/georoids-world-backups
```

Retain `GEOROIDS_WORLD_PATH=/data/world.sqlite` and the mounted `/data` volume.
The AWS SDK uses the selected credential delivery mechanism; missing credentials
fail the job. Production accepts no custom S3 endpoint or fallback destination.
The staging directory is private ephemeral storage, belongs only to this worker
and must have the stated headroom. Before activation, verify actual Railway
ephemeral filesystem capacity with statfs and available container memory at the
reviewed release. No volume expansion or configuration mutation was performed or
authorized by this plan. Do not put unrelated files there. Incomplete enabled
configuration fails startup before scheduling. Leaving the flag absent or `0`
performs no backup work.

Deploy the integrated reviewed release only after the preceding recovery proof
and exploration transition verification pass. Observe a `backup_verified` event,
then use the read-only restore principal to retrieve that exact date's object
and compare its SHA256 with the retained receipt. Check both daily and weekly
lifecycle rules on the real bucket. Record a next-day run and a restart/retry
check before calling the schedule verified. Error events remain failures until a
later run succeeds; the game may continue meanwhile. No automatic reset or
stale-volume fallback is permitted.

## Restore rehearsal and recovery

Keep the downloaded object unchanged as evidence. The inspection command reads
it without logging pilot rows. It rejects nonempty WAL/rollback journals beside
the artifact; hashing a live main file would omit committed journal data:

```sh
node --import tsx scripts/world-backup.ts inspect /absolute/downloaded-world.sqlite
```

The read-only download tool requires the deliberately selected key, an
independent expected SHA256 and a new private directory. It never overwrites an
existing destination. Use the separate restore principal through the selected
credential delivery mechanism, with explicit bucket and region environment
values. Running this against real player data remains a separately approved
operation.

```sh
: "${AWS_PROFILE:?Set the reviewed named restore profile; none is selected yet}"
GEOROIDS_BACKUP_REGION=us-east-1 node --import tsx scripts/download-world-backup.ts daily/world-identity/YYYY-MM-DD.sqlite expected-sha256 /absolute/new-download-directory
node --import tsx scripts/rehearse-world-restore.ts /absolute/new-download-directory/world.sqlite expected-sha256 /absolute/new-rehearsal-directory
```

The download CLI refuses an absent named AWS profile rather than using a
default. The local rehearsal command refuses a Railway environment. It verifies
the independent digest, copies through SQLite's online backup into an
exclusively created scratch directory, binds the actual server to 127.0.0.1,
negotiates a real WebSocket join, accepts movement and firing, and observes a
healthy flushed checkpoint. The scratch copy is removed after success or
ordinary failure. A hard-killed local command may leave its private scratch
directory for explicit cleanup. The downloaded evidence remains unchanged. It
never replaces the live volume, resumes a real player's session or claims a
production recovery.

Select the exact key/date and expected SHA256 deliberately. Verify the download
against that independent receipt before any boot. Restore to a new, isolated
local database or volume, never over the live SQLite writer. Retain the original
volume and its WAL/SHM files. If the artifact contains the legacy atlas or a
prepared/stale exploration copy, the atlas remains authoritative. Use the
matching legacy reader or the explicit stopped prepare/activate transition
before starting the new tile-table runtime. An active backup uses its tile rows.
An older generation needs its compatible reviewed server release or a separately
reviewed migration. The current inspector refuses an artifact that its runtime
would reset on boot. Never change the saved generation merely to bypass that
check. Never manufacture an empty atlas or let startup rewrite a transition.

The owned fixture test
`tests/unit/server/world-backups-survive-wal-and-verify-remote-bytes.test.ts`
boots a separate restored copy, resumes the saved pilot using its original
private token, fires an accepted projectile and persists a subsequent
checkpoint. The separate server integration fixture executes the actual local
rehearsal tool flow over loopback. Together they check retained seed,
generation, inactive campaign state, exact legacy rows and an unrelated
auxiliary table committed in WAL. This is local fixture proof.

A real restore drill is still required after separate approval. Use an isolated
volume and the reviewed server release. Verify genuine join with snapshot v3,
asteroid interactions and cooperative capability, accepted movement/firing,
restored discoveries, furnaces, sectors, economy, pilot resume and subsequent
healthy persistence. Retain the selected key/date/SHA256, safe inspection
counts, release, isolated target identity, gameplay results and cleanup outcome.
Do not copy private row values or bearer tokens into the drill record. Local
fixtures cannot substitute for that record.

For an actual recovery, stop live play and the writer first. Follow [persistent
world recovery](persistent-world.md#railway-deployment-and-recovery). John
explicitly chooses the rollback point because restoring an older artifact loses
later play. Inspect the restored database before restarting. Never discard or
overwrite a live WAL/SHM pair and never silently choose a stale volume.

## Rollback

Set `GEOROIDS_BACKUP_ENABLED=0` and restart the reviewed service. This stops
scheduling and kills any owned job during graceful shutdown; gameplay
persistence keeps its existing contract. Keep already uploaded backups and the
private bucket. Revoke the dedicated uploader credential separately if needed.
Do not disable public access blocks, encryption, TLS enforcement or lifecycle as
rollback. Stack deletion retains the bucket and policy and is not a cleanup
procedure.

## Local verification and integration

The backup inspector shares the metadata parser in
`server/world/savedWorld.ts` with the legacy runtime and exploration transition
tooling. The legacy runtime validates its required atlas at its actual reader.
The inspector uses `inspectExplorationStorage` and
`assertExplorationDatabaseIntegrity` from `explorationSchema.ts`. Legacy,
prepared and stale-preparation backups count the authoritative legacy atlas;
active backups count the tile rows. Inspection never supplies an empty atlas or
rewrites the saved format.

Focused backup fixtures cover all four storage states, exact source preservation,
committed WAL content, sparse implicit rowids, sequence counters and opaque
SQLite storage classes. The shared fingerprint distinguishes INTEGER, REAL,
NULL, raw TEXT and BLOB values, including adjacent int64 values and malformed
UTF-8 in unrelated private tables. Snapshot receipts contain only identity hashes,
file metadata and aggregate counts. Run the complete local gate on the combined
branch before publication. A local fixture is not an actual off-volume backup
or a production restore drill.

No in-game Wiki page changes: this is operator-only backup tooling and changes
no player controls or gameplay rules. The full gate and integrated rollout proof
remain required before publication and acceptance.
