'use strict';
/** 极简 CDP（Chrome DevTools Protocol）客户端：JSON over WebSocket。 */
const ws = require('./ws');

function httpJson(port, path, timeoutMs = 8000) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('bad json from ' + path)); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout ' + path)); });
    req.on('error', reject);
  });
}

class CDP {
  constructor(client) {
    this.client = client;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    client.on('message', (raw) => this._onMessage(raw));
    client.on('close', () => {
      for (const [, p] of this.pending) p.reject(new Error('cdp socket closed'));
      this.pending.clear();
    });
  }

  static async version(port) { return httpJson(port, '/json/version'); }
  static async list(port) { return httpJson(port, '/json/list'); }

  static async connect(wsUrl) {
    const client = await ws.connect(wsUrl);
    return new CDP(client);
  }

  /** 连接到第一个页面 target，返回 { cdp, sessionId, target } */
  static async attachPage(port, urlFilter) {
    const list = await CDP.list(port);
    const pages = list.filter((t) => t.type === 'page' && /^https?:/.test(t.url || ''));
    let target = urlFilter ? pages.find((t) => (t.url || '').includes(urlFilter)) : pages[0];
    if (!target) target = pages[0];
    if (!target) throw new Error('浏览器里没有可用的页面标签');
    const cdp = await CDP.connect(target.webSocketDebuggerUrl);
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.id, flatten: true });
    return { cdp, sessionId, target };
  }

  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }
    if (msg.id && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${msg.error.message}${msg.error.data ? ' / ' + msg.error.data : ''}`));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method) {
      const hs = this.handlers.get(msg.method);
      if (hs) for (const h of hs) { try { h(msg.params, msg.sessionId); } catch (_) { /* ignore */ } }
    }
  }

  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method).add(handler);
    return () => this.handlers.get(method).delete(handler);
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.client.send(JSON.stringify(payload)); } catch (e) { this.pending.delete(id); reject(e); }
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('cdp timeout: ' + method));
        }
      }, 120000);
    });
  }

  /** 在页面里执行表达式并取回 JSON 可序列化的结果 */
  async eval(sessionId, expression, { awaitPromise = true, timeout = 120000 } = {}) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
      timeout,
    }, sessionId);
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      const msg = (d.exception && (d.exception.description || d.exception.value)) || d.text || 'eval error';
      throw new Error(String(msg).split('\n')[0]);
    }
    return res.result ? res.result.value : undefined;
  }

  async navigate(sessionId, url) {
    await this.send('Page.enable', {}, sessionId).catch(() => {});
    await this.send('Page.navigate', { url }, sessionId);
  }

  currentUrl(sessionId) {
    return this.eval(sessionId, 'location.href');
  }

  bringToFront(sessionId) {
    return this.send('Page.bringToFront', {}, sessionId);
  }

  close() { this.client.close(); }
}

module.exports = { CDP, httpJson };
