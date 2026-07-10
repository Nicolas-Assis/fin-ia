import type { IncomingMessage, ServerResponse } from "node:http";
import { app } from "../src/app.js";

// Node runtime (padrão). bodyParser:false para tentar preservar o stream cru.
export const config = { runtime: "nodejs", api: { bodyParser: false } };

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  // 1) Bufferiza o body inteiro (evita o hang de POST do stream na Vercel).
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  let body: Buffer | undefined;
  if (chunks.length) {
    body = Buffer.concat(chunks);
  } else if ((req as any).body != null) {
    // Fallback: caso a Vercel já tenha consumido o stream para popular req.body.
    const raw = (req as any).body;
    body = Buffer.isBuffer(raw)
      ? raw
      : Buffer.from(typeof raw === "string" ? raw : JSON.stringify(raw));
  }

  // 2) Reconstrói uma URL absoluta.
  const proto = (req.headers["x-forwarded-proto"] as string) || "https";
  const host = req.headers["host"] || "localhost";
  const url = `${proto}://${host}${req.url}`;

  // 3) Copia headers para um Headers Web.
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else if (value != null) headers.set(key, value);
  }

  // 4) Monta o Request Web.
  const method = (req.method || "GET").toUpperCase();
  const request = new Request(url, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : body,
  });

  // 5) Roda o Hono e escreve a Response de volta em res (o que o hono/vercel omitia).
  const response = await app.fetch(request);
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.end(Buffer.from(await response.arrayBuffer()));
}
