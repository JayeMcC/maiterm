/**
 * Bridge between the testable dispatcher in `maiterm.ts` (which takes any
 * `McpClientLike`) and the actual `@modelcontextprotocol/sdk` client wired
 * up against a live maiTerm via its lockfile.
 *
 * Split from `maiterm.ts` so unit tests can import the dispatcher without
 * dragging in the heavy SDK + its node-native deps.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { findLiveMaitermLock, type MaitermLock } from './lockfile.ts';
import type { McpClientLike, McpToolCallResult } from './maiterm.ts';

export interface MaitermConnection {
  client: McpClientLike;
  lock: MaitermLock;
  close: () => Promise<void>;
}

/**
 * Open an MCP connection to the live maiTerm running on this machine.
 * Discovers the lockfile, opens an HTTP+SSE transport with the auth
 * header maiTerm expects, runs the MCP initialize handshake, and returns
 * a client implementing `McpClientLike`.
 *
 * Throws if no live lockfile is found.
 */
export async function connectMaiterm(opts: {
  lockDir?: string;
  clientName?: string;
  clientVersion?: string;
} = {}): Promise<MaitermConnection> {
  const lock = findLiveMaitermLock(opts.lockDir);
  if (!lock) {
    throw new Error(
      `No live maiTerm lockfile found in ${opts.lockDir ?? '~/.claude/ide/'} — ` +
        `is maiTerm running?`,
    );
  }

  const url = new URL(`http://127.0.0.1:${lock.serverPort}/mcp`);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: {
      headers: {
        'x-claude-code-ide-authorization': lock.authToken,
      },
    },
  });

  const client = new Client(
    {
      name: opts.clientName ?? '@forwood/task-engine',
      version: opts.clientVersion ?? '0.1.0',
    },
    { capabilities: {} },
  );

  await client.connect(transport);

  const wrapped: McpClientLike = {
    async callTool(req) {
      // The SDK's `callTool` returns the full server response; mash it
      // into the `McpToolCallResult` shape the dispatcher expects.
      const res = await client.callTool({
        name: req.name,
        arguments: req.arguments,
      });
      return res as unknown as McpToolCallResult;
    },
    async close() {
      await client.close();
    },
  };

  return {
    client: wrapped,
    lock,
    close: () => client.close(),
  };
}
