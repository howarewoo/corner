export function repositoryName(value) {
  if (
    typeof value !== 'string' ||
    !/^[\w.-]+\/[\w.-]+$/.test(value) ||
    value.split('/').some((part) => part === '.' || part === '..')
  )
    throw new Error('Invalid repository identity.');
  return value;
}

export function githubClient({
  repository = process.env.GITHUB_REPOSITORY,
  token = process.env.GH_TOKEN,
  fetcher = fetch,
} = {}) {
  repositoryName(repository);
  if (!token) throw new Error('GH_TOKEN is required.');
  return async (path, { method = 'GET', body, missing = false } = {}) => {
    if ((path !== '' && !path.startsWith('/')) || path.includes('://') || path.startsWith('//'))
      throw new Error('Invalid GitHub API path.');
    const url = new URL(`https://api.github.com/repos/${repository}${path}`);
    if (
      url.origin !== 'https://api.github.com' ||
      (url.pathname !== `/repos/${repository}` && !url.pathname.startsWith(`/repos/${repository}/`))
    )
      throw new Error('Invalid GitHub API path.');
    const response = await fetcher(url, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (missing && response.status === 404) return null;
    if (!response.ok)
      throw new Error(`GitHub ${method} ${path.split('?')[0]} failed (HTTP ${response.status}).`);
    return response.status === 204 ? null : response.json();
  };
}

export async function pages(api, path, key) {
  const result = [];
  for (let page = 1; ; page++) {
    const response = await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    const rows = key ? response[key] : response;
    if (!Array.isArray(rows)) throw new Error('Incomplete GitHub list response.');
    result.push(...rows);
    if (rows.length < 100) return result;
  }
}
