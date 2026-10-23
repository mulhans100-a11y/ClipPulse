import { createInterface } from 'node:readline';
import { AppError, asAppError } from '../core/errors';
import { APP_VERSION } from '../core/appVersion';
import { AGENT_SCHEMA_VERSION, AgentService } from './agent';

type JsonRpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: any };
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
const STRUCTURED_OUTPUT_VERSION = '2025-06-18';

/** MCP stdio transport: newline-delimited JSON-RPC, protocol output only on stdout. */
export async function runAgentMcp(service: AgentService, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Infinity });
  let protocolVersion = '2025-11-25';
  for await (const line of lines) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line) as unknown; }
    catch { write(output, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      write(output, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
      continue;
    }
    const request = parsed as JsonRpcRequest;
    const hasId = Object.prototype.hasOwnProperty.call(request, 'id');
    const validId = request.id === null || typeof request.id === 'string' || (typeof request.id === 'number' && Number.isFinite(request.id));
    if (request.jsonrpc !== '2.0' || typeof request.method !== 'string' || !request.method || (hasId && !validId)) {
      write(output, { jsonrpc: '2.0', id: hasId && validId ? request.id : null, error: { code: -32600, message: 'Invalid Request' } });
      continue;
    }
    if (request.method.startsWith('notifications/')) continue;
    try {
      const result = await dispatch(service, request, (requested) => {
        protocolVersion = (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];
        return protocolVersion;
      }, protocolVersion);
      if (hasId) write(output, { jsonrpc: '2.0', id: request.id, result });
    } catch (error) {
      const appError = asAppError(error); const methodError = appError.code === 'METHOD_NOT_FOUND' ? -32601 : -32602;
      if (hasId) write(output, { jsonrpc: '2.0', id: request.id, error: { code: methodError, message: appError.message, data: { appCode: appError.code } } });
    }
  }
}

async function dispatch(service: AgentService, request: JsonRpcRequest, negotiate: (requested: string) => string, currentProtocolVersion: string): Promise<any> {
  switch (request.method) {
    case 'initialize': {
      const requested = request.params?.protocolVersion;
      if (typeof requested !== 'string') throw new AppError('INVALID_ARGUMENTS', 'initialize requires params.protocolVersion.');
      const protocolVersion = negotiate(requested);
      return { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'clippulse', version: APP_VERSION }, instructions: `ClipPulse agent tools schema version ${AGENT_SCHEMA_VERSION}. All filesystem paths must be inside granted roots.` };
    }
    case 'ping': return {};
    case 'tools/list': return { tools: service.tools.map((item) => currentProtocolVersion >= STRUCTURED_OUTPUT_VERSION ? item : (({ outputSchema: _outputSchema, ...legacyTool }) => legacyTool)(item)) };
    case 'tools/call': {
      const name = request.params?.name; if (typeof name !== 'string') throw new AppError('INVALID_ARGUMENTS', 'tools/call requires params.name.');
      if (!service.tools.some((item) => item.name === name)) throw new AppError('UNKNOWN_TOOL', `Unknown agent tool: ${name}`);
      try {
        const value = await service.call(name, request.params.arguments ?? {});
        const { content, structuredContent } = mcpResult(value, currentProtocolVersion >= STRUCTURED_OUTPUT_VERSION);
        return { content, structuredContent, isError: false };
      } catch (error) {
        const appError = asAppError(error);
        const result: Record<string, unknown> = { content: [{ type: 'text', text: JSON.stringify({ schemaVersion: AGENT_SCHEMA_VERSION, code: appError.code, message: appError.message }) }], isError: true };
        if (currentProtocolVersion >= STRUCTURED_OUTPUT_VERSION) result.structuredContent = { schemaVersion: AGENT_SCHEMA_VERSION, ok: false, error: { code: appError.code, message: appError.message } };
        return result;
      }
    }
    default: throw new AppError('METHOD_NOT_FOUND', `Unsupported MCP method: ${request.method}`);
  }
}

function mcpResult(value: any, supportsStructuredContent: boolean): { content: any[]; structuredContent?: unknown } {
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
  return { content, ...(supportsStructuredContent ? { structuredContent: { schemaVersion: AGENT_SCHEMA_VERSION, ok: true, data: metadata } } : {}) };
}
function write(output: NodeJS.WritableStream, value: unknown): void { output.write(`${JSON.stringify(value)}\n`); }

