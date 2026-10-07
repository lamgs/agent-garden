import { serve as honoServe, type ServerType } from '@hono/node-server';
import { createApp, type AppOptions } from './app';

/** Local only: the server binds to the loopback interface and nothing else. */
export const HOST = '127.0.0.1';
export const DEFAULT_PORT = 4310;

export function startServer(
  opts: AppOptions & { port?: number },
): Promise<{ server: ServerType; url: string }> {
  const app = createApp(opts);
  return new Promise((resolve) => {
    const server = honoServe(
      { fetch: app.fetch, port: opts.port ?? DEFAULT_PORT, hostname: HOST },
      (info) => resolve({ server, url: `http://${HOST}:${info.port}` }),
    );
  });
}
