'use strict';
/**
 * 零依赖 WebSocket 客户端（RFC 6455），只为和本地 CDP 端口通信。
 * 目标是让工具在 Node 18+ 上直接跑，不需要 npm install。
 */
const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');

class WsClient extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.frag = null;
    this.closed = false;
    socket.on('data', (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      this._parse();
    });
    socket.on('close', () => this._onClose());
    socket.on('error', (e) => this.emit('error', e));
  }

  _onClose() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  _parse() {
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const op = b0 & 0x0f;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        off = 10;
      }
      if (this.buf.length < off + len) return;
      const payload = this.buf.subarray(off, off + len);
      this.buf = this.buf.subarray(off + len);

      if (op === 0x8) { this._sendFrame(0x8, Buffer.alloc(0)); this.socket.destroy(); this._onClose(); return; }
      if (op === 0x9) { this._sendFrame(0xa, payload); continue; }
      if (op === 0xa) continue;
      if (op === 0x0 || op === 0x1 || op === 0x2) {
        this.frag = this.frag ? Buffer.concat([this.frag, payload]) : Buffer.from(payload);
        if (fin) {
          const msg = this.frag;
          this.frag = null;
          this.emit('message', msg.toString('utf8'));
        }
      }
    }
  }

  _sendFrame(op, payload) {
    if (this.socket.destroyed) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | op, 0x80 | len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | op;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | op;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    const mask = crypto.randomBytes(4);
    const masked = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  send(text) {
    this._sendFrame(0x1, Buffer.from(text, 'utf8'));
  }

  close() {
    try { this._sendFrame(0x8, Buffer.alloc(0)); } catch (_) { /* ignore */ }
    this.socket.destroy();
    this._onClose();
  }
}

function connect(wsUrl, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const m = /^ws:\/\/([^/:]+):(\d+)(\/.*)?$/.exec(wsUrl);
    if (!m) return reject(new Error('bad ws url: ' + wsUrl));
    const host = m[1];
    const port = Number(m[2]);
    const path = m[3] || '/';
    const socket = net.connect(port, host);
    const key = crypto.randomBytes(16).toString('base64');
    let handshook = false;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('websocket handshake timeout: ' + wsUrl));
    }, timeoutMs);

    socket.on('connect', () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\n` +
        `Host: ${host}:${port}\r\n` +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${key}\r\n` +
        'Sec-WebSocket-Version: 13\r\n\r\n'
      );
    });

    const onData = (chunk) => {
      const idx = chunk.indexOf('\r\n\r\n');
      if (idx < 0) return;
      const head = chunk.subarray(0, idx).toString('latin1');
      if (!/^HTTP\/1\.1 101/i.test(head)) {
        clearTimeout(timer);
        socket.destroy();
        return reject(new Error('websocket upgrade failed: ' + head.split('\r\n')[0]));
      }
      socket.removeListener('data', onData);
      const rest = chunk.subarray(idx + 4);
      clearTimeout(timer);
      handshook = true;
      const client = new WsClient(socket);
      resolve(client);
      if (rest.length) {
        client.buf = Buffer.from(rest);
        client._parse();
      }
    };
    socket.on('data', onData);
    socket.on('error', (e) => { if (!handshook) { clearTimeout(timer); reject(e); } });
  });
}

module.exports = { connect };
