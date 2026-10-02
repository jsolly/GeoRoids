import { createHash } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { regionalSnapshotWork } from './regional-scan-workload';

type EvidenceMetadata = NonNullable<ReturnType<typeof regionalSnapshotWork>> & {
  ownerId: string;
  measured: boolean;
};

const MAX_FRAMES = 32;
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = MAX_ARTIFACT_BYTES - 64 * 1024;
const MIN_FRAME_BYTES = 64 * 1024;

/** Driver-side evidence only: no browser work, world copies, or field partitioning. */
export class LargeSnapshotEvidence {
  private readonly frames: Array<{ metadata: EvidenceMetadata; text: string; bytes: number }> = [];
  private candidateFrames = 0;
  private candidateBytes = 0;
  private retainedBytes = 0;
  private exhausted = false;

  /** Call only after the existing wire decoder successfully admitted a snapshot. */
  offer(text: string, metadata: EvidenceMetadata): void {
    const bytes = Buffer.byteLength(text);
    if (bytes < MIN_FRAME_BYTES) {
      return;
    }
    // Production snapshot serialization starts with this control discriminator.
    // Never archive join/resume/control envelopes or their private credentials.
    if (!/^\s*\{\s*"type"\s*:\s*"snapshot"\s*,/u.test(text) || /"resumeToken"\s*:/u.test(text)) {
      throw new Error('Large-frame archive accepts credential-free snapshot envelopes only');
    }
    this.candidateFrames++;
    this.candidateBytes += bytes;
    if (
      this.exhausted ||
      this.frames.length >= MAX_FRAMES ||
      this.retainedBytes + bytes > MAX_PAYLOAD_BYTES
    ) {
      this.exhausted = true;
      return;
    }
    this.frames.push({ metadata: { ...metadata }, text, bytes });
    this.retainedBytes += bytes;
  }

  report() {
    return {
      policy:
        'Prefix of successfully decoded large browser snapshot envelopes; field partitioning occurs after measurement.',
      minimumFrameBytes: MIN_FRAME_BYTES,
      maximumFrames: MAX_FRAMES,
      maximumArtifactBytes: MAX_ARTIFACT_BYTES,
      candidateFrames: this.candidateFrames,
      candidateBytes: this.candidateBytes,
      retainedFrames: this.frames.length,
      retainedPayloadBytes: this.retainedBytes,
      omittedFrames: this.candidateFrames - this.frames.length,
      omittedPayloadBytes: this.candidateBytes - this.retainedBytes,
    };
  }

  async save(path: string) {
    // Insert each already-validated envelope directly, avoiding escaped duplicate
    // payloads. Its exact original UTF-8 representation is independently hashed.
    const frames = this.frames.map(
      ({ metadata, text, bytes }) =>
        `{"metadata":${JSON.stringify(metadata)},"bytes":${bytes},"sha256":${JSON.stringify(createHash('sha256').update(text).digest('hex'))},"envelope":${text}}`
    );
    const artifact = `{"receipt":${JSON.stringify(this.report())},"frames":[${frames.join(',')}]}`;
    const artifactBytes = Buffer.byteLength(artifact);
    if (artifactBytes > MAX_ARTIFACT_BYTES) {
      throw new Error('Large-frame archive exceeded its explicit artifact byte bound');
    }
    await mkdir(dirname(path), { recursive: true });
    const file = await open(path, 'w', 0o600);
    try {
      await file.chmod(0o600);
      await file.writeFile(artifact, 'utf8');
    } finally {
      await file.close();
    }
    return {
      ...this.report(),
      path,
      artifactBytes,
      sha256: createHash('sha256').update(artifact).digest('hex'),
    };
  }
}
