import { createHash } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function frame(opcode: number, payload: Buffer): Buffer {
  const header = payload.length < 126 ? 2 : payload.length <= 0xffff ? 4 : 10;
  const result = Buffer.allocUnsafe(header + payload.length);
  result[0] = 0x80 | opcode;
  if (header === 2) result[1] = payload.length;
  else if (header === 4) {
    result[1] = 126;
    result.writeUInt16BE(payload.length, 2);
  } else {
    result[1] = 127;
    result.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  payload.copy(result, header);
  return result;
}

function originMatches(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (!req.headers.host) return false;
  try {
    return (
      new URL(origin).host.toLowerCase() === req.headers.host.toLowerCase()
    );
  } catch {
    return false;
  }
}

export function attachWebSocket(
  server: Server,
  path: string,
  authorize: (request: IncomingMessage) => boolean,
  snapshot: () => string,
): void {
  const clients = new Set<Duplex>();
  const heartbeat = setInterval(() => {
    if (!clients.size) return;
    const message = frame(1, Buffer.from(snapshot()));
    for (const client of clients) if (!client.destroyed) client.write(message);
  }, 3000);
  heartbeat.unref();
  server.once("close", () => clearInterval(heartbeat));

  server.on("upgrade", (req, socket, head) => {
    if (req.url?.split("?")[0] !== path) {
      socket.destroy();
      return;
    }
    const key = req.headers["sec-websocket-key"];
    const validKey =
      typeof key === "string" && Buffer.from(key, "base64").length === 16;
    if (
      req.method !== "GET" ||
      req.headers.upgrade?.toLowerCase() !== "websocket" ||
      !validKey ||
      req.headers["sec-websocket-version"] !== "13"
    ) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    if (!originMatches(req)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    if (!authorize(req)) {
      socket.end(
        'HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="ForgeHands", charset="UTF-8"\r\nConnection: close\r\n\r\n',
      );
      return;
    }

    const accept = createHash("sha1")
      .update(key + GUID)
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
        accept +
        "\r\n\r\n",
    );
    clients.add(socket);
    const remove = () => clients.delete(socket);
    socket.once("close", remove);
    socket.once("error", remove);
    socket.write(frame(1, Buffer.from(snapshot())));

    let pending = Buffer.alloc(0);
    const consume = (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 2) {
        const opcode = pending[0] & 0x0f;
        const masked = (pending[1] & 0x80) !== 0;
        let length = pending[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (pending.length < 4) return;
          length = pending.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (pending.length < 10) return;
          const extended = pending.readBigUInt64BE(2);
          if (extended > 1_048_576n) {
            socket.destroy();
            return;
          }
          length = Number(extended);
          offset = 10;
        }
        if (!masked || length > 1_048_576) {
          socket.destroy();
          return;
        }
        if (pending.length < offset + 4 + length) return;
        const mask = pending.subarray(offset, offset + 4);
        const payload = Buffer.from(
          pending.subarray(offset + 4, offset + 4 + length),
        );
        for (let index = 0; index < payload.length; index += 1)
          payload[index] ^= mask[index % 4];
        pending = pending.subarray(offset + 4 + length);
        if (opcode === 8) {
          socket.end(frame(8, payload));
          return;
        }
        if (opcode === 9) socket.write(frame(10, payload));
      }
    };
    socket.on("data", (chunk) =>
      consume(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
    );
    if (head.length) consume(head);
  });
}
