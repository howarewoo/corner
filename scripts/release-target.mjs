// Runtime credentials are environment-scoped; Worker names are never caller-supplied.
export function releaseTarget(
  environment = process.env.CORNER_RELEASE_ENVIRONMENT ?? 'production',
) {
  if (environment !== 'production') throw new Error('Release controller supports production only.');
  return {
    environment,
    branch: 'main',
    kind: 'corner-production',
    workerName: 'corner',
    prefix: 'CORNER_PRODUCTION',
  };
}
