/**
 * Minimal MCP client over Streamable HTTP. We don't pull in
 * @modelcontextprotocol/sdk so the test harness stays light and free of
 * version drift — the protocol surface we need is small (initialize +
 * tools/call) and stable.
 *
 * The server is maiTerm's IDE HTTP endpoint at http://127.0.0.1:<port>/mcp;
 * auth is a per-process token in `~/.claude/ide/<port>.lock` (see
 * harness/spawn.ts). Each request is one POST that returns the JSON-RPC
 * response synchronously.
 */

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
      Accept: 'application/json, text/event-stream',
      'x-claude-code-ide-authorization': this.lock.authToken,
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;

    const t0 = Date.now();
    const log = (msg: string) =>
      // eslint-disable-next-line no-console
      console.error(`[mcp ${method}#${id} +${Date.now() - t0}ms] ${msg}`);

    const controller = new AbortController();
    try {
      log('fetch start');
      const res = await fetch(`http://127.0.0.1:${this.lock.serverPort}/mcp`, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
      log(`headers received status=${res.status} ct=${res.headers.get('content-type') ?? ''}`);

      const respSessionId = res.headers.get('mcp-session-id');
      if (respSessionId && !this.sessionId) this.sessionId = respSessionId;

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(
          `MCP ${method} → HTTP ${res.status} ${res.statusText}: ${text.slice(0, 500)}`,
        );
      }
      const ct = res.headers.get('content-type') ?? '';
      let payload: { result?: unknown; error?: { code: number; message: string } };
      if (ct.includes('text/event-stream')) {
        payload = await this.parseSse(res, log);
      } else {
        log('reading json body');
        payload = (await res.json()) as typeof payload;
        log('json body parsed');
      }
      if (payload.error) {
        throw new Error(`MCP ${method} error ${payload.error.code}: ${payload.error.message}`);
      }
      log('returning payload');
      return payload.result;
    } finally {
      controller.abort();
      log('finally: aborted');
    }
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
      Accept: 'application/json, text/event-stream',
      'x-claude-code-ide-authorization': this.lock.authToken,
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    const controller = new AbortController();
    try {
      const res = await fetch(`http://127.0.0.1:${this.lock.serverPort}/mcp`, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
      // Drain the body so the keep-alive socket is released for reuse, then
      // abort to make sure the connection actually tears down.
      await res.arrayBuffer().catch(() => undefined);
    } finally {
      controller.abort();
    }
  }
}
