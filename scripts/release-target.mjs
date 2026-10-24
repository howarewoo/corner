// Runtime credentials are environment-scoped; Worker names are never caller-supplied.
export function releaseTarget(environment = process.env.CORNER_RELEASE_ENVIRONMENT ?? 'production') {
  if (!['production', 'staging'].includes(environment)) throw new Error('Unknown release environment.');
  const staging = environment === 'staging';
  return {
    environment, staging, branch: staging ? 'staging' : 'main', kind: `corner-${environment}`,
    workerName: staging ? 'corner-server-staging' : 'corner-server',
    frontendName: staging ? 'corner-web-staging' : 'corner-web',
    prefix: staging ? 'CORNER_STAGING' : 'CORNER_PRODUCTION',
  };
}
