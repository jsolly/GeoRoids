import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRailwayContext, project, type ServiceNode } from 'railway/iac';
import { test } from 'vitest';
import { parse } from 'yaml';
import railway from '../.railway/railway.ts';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

/** The single non-empty shell assignment `name=value` (quotes stripped) in the build script. */
function scriptSetting(script: string, name: string): string {
  const values = script
    .split('\n')
    .filter((line) => line.startsWith(`${name}=`))
    .map((line) => line.slice(name.length + 1).replace(/^'(.*)'$/u, '$1'));
  assert.equal(values.length, 1, `scripts/railpack-build.sh must set ${name} exactly once`);
  const [value] = values;
  assert.ok(value, `scripts/railpack-build.sh must give ${name} a value`);
  return value;
}

async function productionService(): Promise<ServiceNode> {
  const definition = await railway(createRailwayContext(), project);
  const services = (definition.resources ?? [])
    .flat()
    .filter(
      (resource): resource is ServiceNode =>
        resource.type === 'service' && resource.name === 'geoasteroids'
    );
  assert.equal(services.length, 1, '.railway/railway.ts must define the geoasteroids service once');
  const [service] = services;
  assert.ok(service);
  return service;
}

test('CI builds with the Railpack release and start command Railway production uses', async () => {
  const service = await productionService();
  const script = read('scripts/railpack-build.sh');
  const version = scriptSetting(script, 'RAILPACK_VERSION');

  // Railway builds production with build.railpackVersion; the lane must run that same release.
  assert.match(service.build?.railpackVersion ?? '', /^\d+\.\d+\.\d+$/u);
  assert.equal(
    version,
    service.build?.railpackVersion,
    'scripts/railpack-build.sh RAILPACK_VERSION must equal build.railpackVersion in .railway/railway.ts'
  );
  assert.equal(scriptSetting(script, 'START_COMMAND'), service.deploy?.startCommand);
  assert.equal(service.build?.builder, 'RAILPACK');

  // Every download is that release, verified before use: the archive by SHA-256, the images by digest.
  assert.match(scriptSetting(script, 'RAILPACK_SHA256'), /^[0-9a-f]{64}$/u);
  assert.match(
    script,
    /^url="https:\/\/github\.com\/railwayapp\/railpack\/releases\/download\/v\$RAILPACK_VERSION\/\$archive"$/mu
  );
  assert.match(
    script,
    /^archive="railpack-v\$RAILPACK_VERSION-x86_64-unknown-linux-musl\.tar\.gz"$/mu
  );
  assert.match(
    script,
    /sha256sum --check --status <<<"\$RAILPACK_SHA256 {2}\$work\/railpack\.tar\.gz"/u
  );
  assert.equal(
    scriptSetting(script, 'RAILPACK_FRONTEND').replace(/@sha256:[0-9a-f]{64}$/u, ''),
    `ghcr.io/railwayapp/railpack-frontend:v${version}`
  );
  assert.match(
    scriptSetting(script, 'BUILDKIT_IMAGE'),
    /^moby\/buildkit:v[\d.]+@sha256:[0-9a-f]{64}$/u
  );

  // The pins are what the commands use: the start command plans, the images build.
  const lines = script.split('\n');
  for (const use of [
    '  --start-cmd "$START_COMMAND" ||',
    '  --driver-opt "image=$BUILDKIT_IMAGE" --bootstrap >/dev/null ||',
    '  --build-arg "BUILDKIT_SYNTAX=$RAILPACK_FRONTEND" \\',
  ]) {
    assert.ok(lines.includes(use), `scripts/railpack-build.sh must contain the line: ${use}`);
  }

  // The lane is the script, run on x64 like Railway's builder, and the required ci check needs it.
  const ci = parse(read('.github/workflows/ci.yml'));
  const lane = ci.jobs['railpack-build'];
  assert.equal(lane['runs-on'], 'ubuntu-24.04');
  assert.deepEqual(
    lane.steps
      .filter((step: { run?: string }) => /railpack/u.test(step.run ?? ''))
      .map((step: { run?: string; if?: string }) => [step.run, step.if]),
    [['bash scripts/railpack-build.sh', "steps.verified-tree.outputs.run_full != 'false'"]]
  );
  assert.ok(ci.jobs.ci.needs.includes('railpack-build'));
});
