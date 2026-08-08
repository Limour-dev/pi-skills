/**
 * Minimal in-process HTTP mock server for testing the client and CLI.
 */
import { createServer, IncomingMessage, Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  method: string;
  /** Pathname + search, e.g. "/v1/entries?status=unread" */
  url: string;
  pathname: string;
  headers: IncomingMessage["headers"];
  body: string;
}

export interface MockRoute {
  method: string;
  /** Exact pathname match, e.g. "/v1/feeds" */
  path: string;
  status?: number;
  json?: unknown;
  text?: string;
  contentType?: string;
}

export interface MockServer {
  url: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

/** Start a mock server on a random localhost port serving the given routes. */
export async function startMockServer(routes: MockRoute[]): Promise<MockServer> {
  const requests: RecordedRequest[] = [];
  const sockets = new Set<import("node:net").Socket>();

  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const url = req.url ?? "/";
      const pathname = new URL(url, "http://localhost").pathname;
      requests.push({ method: req.method ?? "", url, pathname, headers: req.headers, body });

      const route = routes.find((r) => r.method === req.method && r.path === pathname);
      if (!route) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error_message: `no mock route for ${req.method} ${pathname}` }));
        return;
      }

      const status = route.status ?? 200;
      if (status === 204) {
        res.writeHead(204);
        res.end();
        return;
      }
      if (route.text !== undefined) {
        res.writeHead(status, { "Content-Type": route.contentType ?? "text/plain" });
        res.end(route.text);
        return;
      }
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(route.json ?? {}));
    });
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
