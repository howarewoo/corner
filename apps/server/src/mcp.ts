import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { DELEGATED_READ_PERMISSIONS } from '@packages/api/delegation';
import type { DelegationService } from './delegation.js';
import type { WorkspaceStore } from './store.js';
import { createReadMcpServer } from './mcp-reads.js';
import { ApiError, json, readJson } from './http.js';

export function protectedResourceMetadata(origin: string) {
  return json({
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    bearer_methods_supported: ['header'],
    scopes_supported: DELEGATED_READ_PERMISSIONS.map(({ scope }) => scope),
    resource_name: 'Corner workspace reads',
  });
}

export async function handleMcp(request: Request, store: WorkspaceStore, delegation: DelegationService, origin: string): Promise<Response> {
  const suppliedOrigin = request.headers.get('Origin');
  if (suppliedOrigin && suppliedOrigin !== origin) throw new ApiError(403, 'ORIGIN_NOT_ALLOWED', 'Use the configured Corner origin.');
  const access = await delegation.authenticate(request, store.db);
  if (!access) return json({ error: 'A current delegated access token is required.' }, 401, {
    'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", error="invalid_token"`,
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: 192 * 1024 });
  const server = createReadMcpServer(store, access);
  try {
    await server.connect(transport);
    const parsedBody = request.method === 'POST' ? await readJson(request) : undefined;
    // Authentication is repeated for every request; SDK sessions never become an authority.
    return await transport.handleRequest(request, { parsedBody });
  } finally {
    await server.close();
  }
}
