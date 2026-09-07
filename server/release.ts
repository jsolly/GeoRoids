/** Railway injects the deployed Git revision; local runs have no release identity. */
export const SERVER_RELEASE_ID = process.env.RAILWAY_GIT_COMMIT_SHA || 'dev';
