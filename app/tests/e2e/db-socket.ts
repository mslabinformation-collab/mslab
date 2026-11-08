import { connect, type Socket } from "node:net";

// The socket of every connection the e2e helpers open to the local database (fixtures.ts connect, through postgres.js's `socket` option).

/** How long one try may wait for the database's first answer, and how many tries a connection gets (a minute in all). */
export const ANSWER_MS = 5_000;
export const ANSWER_TRIES = 12;

/** Postgres's SSLRequest: its length (8) and the code 80877103, which the server answers with one byte before anything else is said. */
const SSL_REQUEST = Buffer.from([0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f]);
/** The answer of a server without SSL, as the local container is: „N“, after which the client goes on without it on the same socket. */
const NO_SSL = 0x4e;

/**
 * A socket to the database at `host`:`port` that the database has answered. The e2e helpers open a connection of their own for nearly every row
 * they write or read, thousands in a full run, and under that load a connection to the local container's port on localhost (the relay of WSL, which
 * takes the connection on Windows' side whether or not anything behind it answers: with Docker's engine stopped every connection hangs so) has
 * heard nothing for longer than the client's connect_timeout of 20 s: `write CONNECT_TIMEOUT localhost:5432`, from the admin sign-in of
 * admin-inbox.spec.ts's „requests: five tabs …“, which failed for it; and in another run three new connections of one worker in a row heard
 * nothing for 15 s while a test in another worker went on writing and passed. The same churn of connections alone, hundreds a second on an idle
 * machine, is answered within milliseconds every time: it comes with the load of a run (eight browsers and the production server beside the
 * container). So each try opens a socket and sends the SSLRequest; „N“ is the database itself answering, and postgres.js then sends its startup message
 * on that socket, as the protocol allows after a refused SSLRequest. A try with no answer within `ms`, or a failed one, is dropped for a new socket,
 * `tries` times (`onRetry` hears how long each one waited); then its error is thrown. Nothing has been asked of the database before it answers, so
 * a try again repeats nothing.
 */
export async function answeredSocket(host: string, port: number, opts: { ms?: number; tries?: number; onRetry?: (waitedMs: number) => void } = {}): Promise<Socket> {
  const ms = opts.ms ?? ANSWER_MS;
  const tries = opts.tries ?? ANSWER_TRIES;
  for (let attempt = 1; ; attempt++) {
    const started = Date.now();
    try {
      return await oneTry(host, port, ms);
    } catch (e) {
      if (attempt >= tries) throw e;
      opts.onRetry?.(Date.now() - started);
    }
  }
}

/**
 * One socket, the SSLRequest and its answer: resolves with the socket on „N“, rejects on an error, another answer or none within `ms` (saying whether
 * the connection was taken at all).
 */
function oneTry(host: string, port: number, ms: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    let connected = false;
    const done = () => {
      clearTimeout(timer);
      socket.removeListener("error", fail);
      socket.removeListener("data", answered);
    };
    const fail = (e: Error) => {
      done();
      socket.destroy();
      reject(e);
    };
    const answered = (chunk: Buffer) => {
      if (chunk.length === 1 && chunk[0] === NO_SSL) {
        done();
        return resolve(socket);
      }
      fail(new Error(`e2e: the database at ${host}:${port} answered the SSLRequest with ${JSON.stringify(chunk.toString("latin1"))}, not „N“ (no SSL)`));
    };
    const timer = setTimeout(
      () => fail(new Error(`e2e: no answer from the database at ${host}:${port} within ${ms} ms (${connected ? "the connection was taken" : "not even connected"})`)),
      ms,
    );
    socket.once("error", fail);
    socket.once("connect", () => {
      connected = true;
      socket.write(SSL_REQUEST);
    });
    socket.on("data", answered);
  });
}
