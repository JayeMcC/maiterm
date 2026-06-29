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

    const { statusCode, statusMessage, headers: resHeaders, body: resBody } =
      await this.nodeHttpPost(body, headers);

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

  /**
   * Poll a frontend-handled tool (`listWorkspaces`) until it returns
   * successfully. Proves the maiTerm webview has finished loading, its
   * Svelte layout has mounted, and the `agent-ide-tool` listener is
   * registered — otherwise the first real tool call races the listener
   * and the server's emit lands in the void (Tauri events emitted
   * before a listener is attached are dropped, not queued, so the
   * server's oneshot just waits 120s for a response that never arrives).
   *
   * Uses a short per-call timeout (2s) and retries until the overall
   * timeout (default 60s) elapses. Logs each attempt so a slow webview
   * boot is visible in the CI output.
   */
  async waitForFrontendReady(opts: { timeoutMs?: number } = {}): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const start = Date.now();
    let lastError: unknown = null;
    while (Date.now() - start < timeoutMs) {
      try {
        // Short per-call deadline so a hung emit doesn't waste the whole
        // budget. listWorkspaces is frontend-handled, in the server's
        // global_tools allowlist (no initSession needed), and returns a
        // structured tree once the listener responds.
        await this.callToolWithDeadline('listWorkspaces', {}, 2_000);
        return;
      } catch (err) {
        lastError = err;
        await new Promise(r => setTimeout(r, 500));
      }
    }
    throw new Error(
      `Frontend did not respond to listWorkspaces within ${timeoutMs}ms (last error: ${String(lastError)})`,
    );
  }

  private async callToolWithDeadline(
    name: string,
    args: Record<string, unknown>,
    deadlineMs: number,
  ): Promise<McpToolCallResult> {
    return Promise.race([
      this.callTool(name, args),
      new Promise<McpToolCallResult>((_, reject) =>
        setTimeout(() => reject(new Error(`tool ${name} did not respond within ${deadlineMs}ms`)), deadlineMs),
      ),
    ]);
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
