/**
 * Watch party — one Durable Object per room code.
 *
 * The code IS the room. `idFromName(code)` maps any string two people agree
 * on to the same object, so there is no room registry, no row to create and
 * nothing to clean up: a room exists exactly as long as someone is connected
 * to it. Whatever the host types — "chai", "1234", a uuid — lands both sides
 * in the same place.
 *
 * What travels is playback STATE, never media. The party is only offered on
 * URL sources precisely because both sides have to be able to reach the same
 * bytes themselves; a local file cannot be shared this way and the client
 * refuses to start a party on one.
 *
 * The code is the only secret there is. The first connection on a code
 * claims the room and hosts it; everyone who follows joins it. There is no
 * second credential to present, which means a code worth keeping is a code
 * worth choosing — "movie" is not one.
 *
 * Time is kept by this object, not by either browser. Two machines' clocks
 * routinely differ by seconds, which is far more than the drift we are trying
 * to correct, so every state message is stamped with the DO's own clock and
 * clients measure their offset to it by ping/pong. A follower then knows what
 * "0:41.2 as of 380ms ago" means in its own terms.
 */

// A room with nobody in it should not hold a connection open for ever; a
// browser that closes without a close frame leaves a socket that only a ping
// reveals as dead.
const PING_EVERY_MS = 20000;
const DEAD_AFTER_MS = 55000;

// Rooms are small by nature — this is people watching together, not a
// broadcast. The cap exists so one leaked code cannot turn a room into a
// fan-out target.
const MAX_MEMBERS = 12;

const MAX_MESSAGE_BYTES = 4096;

export class WatchParty {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    /** @type {Map<string, {ws: WebSocket, name: string, control: boolean, host: boolean, alive: number}>} */
    this.members = new Map();
    this.hostId = null;
    // The last state a controller sent, replayed to anyone who joins later so
    // they land mid-film rather than at zero.
    this.last = null;
    this.timer = null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    if (this.members.size >= MAX_MEMBERS) {
      return new Response("room is full", { status: 503 });
    }

    const name = (url.searchParams.get("name") || "").slice(0, 24) || "Guest";

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const id = crypto.randomUUID().slice(0, 8);
    // Whoever gets here first owns the room. The code is the secret and
    // claiming it is the whole of hosting: there is nothing else to present.
    // Everyone who arrives afterwards finds the chair taken and follows.
    const isHost = this.hostId === null;
    const member = { ws: server, name, control: isHost, host: isHost, alive: Date.now() };
    this.members.set(id, member);
    if (isHost) this.hostId = id;

    server.addEventListener("message", (event) => this.onMessage(id, event));
    server.addEventListener("close", () => this.drop(id));
    server.addEventListener("error", () => this.drop(id));

    this.send(id, {
      t: "welcome",
      you: id,
      host: this.hostId,
      control: member.control,
      now: Date.now(),
      state: this.last,
    });
    this.broadcastRoster();
    this.ensureTimer();

    return new Response(null, { status: 101, webSocket: client });
  }

  onMessage(id, event) {
    const member = this.members.get(id);
    if (!member) return;
    member.alive = Date.now();

    if (typeof event.data !== "string" || event.data.length > MAX_MESSAGE_BYTES) return;
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== "string") return;

    switch (msg.t) {
      case "ping":
        // Answered with our clock so the caller can work out its offset. Kept
        // separate from the heartbeat below: this one the CLIENT drives,
        // because only the client can time the round trip it is measuring.
        this.send(id, { t: "pong", id: msg.id, now: Date.now() });
        return;

      case "state": {
        if (!member.control) return;
        const state = sanitizeState(msg);
        if (!state) return;
        state.at = Date.now();
        state.by = id;
        this.last = state;
        this.broadcast({ t: "state", ...state }, id);
        return;
      }

      case "req": {
        // A guest asking for the remote. Only the host is told; everyone else
        // has no business approving it.
        if (member.control || this.hostId === null) return;
        this.send(this.hostId, { t: "req", who: id, name: member.name });
        return;
      }

      case "grant":
      case "revoke": {
        if (!member.host) return;
        const target = this.members.get(String(msg.who));
        if (!target || target.host) return;
        target.control = msg.t === "grant";
        this.send(String(msg.who), { t: "control", control: target.control });
        this.broadcastRoster();
        return;
      }

      case "deny": {
        if (!member.host) return;
        this.send(String(msg.who), { t: "denied" });
        return;
      }

      case "chat": {
        const body = typeof msg.body === "string" ? msg.body.slice(0, 300).trim() : "";
        if (!body) return;
        this.broadcast({ t: "chat", who: id, name: member.name, body, at: Date.now() });
        return;
      }
    }
  }

  drop(id) {
    const member = this.members.get(id);
    if (!member) return;
    this.members.delete(id);

    if (this.hostId === id) {
      // The host left. Rather than end the party, hand the remote to whoever
      // they had already trusted with it — and if that is nobody, to the
      // longest-standing guest, because a room where nothing can be paused is
      // worse than one with an unexpected driver.
      this.hostId = null;
      let heir = null;
      for (const [otherId, other] of this.members) {
        if (other.control) { heir = otherId; break; }
        if (heir === null) heir = otherId;
      }
      if (heir !== null) {
        const next = this.members.get(heir);
        next.host = true;
        next.control = true;
        this.hostId = heir;
        this.send(heir, { t: "control", control: true, promoted: true });
      }
    }

    try { member.ws.close(1000, "bye"); } catch { /* already gone */ }
    this.broadcastRoster();
    if (this.members.size === 0) this.stopTimer();
  }

  send(id, obj) {
    const member = this.members.get(id);
    if (!member) return;
    try {
      member.ws.send(JSON.stringify(obj));
    } catch {
      this.members.delete(id);
    }
  }

  broadcast(obj, exceptId) {
    const payload = JSON.stringify(obj);
    for (const [id, member] of this.members) {
      if (id === exceptId) continue;
      try {
        member.ws.send(payload);
      } catch {
        this.members.delete(id);
      }
    }
  }

  broadcastRoster() {
    const members = [];
    for (const [id, m] of this.members) {
      members.push({ id, name: m.name, control: m.control, host: m.host });
    }
    this.broadcast({ t: "roster", host: this.hostId, members });
  }

  ensureTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const cutoff = Date.now() - DEAD_AFTER_MS;
      for (const [id, m] of [...this.members]) {
        if (m.alive < cutoff) { this.drop(id); continue; }
        try { m.ws.send('{"t":"hb"}'); } catch { this.drop(id); }
      }
    }, PING_EVERY_MS);
  }

  stopTimer() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

/**
 * A controller can only say four things about playback, and each has to be
 * the right shape before it reaches everyone else's player — a NaN time or a
 * rate of 40 would be applied verbatim by every follower.
 */
function sanitizeState(msg) {
  const time = Number(msg.time);
  const rate = Number(msg.rate);
  if (!Number.isFinite(time) || time < 0 || time > 86400) return null;
  if (!Number.isFinite(rate) || rate < 0.25 || rate > 4) return null;
  const src = typeof msg.src === "string" ? msg.src.slice(0, 2048) : "";
  // Only what both sides can fetch themselves. A blob: or file: source means
  // the host opened something local, which cannot travel — the client blocks
  // that before it gets here, and this is the second door.
  if (src && !/^https?:\/\//i.test(src)) return null;
  return { paused: !!msg.paused, time, rate, src, title: typeof msg.title === "string" ? msg.title.slice(0, 120) : "" };
}
