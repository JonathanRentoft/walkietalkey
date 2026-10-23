/** A TCP proxy in front of the local relay, so a test can cut the phone's socket mid-recording. */
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";

export class TcpProxy {
  readonly port: number;
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  /** While true, new connections are refused at once (a longer outage). */
  blocked = false;

  private constructor(server: Server, port: number) {
    this.server = server;
    this.port = port;
  }

  static start(targetPort: number, host = "127.0.0.1"): Promise<TcpProxy> {
    return new Promise((resolve) => {
      let proxy: TcpProxy;
      const server = createServer((client) => {
        if (proxy.blocked) {
          client.destroy();
          return;
        }
        const upstream = createConnection({ host, port: targetPort });
        proxy.sockets.add(client);
        proxy.sockets.add(upstream);
        const drop = () => {
          client.destroy();
          upstream.destroy();
          proxy.sockets.delete(client);
          proxy.sockets.delete(upstream);
        };
        client.on("error", drop);
        upstream.on("error", drop);
        client.on("close", drop);
        upstream.on("close", drop);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      server.listen(0, host, () => {
        const addr = server.address();
        proxy = new TcpProxy(
          server,
          typeof addr === "object" && addr ? addr.port : 0,
        );
        resolve(proxy);
      });
    });
  }

  get connections(): number {
    return this.sockets.size / 2;
  }

  /** Cuts every connection without a WebSocket close handshake (like a phone losing its network). */
  dropAll(): void {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
  }

  close(): Promise<void> {
    this.dropAll();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}
