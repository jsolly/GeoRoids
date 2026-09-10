import { defineRailway, github, preserve, project, service } from 'railway/iac';

export default defineRailway(() => {
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
      REQUIRE_ASTEROID_CLIENT: preserve(),
    },
    // Generated *.up.railway.app domains remain platform-managed. The
    // importer intentionally omits them; there are no custom domains here.
  });

  return project('GeoRoids', {
    resources: [geoasteroids],
  });
});
