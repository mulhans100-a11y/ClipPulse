import { createInterface } from 'node:readline';
import { AppError, asAppError } from '../core/errors';
import { AGENT_SCHEMA_VERSION, AgentService } from './agent';

type JsonRpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: any };

/** MCP stdio transport: newline-delimited JSON-RPC, protocol output only on stdout. */
export async function runAgentMcp(service: AgentService, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let request: JsonRpcRequest;
    try { request = JSON.parse(line) as JsonRpcRequest; }
    catch { write(output, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
    if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      if ('id' in request) write(output, { jsonrpc: '2.0', id: request.id ?? null, error: { code: -32600, message: 'Invalid Request' } });
      continue;
    }
    if (request.method.startsWith('notifications/')) continue;
    try {
      const result = await dispatch(service, request);
      write(output, { jsonrpc: '2.0', id: request.id ?? null, result });
    } catch (error) {
      const appError = asAppError(error); const methodError = appError.code === 'METHOD_NOT_FOUND' ? -32601 : -32602;
      write(output, { jsonrpc: '2.0', id: request.id ?? null, error: { code: methodError, message: appError.message, data: { appCode: appError.code } } });
    }
  }
}

async function dispatch(service: AgentService, request: JsonRpcRequest): Promise<any> {
  switch (request.method) {
    case 'initialize': return { protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'clippulse', version: '0.1.0' }, instructions: `ClipPulse agent tools schema version ${AGENT_SCHEMA_VERSION}. All filesystem paths must be inside granted roots.` };
    case 'ping': return {};
    case 'tools/list': return { tools: service.tools };
    case 'tools/call': {
      const name = request.params?.name; if (typeof name !== 'string') throw new AppError('INVALID_ARGUMENTS', 'tools/call requires params.name.');
      try {
        const value = await service.call(name, request.params.arguments ?? {});
        const { content, structuredContent } = mcpResult(value);
        return { content, structuredContent, isError: false };
      } catch (error) {
        const appError = asAppError(error); return { content: [{ type: 'text', text: JSON.stringify({ schemaVersion: AGENT_SCHEMA_VERSION, code: appError.code, message: appError.message }) }], structuredContent: { schemaVersion: AGENT_SCHEMA_VERSION, ok: false, error: { code: appError.code, message: appError.message } }, isError: true };
      }
    }
    default: throw new AppError('METHOD_NOT_FOUND', `Unsupported MCP method: ${request.method}`);
  }
}

function mcpResult(value: any): { content: any[]; structuredContent: unknown } {
  const images: Array<{ mimeType: string; data: string }> = [];
  const metadata = structuredClone(value);
  const collect = (item: any): void => {
    if (!item || typeof item !== 'object') return;
    if (typeof item.mimeType === 'string' && item.mimeType.startsWith('image/') && typeof item.data === 'string') {
      images.push({ mimeType: item.mimeType, data: item.data }); delete item.data; return;
    }
    for (const child of Object.values(item)) if (child && typeof child === 'object') collect(child);
  };
  collect(metadata);
  const content = [{ type: 'text', text: JSON.stringify({ schemaVersion: AGENT_SCHEMA_VERSION, ok: true, data: metadata }) }, ...images.map((image) => ({ type: 'image', mimeType: image.mimeType, data: image.data }))];
  return { content, structuredContent: { schemaVersion: AGENT_SCHEMA_VERSION, ok: true, data: metadata } };
}
function write(output: NodeJS.WritableStream, value: unknown): void { output.write(`${JSON.stringify(value)}\n`); }

