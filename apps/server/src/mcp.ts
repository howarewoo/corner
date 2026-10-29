import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { DELEGATED_PERMISSIONS } from '@packages/api/delegation';
import type { DelegationService } from './delegation.js';
import type { WorkspaceStore } from './store.js';
import { createReadMcpServer } from './mcp-reads.js';
import { ApiError, json, readJson } from './http.js';
import { registerNutritionWrites } from './mcp-writes.js';
import { registerTrainingWrites } from './mcp-training.js';
import type { OriginalToolArguments } from './mcp-writes.js';
import { registerImports } from './mcp-imports.js';
import { MAX_MCP_REQUEST_BYTES } from './additive-import.js';

export function protectedResourceMetadata(origin: string) {
  return json({
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    bearer_methods_supported: ['header'],
    scopes_supported: DELEGATED_PERMISSIONS.map(({ scope }) => scope),
    resource_name: 'Corner workspace',
  });
}

export async function handleMcp(
  request: Request,
  store: WorkspaceStore,
  delegation: DelegationService,
  origin: string,
): Promise<Response> {
  const suppliedOrigin = request.headers.get('Origin');
  if (suppliedOrigin && suppliedOrigin !== origin)
    throw new ApiError(403, 'ORIGIN_NOT_ALLOWED', 'Use the configured Corner origin.');
  const access = await delegation.authenticate(request, store.db);
  if (!access)
    return json({ error: 'A current delegated access token is required.' }, 401, {
      'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", error="invalid_token"`,
    });
  const parsedBody = request.method === 'POST' ? await readJson(request, MAX_MCP_REQUEST_BYTES) : undefined;
  if (Array.isArray(parsedBody))
    throw new ApiError(400, 'INVALID_INPUT', 'Use one JSON-RPC request at a time.');
  if (parsedBody && typeof parsedBody === 'object' && 'id' in parsedBody &&
      Buffer.byteLength(JSON.stringify(parsedBody.id), 'utf8') > 256)
    throw new ApiError(400, 'INVALID_INPUT', 'The JSON-RPC request ID is too large.');
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: MAX_MCP_REQUEST_BYTES,
  });
  const server = createReadMcpServer(store, access);
  const original: OriginalToolArguments = (tool) => {
    if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody))
      throw new ApiError(400, 'INVALID_INPUT', 'Use one tool call per request.');
    if (
      !('params' in parsedBody) ||
      !parsedBody.params ||
      typeof parsedBody.params !== 'object' ||
      Array.isArray(parsedBody.params)
    )
      throw new ApiError(400, 'INVALID_INPUT', 'Original tool arguments are required.');
    const params = parsedBody.params;
    if (
      !('method' in parsedBody) ||
      parsedBody.method !== 'tools/call' ||
      !('name' in params) ||
      params.name !== tool ||
      !('arguments' in params)
    )
      throw new ApiError(400, 'INVALID_INPUT', 'Original tool arguments are required.');
    return params.arguments;
  };
  registerNutritionWrites(server, store, access, original);
  registerTrainingWrites(server, store, access, original);
  registerImports(server, store, access, original);
  try {
    await server.connect(transport);
    // Authentication is repeated for every request; SDK sessions never become an authority.
    return await transport.handleRequest(request, { parsedBody });
  } finally {
    await server.close();
  }
}
