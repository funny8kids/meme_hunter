#!/usr/bin/env node
import { createRequire } from "module";
const { version } = createRequire(import.meta.url)("../package.json") as { version: string };
import { setGlobalDispatcher, ProxyAgent, Agent, buildConnector, type Dispatcher } from "undici";
import { SocksClient } from "socks";
import * as tls from "tls";
import { Command } from "commander";
import { registerTokenCommands } from "./commands/token.js";
import { registerMarketCommands } from "./commands/market.js";
import { registerPortfolioCommands } from "./commands/portfolio.js";
import { registerTrackCommands } from "./commands/track.js";
import { registerCalloutCommands } from "./commands/callout.js";
import { registerSwapCommands } from "./commands/swap.js";
import { registerCookingCommands } from "./commands/cooking.js";
import { registerConfigCommands } from "./commands/config.js";

const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy
           ?? process.env.HTTP_PROXY  ?? process.env.http_proxy;
let dispatcher: Dispatcher;
if (proxy) {
  const u = new URL(proxy);
  if (u.protocol === "socks5:" || u.protocol === "socks4:") {
    const type = u.protocol === "socks5:" ? 5 : 4;
    dispatcher = new Agent({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      connect: async (options: any, callback: any) => {
        try {
          const { socket } = await SocksClient.createConnection({
            proxy: { host: u.hostname, port: parseInt(u.port || "1080"), type },
            command: "connect",
            destination: { host: options.hostname!, port: +options.port! },
            socket_options: { family: 4 } as any,
          });
          if (options.protocol === "https:") {
            callback(null, tls.connect({ socket, servername: options.hostname, rejectUnauthorized: options.rejectUnauthorized !== false }));
          } else {
            callback(null, socket);
          }
        } catch (err) {
          callback(err as Error, null);
        }
      },
    });
  } else {
    dispatcher = new ProxyAgent(proxy);
  }
} else {
  // Force IPv4 for all connections (no proxy mode)
  const connector = buildConnector({ family: 4 } as any);
  dispatcher = new Agent({ connect: connector });
}
setGlobalDispatcher(dispatcher);

const program = new Command();

program
  .name("gmgn-cli")
  .version(version)
  .description("GMGN OpenAPI CLI — market data, token info, portfolio, track KOL/smart money trades, and swap");

registerTokenCommands(program);
registerMarketCommands(program);
registerPortfolioCommands(program);
registerTrackCommands(program);
registerCalloutCommands(program);
registerSwapCommands(program);
registerCookingCommands(program);
registerConfigCommands(program);

try {
  await program.parseAsync();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[gmgn-cli] ${message}`);
  process.exitCode = 1;
} finally {
  // Let Undici release sockets and libuv handles before Node exits. In
  // particular, forcing process.exit() on HTTP error paths can crash Windows
  // while an async handle is still transitioning to UV_HANDLE_CLOSING.
  await dispatcher.close();
}
