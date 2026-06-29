/**
 * Minimal MCP client over Streamable HTTP. We don't pull in
 * @modelcontextprotocol/sdk so the test harness stays light and free of
 * version drift — the protocol surface we need is small (initialize +
 * tools/call) and stable.
 *
 * The server is maiTerm's IDE HTTP endpoint at http://127.0.0.1:<port>/mcp;
 * auth is a per-process token in `~/.claude/ide/<port>.lock` (see
 * harness/spawn.ts).
 *
 * We use Node's `node:http` directly instead of global fetch (undici) because
 * undici's connection-pool semantics combined with maiTerm's SSE-wrapped
 * responses make subsequent fetches queue for the full testTimeout on the
 * macos-latest GitHub runners — diagnosed via per-request elapsed-ms logging
 * (see git history). Plain `http.request` opens a fresh socket per call and
 * reads the full response body before resolving, sidestepping the issue
 * entirely.
 */

import * as http from 'node:http';
import type { MaitermLock } from './spawn.ts';

const PROTOCOL_VERSION = '2025-06-18';

export interface McpToolCallContent {
  type: string;
  text?: string;
}

export interface McpToolCallResult {
  content: McpToolCallContent[];
  isError?: boolean;
}

export class McpClient {
  private nextId = 1;
  private sessionId: string | undefined;

  constructor(private readonly lock: MaitermLock) {}

  /** Perform the MCP `initialize` handshake. Required before `callTool`. */
  async initialize(): Promise<void> {
    const result = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'maiterm-e2e', version: '0.1.0' },
    });
    // Send the post-handshake `notifications/initialized` so the server
    // marks the session ready to serve tool calls.
    await this.notify('notifications/initialized', {});
    return result as void;
  }

  /** List the tools the server advertises. Useful for sanity-checking. */
  async listTools(): Promise<{ tools: { name: string }[] }> {
    return (await this.request('tools/list', {})) as { tools: { name: string }[] };
  }

  /** Call a tool. Result is the raw MCP { content, isError? } envelope. */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpToolCallResult> {
    return (await this.request('tools/call', {
      name,
      arguments: args,
    })) as McpToolCallResult;
  }

  /**
   * Extract the JSON payload an MCP tool wrote into its first text-content
   * frame. maiTerm's frontend handlers serialise their return value to
   * JSON and stuff it in `content[0].text`.
   */
  parseToolResult<T>(result: McpToolCallResult): T {
    const text = result.content?.find(c => c.type === 'text')?.text;
    if (!text) {
      throw new Error(`MCP tool result missing text content: ${JSON.stringify(result)}`);
    }
    return JSON.parse(text) as T;
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body).toString(),
      Accept: 'application/json, text/event-stream',
      'x-claude-code-ide-authorization': this.lock.authToken,
      Connection: 'close',
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;

    const t0 = Date.now();
    const log = (msg: string) =>
      // eslint-disable-next-line no-console
      console.error(`[mcp ${method}#${id} +${Date.now() - t0}ms] ${msg}`);

    log('request start (node:http)');
    const { statusCode, statusMessage, headers: resHeaders, body: resBody } =
      await this.nodeHttpPost(body, headers);
    log(`response received status=${statusCode} ct=${resHeaders['content-type'] ?? ''} bytes=${resBody.length}`);

    const respSessionId = resHeaders['mcp-session-id'] as string | undefined;
    if (respSessionId && !this.sessionId) this.sessionId = respSessionId;

    if (statusCode === undefined || statusCode < 200 || statusCode >= 300) {
      throw new Error(
        `MCP ${method} → HTTP ${statusCode ?? '?'} ${statusMessage ?? ''}: ${resBody.slice(0, 500)}`,
      );
    }

    const ct = (resHeaders['content-type'] ?? '') as string;
    let payload: { result?: unknown; error?: { code: number; message: string } };
    if (ct.includes('text/event-stream')) {
      payload = this.parseSseBody(resBody);
    } else {
      payload = JSON.parse(resBody) as typeof payload;
    }
    if (payload.error) {
      throw new Error(`MCP ${method} error ${payload.error.code}: ${payload.error.message}`);
    }
    log('returning payload');
    return payload.result;
  }

  /**
   * Plain Node http POST that resolves once the response body has been
   * fully read. Each call opens a fresh TCP socket (no pooling), reads
   * `Content-Length` bytes, and returns. Avoids undici entirely.
   */
  private nodeHttpPost(
    body: string,
    headers: Record<string, string>,
  ): Promise<{ statusCode: number | undefined; statusMessage: string | undefined; headers: http.IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: this.lock.serverPort,
          path: '/mcp',
          method: 'POST',
          headers,
          agent: false,
          // Generous timeout — vitest will fail the test before this fires;
          // the timeout is just a safety net in case the server hangs.
          timeout: 90_000,
        },
        res => {
          const chunks: Buffer[] = [];
          res.on('data', chunk => chunks.push(chunk));
          res.on('end', () =>
            resolve({
              statusCode: res.statusCode,
              statusMessage: res.statusMessage,
              headers: res.headers,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy(new Error('node:http request timed out after 90s'));
      });
      req.write(body);
      req.end();
    });
  }

  /** Pull the JSON payload from a fully-read SSE body. */
  private parseSseBody(body: string): { result?: unknown; error?: { code: number; message: string } } {
    for (const line of body.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const json = trimmed.slice(5).trim();
      if (!json) continue;
      return JSON.parse(json) as { result?: unknown; error?: { code: number; message: string } };
    }
    throw new Error(`SSE response had no data line: ${body.slice(0, 300)}`);
  }

  /**
   * Some MCP servers respond via SSE even to a one-shot POST. maiTerm always
   * does (`event: message\ndata: <json>\n\n`). Stream-read and bail out
   * the moment we see the first `data:` line — don't wait for the body to
   * close, because chunked transfer encoding under text/event-stream
   * sometimes leaves the connection open even after the single event
   * fires, hanging `await res.text()` for the full HTTP timeout.
   */
  private async parseSse(
    res: Response,
    log: (msg: string) => void = () => undefined,
  ): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
    if (!res.body) {
      throw new Error('SSE response has no readable body');
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let reads = 0;
    try {
      while (true) {
        log(`sse: awaiting chunk #${reads}`);
        const { value, done } = await reader.read();
        reads++;
        if (value) {
          buf += decoder.decode(value, { stream: true });
          log(`sse: chunk #${reads - 1} got ${value.byteLength}B (done=${done})`);
        } else {
          log(`sse: chunk #${reads - 1} empty (done=${done})`);
        }
        const lines = buf.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const json = trimmed.slice(5).trim();
          if (!json) continue;
          log('sse: data line found, returning');
          return JSON.parse(json) as { result?: unknown; error?: { code: number; message: string } };
        }
        if (done) break;
      }
      throw new Error(`SSE response had no data line: ${buf.slice(0, 300)}`);
    } finally {
      log('sse: cancelling reader');
      try {
        await reader.cancel();
      } catch {
        // Ignore — best-effort cleanup so the connection can be reused.
      }
    }
  }

  private async notify(method: string, params: unknown): Promise<void> {
    const body = JSON.stringify({ jsonrpc: '2.0', method, params });
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body).toString(),
      Accept: 'application/json, text/event-stream',
      'x-claude-code-ide-authorization': this.lock.authToken,
      Connection: 'close',
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    await this.nodeHttpPost(body, headers);
  }
}
