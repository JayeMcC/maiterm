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

    const res = await fetch(`http://127.0.0.1:${this.lock.serverPort}/mcp`, {
      method: 'POST',
      headers,
      body,
    });
    // The initialize response carries the session id we must echo on
    // subsequent calls.
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
      payload = await this.parseSse(res);
    } else {
      payload = (await res.json()) as typeof payload;
    }
    if (payload.error) {
      throw new Error(`MCP ${method} error ${payload.error.code}: ${payload.error.message}`);
    }
    return payload.result;
  }

  /**
   * Some MCP servers respond via SSE even to a one-shot POST — read the
   * stream until we see a `data:` line carrying the JSON-RPC payload.
   */
  private async parseSse(res: Response): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
    const text = await res.text();
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const json = trimmed.slice(5).trim();
      if (!json) continue;
      return JSON.parse(json) as { result?: unknown; error?: { code: number; message: string } };
    }
    throw new Error(`SSE response had no data line: ${text.slice(0, 300)}`);
  }

  private async notify(method: string, params: unknown): Promise<void> {
    const body = JSON.stringify({ jsonrpc: '2.0', method, params });
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'x-claude-code-ide-authorization': this.lock.authToken,
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    await fetch(`http://127.0.0.1:${this.lock.serverPort}/mcp`, {
      method: 'POST',
      headers,
      body,
    });
  }
}
