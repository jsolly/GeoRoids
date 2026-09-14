import { defineRailway, github, preserve, project, service, volume } from 'railway/iac';

export default defineRailway(() => {
  const worldData = volume('world-data', { region: 'iad', sizeMB: 1024 });
  const geoasteroids = service('geoasteroids', {
    source: github('jsolly/GeoRoids', { branch: 'main' }),
    build: {
      builder: 'RAILPACK',
      buildEnvironment: 'V3',
    },
    deploy: {
      startCommand: 'node --import tsx server.ts',
      healthcheckPath: '/health',
      healthcheckTimeout: 300,
      requiredMountPath: '/data',
      multiRegionConfig: {
        iad: { numReplicas: 1 },
      },
      runtime: 'V2',
      // Railway's default is ON_FAILURE with 10 retries; its importer omits these values.
      useLegacyStacker: false,
      ipv6EgressEnabled: false,
    },
    // Preserve Railway-managed values without copying them into source.
    env: {
      DEPLOY_TRIGGER: preserve(),
      NODE_ENV: preserve(),
      GEOROIDS_WORLD_PATH: '/data/world.sqlite',
    },
    volumeMounts: { '/data': worldData },
    // Generated *.up.railway.app domains remain platform-managed. The
    // importer intentionally omits them; there are no custom domains here.
  });

  return project('GeoRoids', {
    resources: [worldData, geoasteroids],
  });
});
