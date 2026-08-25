import fs from "node:fs/promises";
import http, { type IncomingHttpHeaders, type Server } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

type WorkerHandler = {
  fetch(request: Request, env: unknown, context: unknown): Promise<Response>;
};

export interface DesktopSite {
  origin: string;
  close: () => Promise<void>;
}

const mimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function webHeaders(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") result.set(name, value);
    else if (Array.isArray(value)) for (const item of value) result.append(name, item);
  }
  return result;
}

async function staticResponse(clientRoot: string, requestUrl: URL): Promise<Response> {
  let pathname: string;
  try {
    pathname = decodeURIComponent(requestUrl.pathname);
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const relative = pathname.replace(/^\/+/, "");
  if (!relative || relative.includes("\0")) return new Response("Not Found", { status: 404 });
  const candidate = path.resolve(clientRoot, relative);
  const prefix = `${path.resolve(clientRoot)}${path.sep}`;
  if (!candidate.startsWith(prefix)) return new Response("Forbidden", { status: 403 });

  try {
    const stat = await fs.stat(candidate);
    if (!stat.isFile()) return new Response("Not Found", { status: 404 });
    const body = await fs.readFile(candidate);
    return new Response(body, {
      headers: {
        "Cache-Control": relative.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache",
        "Content-Type": mimeTypes[path.extname(candidate).toLowerCase()] ?? "application/octet-stream",
      },
    });
  } catch {
    return new Response("Not Found", { status: 404 });
  }
}

async function sendNodeResponse(
  response: Response,
  nodeResponse: http.ServerResponse,
  headOnly: boolean,
): Promise<void> {
  nodeResponse.statusCode = response.status;
  response.headers.forEach((value, name) => nodeResponse.setHeader(name, value));
  if (headOnly || response.body === null) {
    nodeResponse.end();
    return;
  }
  nodeResponse.end(Buffer.from(await response.arrayBuffer()));
}

export async function startDesktopSite(distRoot: string): Promise<DesktopSite> {
  const clientRoot = path.join(distRoot, "client");
  const workerPath = path.join(distRoot, "server", "index.js");
  const workerModule = await import(pathToFileURL(workerPath).href) as { default: WorkerHandler };
  const worker = workerModule.default;
  if (!worker || typeof worker.fetch !== "function") {
    throw new Error("Built web worker does not expose a fetch handler");
  }

  let origin = "http://127.0.0.1";
  const assetBinding = {
    fetch: async (request: Request) => staticResponse(clientRoot, new URL(request.url)),
  };
  const imageBinding = {
    input: () => ({
      transform: () => ({
        output: async () => new Response("Image transformation is unavailable", { status: 501 }),
      }),
    }),
  };
  const context = {
    passThroughOnException: () => undefined,
    waitUntil: (promise: Promise<unknown>) => void promise.catch(() => undefined),
  };

  const server: Server = http.createServer((request, response) => {
    void (async () => {
      const method = request.method ?? "GET";
      if (method !== "GET" && method !== "HEAD") {
        await sendNodeResponse(new Response("Method Not Allowed", { status: 405 }), response, method === "HEAD");
        return;
      }
      const url = new URL(request.url ?? "/", origin);
      const directAsset = await staticResponse(clientRoot, url);
      const webResponse = directAsset.status !== 404
        ? directAsset
        : await worker.fetch(
            new Request(url, { method, headers: webHeaders(request.headers) }),
            { ASSETS: assetBinding, IMAGES: imageBinding },
            context,
          );
      await sendNodeResponse(webResponse, response, method === "HEAD");
    })().catch((error) => {
      response.statusCode = 500;
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      response.end(error instanceof Error ? error.message : String(error));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to determine desktop web port");
  origin = `http://127.0.0.1:${address.port}`;

  return {
    origin,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}
