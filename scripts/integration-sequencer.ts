import { createRequire } from 'node:module';
import { BaseSequencer, type TestSpecification } from 'vitest/node';

const require = createRequire(import.meta.url);
const {
  selectShard,
  MAX_ACTIVE_SHARDS,
}: {
  MAX_ACTIVE_SHARDS: number;
  selectShard: (plan: unknown, files: string[], index: number, count: number) => string[];
} = require('./integration-shard-plan.mjs');
const {
  authorizeSequencer,
}: {
  authorizeSequencer: () => { index: number; total: number; maxActive: number; plan: unknown };
} = require('./integration-shards.mjs');

export class IntegrationSequencer extends BaseSequencer {
  override shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const record = authorizeSequencer();
    const shard = this.ctx.config.shard;
    if (
      !shard ||
      shard.index !== record.index ||
      shard.count !== record.total ||
      record.maxActive !== MAX_ACTIVE_SHARDS
    ) {
      throw new Error('Vitest shard differs from issued child assignment');
    }
    const selected = new Set(
      selectShard(
        record.plan,
        files.map((file) => file.moduleId),
        shard.index,
        shard.count
      )
    );
    return Promise.resolve(files.filter((file) => selected.has(file.moduleId)));
  }
}
