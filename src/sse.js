export class SseClientPool {
  #clients = new Set();

  constructor(name, maxClients, logger = console) {
    if (!name || !Number.isInteger(maxClients) || maxClients < 1) {
      throw new Error('SseClientPool requires a name and positive integer limit');
    }
    this.name = name;
    this.maxClients = maxClients;
    this.logger = logger;
  }

  get size() {
    return this.#clients.size;
  }

  add(req, res) {
    if (this.#clients.size >= this.maxClients) {
      this.logger.warn(`[SSE] ${this.name} connection rejected: limit ${this.maxClients}`);
      return false;
    }
    this.#clients.add(res);
    const cleanup = () => this.#clients.delete(res);
    req.once('close', cleanup);
    res.once('close', cleanup);
    res.once('error', (error) => this.#drop(res, `response error: ${error?.message || error}`));
    return true;
  }

  write(res, data) {
    if (!this.#clients.has(res)) return false;
    try {
      if (res.write(data)) return true;
      this.#drop(res, 'slow client backpressure');
      return false;
    } catch (error) {
      this.#drop(res, `write error: ${error?.message || error}`);
      return false;
    }
  }

  broadcast(data) {
    for (const res of [...this.#clients]) this.write(res, data);
  }

  #drop(res, reason) {
    if (!this.#clients.delete(res)) return;
    this.logger.warn(`[SSE] ${this.name} client dropped: ${reason}`);
    try { res.end(); } catch (error) {
      this.logger.warn(`[SSE] ${this.name} client close failed: ${error?.message || error}`);
    }
  }
}
