import { createHash } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { DEFAULT_WECOM_AIBOT_WS_URL } from "../src/constants";
import { createWeComWebSocket } from "../src/ws-open";

const WEBSOCKET_ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const TEXT_OPCODE = 0x81;
const MASK_BIT = 0x80;

function acceptFor(key: string): string {
  return createHash("sha1").update(`${key}${WEBSOCKET_ACCEPT_GUID}`).digest("base64");
}

function headerValue(raw: string, name: string): string | undefined {
  const prefix = `${name}:`;
  const line = raw
    .split("\r\n")
    .find((entry) => entry.toLowerCase().startsWith(prefix.toLowerCase()));
  if (line === undefined) return undefined;
  return line.slice(prefix.length).trim();
}

async function listen(): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server did not bind a TCP port");
  }
  return {
    server,
    port: address.port,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

function readHeader(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    const onData = (chunk: Buffer) => {
      raw += chunk.toString("utf8");
      if (!raw.includes("\r\n\r\n")) return;
      socket.off("data", onData);
      resolve(raw.slice(0, raw.indexOf("\r\n\r\n") + 4));
    };
    socket.on("data", onData);
    socket.on("error", reject);
  });
}

describe("WeCom long-connection upgrade", () => {
  it("keeps the documented long-connection address", () => {
    const url = new URL(DEFAULT_WECOM_AIBOT_WS_URL);
    expect(url.protocol).toBe("wss:");
    expect(url.hostname).toBe("openws.work.weixin.qq.com");
    expect(url.pathname).toBe("/");
  });

  it("opens with Upgrade: websocket and receives a text frame", async () => {
    const { server, port, close } = await listen();
    const received: Buffer[] = [];
    const upgraded = new Promise<string>((resolve, reject) => {
      server.on("connection", (socket) => {
        void readHeader(socket).then((raw) => {
          const key = headerValue(raw, "Sec-WebSocket-Key");
          if (key === undefined) {
            reject(new Error("missing Sec-WebSocket-Key"));
            return;
          }
          socket.write(
            [
              "HTTP/1.1 101 Switching Protocols",
              "Upgrade: websocket",
              "Connection: Upgrade",
              `Sec-WebSocket-Accept: ${acceptFor(key)}`,
              "",
              "",
            ].join("\r\n"),
          );
          const payload = Buffer.from("ready");
          socket.write(Buffer.from([TEXT_OPCODE, payload.length, ...payload]));
          socket.on("data", (chunk) => {
            received.push(chunk);
          });
          resolve(raw);
        }, reject);
      });
    });

    const socket = createWeComWebSocket(`ws://127.0.0.1:${port}/`);
    const opened = new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", (error) => reject(error), { once: true });
    });
    const message = new Promise<string>((resolve) => {
      socket.addEventListener(
        "message",
        (event) => {
          resolve(typeof event.data === "string" ? event.data : "");
        },
        { once: true },
      );
    });

    const raw = await upgraded;
    expect(raw.startsWith("GET / HTTP/1.1\r\n")).toBe(true);
    expect(raw.split("\r\n")).toContain("Upgrade: websocket");
    expect(raw.split("\r\n")).not.toContain("upgrade: websocket");
    await opened;
    expect(socket.readyState).toBe(1);
    expect(await message).toBe("ready");

    socket.send("hi");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const outbound = Buffer.concat(received);
    expect(outbound[0]).toBe(TEXT_OPCODE);
    expect(outbound[1]).toBe(MASK_BIT | "hi".length);
    const mask = outbound.subarray(2, 6);
    const payload = Buffer.from(outbound.subarray(6, 8));
    for (let index = 0; index < payload.length; index += 1) {
      const maskByte = mask[index];
      const payloadByte = payload[index];
      if (maskByte === undefined || payloadByte === undefined) continue;
      payload[index] = payloadByte ^ maskByte;
    }
    expect(payload.toString("utf8")).toBe("hi");

    socket.close(1000, "done");
    await close();
  });

  it("fails the upgrade when the server answers HTTP 404", async () => {
    const { server, port, close } = await listen();
    server.on("connection", (socket) => {
      socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    });
    const socket = createWeComWebSocket(`ws://127.0.0.1:${port}/`);
    const failure = await new Promise<unknown>((resolve) => {
      socket.addEventListener("error", (error) => resolve(error), { once: true });
    });
    expect(failure).toBeInstanceOf(Error);
    if (failure instanceof Error) {
      expect(failure.message).toContain("404");
    }
    expect(socket.readyState).toBe(3);
    await close();
  });
});
