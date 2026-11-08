import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { answeredSocket } from "../e2e/db-socket";

// The e2e helpers' connections to the local database (tests/e2e/db-socket.ts): a socket the database has answered, tried again with a new one when a
// connection is taken and left unanswered (the local relay to the container did that under a run's load, past the client's 20 s).

const SSL_REQUEST = [0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f];

let server: Server | null = null;
const held: Socket[] = [];

afterEach(async () => {
  for (const s of held.splice(0)) s.destroy();
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  server = null;
});

/** A server on a free port that hands each connection, by its number (1, 2, …), and the bytes it was sent to `answer`. */
async function fakeDatabase(answer: (n: number, sent: Buffer, socket: Socket) => void): Promise<number> {
  let n = 0;
  server = createServer((socket) => {
    held.push(socket);
    const nth = ++n;
    socket.once("data", (sent) => answer(nth, sent, socket));
  });
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", () => done()));
  return (server!.address() as AddressInfo).port;
}

describe("answeredSocket", () => {
  test("sends Postgres's SSLRequest and hands over the socket the database answered with „N“, the same socket the client goes on with", async () => {
    const seen: number[][] = [];
    const port = await fakeDatabase((_, sent, socket) => {
      seen.push([...sent]);
      socket.write("N");
      socket.once("data", (next) => socket.write(`got ${next.toString()}`));
    });
    const socket = await answeredSocket("127.0.0.1", port);
    expect(seen).toEqual([SSL_REQUEST]);
    const reply = new Promise<string>((done) => socket.once("data", (b) => done(b.toString())));
    socket.write("startup");
    expect(await reply).toBe("got startup");
    socket.destroy();
  });

  test("a connection taken and never answered is dropped after `ms` for a new one, which the database answers", async () => {
    const port = await fakeDatabase((n, _, socket) => {
      if (n >= 3) socket.write("N"); // (the first two hear nothing)
    });
    const started = Date.now();
    const socket = await answeredSocket("127.0.0.1", port, { ms: 200, tries: 4 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(2 * 200 - 20);
    socket.destroy();
  });

  test("after `tries` unanswered connections it throws, naming the address, the wait and that the connection was taken", async () => {
    const port = await fakeDatabase(() => {});
    await expect(answeredSocket("127.0.0.1", port, { ms: 100, tries: 2 })).rejects.toThrow(
      `no answer from the database at 127.0.0.1:${port} within 100 ms (the connection was taken)`,
    );
  });

  test("`onRetry` hears how long each dropped try waited, before the next one", async () => {
    const port = await fakeDatabase((n, _, socket) => {
      if (n >= 3) socket.write("N");
    });
    const waits: number[] = [];
    const socket = await answeredSocket("127.0.0.1", port, { ms: 150, tries: 4, onRetry: (ms) => waits.push(ms) });
    expect(waits).toHaveLength(2);
    for (const ms of waits) expect(ms).toBeGreaterThanOrEqual(150 - 20);
    socket.destroy();
  });

  test("`onRetry` is not called after the last try: its error is thrown instead", async () => {
    const port = await fakeDatabase(() => {});
    const waits: number[] = [];
    await expect(answeredSocket("127.0.0.1", port, { ms: 100, tries: 2, onRetry: (ms) => waits.push(ms) })).rejects.toThrow("no answer");
    expect(waits).toHaveLength(1);
  });

  test("an answer other than „N“ is no database to go on with in the clear: a server that wants SSL (S) is refused", async () => {
    const port = await fakeDatabase((_, __, socket) => socket.write("S"));
    await expect(answeredSocket("127.0.0.1", port, { ms: 1000, tries: 1 })).rejects.toThrow('answered the SSLRequest with "S", not „N“');
  });

  test("a refused connection is tried again too, and its error is thrown after the last try", async () => {
    const port = await fakeDatabase(() => {});
    await new Promise<void>((done) => server!.close(() => done()));
    server = null;
    await expect(answeredSocket("127.0.0.1", port, { ms: 1000, tries: 2 })).rejects.toThrow(/ECONNREFUSED/);
  });
});
