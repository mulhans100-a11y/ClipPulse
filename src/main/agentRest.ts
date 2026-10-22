import { createServer, type IncomingMessage, type Server } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError, asAppError } from '../core/errors';
import { AGENT_SCHEMA_VERSION, AgentService } from './agent';

export interface RestServiceHandle { server: Server; port: number; token: string; close(): Promise<void>; }

/** Local-only REST transport. It always binds loopback; browser origins are rejected to prevent localhost CSRF. */
export async function startAgentRest(service: AgentService, options: { port?: number; token?: string } = {}): Promise<RestServiceHandle> {
  const token = options.token?.trim() || randomBytes(32).toString('hex');
  if (token.length < 24) throw new AppError('INVALID_TOKEN', 'REST bearer token must contain at least 24 characters.');
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const host = request.headers.host?.toLowerCase() ?? '';
    if (!['127.0.0.1', '127.0.0.1:0', 'localhost', 'localhost:0'].includes(host) && !/^127\.0\.0\.1:\d+$/.test(host) && !/^localhost:\d+$/.test(host)) return send(response, 403, failure('LOOPBACK_ONLY', 'Requests must target the loopback service host.'));
    if (request.headers.origin) return send(response, 403, failure('BROWSER_ORIGIN_DENIED', 'Browser-origin requests are not accepted.'));
    const authorization = request.headers.authorization ?? '';
    if (!secureTokenEqual(authorization.startsWith('Bearer ') ? authorization.slice(7) : '', token)) return send(response, 401, failure('UNAUTHORIZED', 'A valid bearer token is required.'));
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/v1') {
        const result = { schemaVersion: AGENT_SCHEMA_VERSION, protocol: 'OpenMontage Agent REST', tools: service.tools.length, pathPermissions: service.allowedRoots };
        return send(response, 200, success(result));
      }
      if (request.method === 'GET' && url.pathname === '/v1/tools') return send(response, 200, success({ schemaVersion: AGENT_SCHEMA_VERSION, tools: service.tools }));
      if (request.method === 'GET' && url.pathname === '/v1/schema') return send(response, 200, success(await service.schemaDocument()));
      if (request.method === 'POST' && url.pathname.startsWith('/v1/tools/')) {
        const name = decodeURIComponent(url.pathname.slice('/v1/tools/'.length));
        const input = await readBody(request); return send(response, 200, success(await service.call(name, input)));
      }
      if (request.method === 'POST' && url.pathname === '/v1/transactions') {
        const input = await readBody(request); return send(response, 200, success(await service.call('project_transaction', input)));
      }
      return send(response, 404, failure('ROUTE_NOT_FOUND', 'No endpoint matches this method and path.'));
    } catch (error) {
      const appError = asAppError(error); return send(response, appError.code === 'INVALID_ARGUMENTS' ? 400 : appError.code === 'UNKNOWN_TOOL' ? 404 : 422, failure(appError.code, appError.message));
    }
  });
  const port = options.port ?? 43173;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const address = server.address(); const actualPort = typeof address === 'object' && address ? address.port : port;
  return { server, port: actualPort, token, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value); size += chunk.length;
    if (size > 10 * 1024 * 1024) throw new AppError('REQUEST_TOO_LARGE', 'Request body exceeds the 10 MiB limit.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch (error) { throw new AppError('INVALID_JSON', `Request body must be valid JSON: ${error instanceof Error ? error.message : error}`); }
}
function success(data: unknown) { return { schemaVersion: AGENT_SCHEMA_VERSION, ok: true, data }; }
function failure(code: string, message: string) { return { schemaVersion: AGENT_SCHEMA_VERSION, ok: false, error: { code, message } }; }
function send(response: import('node:http').ServerResponse, status: number, body: unknown): void { if (response.headersSent) return; response.statusCode = status; response.end(`${JSON.stringify(body)}\n`); }
function secureTokenEqual(candidate: string, expected: string): boolean { const left = Buffer.from(candidate); const right = Buffer.from(expected); return left.length === right.length && timingSafeEqual(left, right); }

