// https://developers.cloudflare.com/workers/runtime-apis/nodejs/http/
// Keep this ABI scoped rather than introducing competing Worker global DOM types.
declare module 'cloudflare:node' {
  export function httpServerHandler(server: import('node:http').Server): {
    fetch(request: Request): Promise<Response>;
  };
}
