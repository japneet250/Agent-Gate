import { createServer, type Server } from 'node:http';
import type { Evaluator } from './evaluate.js';
import { handleRequest, json, type HttpOptions } from './handler.js';
import { log } from './log.js';
import { reportError } from './monitoring.js';

export { handleRequest, parseAction, type HttpOptions } from './handler.js';

const MAX_BODY_BYTES = 1_000_000;

/** Node wrapper around handleRequest. Binds to 127.0.0.1 unless told otherwise. */
export function startHttpServer(
  evaluate: Evaluator,
  opts: HttpOptions & { port: number; host?: string },
): Promise<Server> {
  const maxBody = opts.maxBodyBytes ?? MAX_BODY_BYTES;

  const server = createServer((nodeReq, nodeRes) => {
    const send = (res: Response) =>
      res.text().then((body) => {
        nodeRes.writeHead(res.status, Object.fromEntries(res.headers));
        nodeRes.end(body);
      });

    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    nodeReq.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (tooBig) return;
      if (size > maxBody) {
        // Stop buffering, answer 413, then drop the connection so the rest of the upload is discarded.
        tooBig = true;
        chunks.length = 0;
        nodeRes.writeHead(413, { 'content-type': 'application/json', connection: 'close' });
        nodeRes.end(JSON.stringify({ error: 'body too large' }), () => nodeReq.destroy());
        return;
      }
      chunks.push(chunk);
    });
    nodeReq.on('end', () => {
      if (tooBig) return;
      const headers = new Headers();
      for (const [k, v] of Object.entries(nodeReq.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
      const hasBody = nodeReq.method !== 'GET' && nodeReq.method !== 'HEAD';
      const req = new Request(`http://${nodeReq.headers.host ?? 'localhost'}${nodeReq.url ?? '/'}`, {
        method: nodeReq.method,
        headers,
        body: hasBody ? Buffer.concat(chunks) : undefined,
      });
      handleRequest(req, evaluate, opts)
        .then(send)
        .catch((err) => {
          log('http handler error:', err);
          reportError(err, 'http-handler');
          return send(json(500, { error: 'internal error', decision: 'block' }));
        });
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host ?? '127.0.0.1', () => resolve(server));
  });
}
