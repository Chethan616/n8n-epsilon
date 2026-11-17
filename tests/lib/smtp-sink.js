'use strict';
// A minimal SMTP server that records every message it accepts. Modes let a test make delivery
// succeed, be rejected, or hang (to simulate a crash while a send is in flight).
const net = require('net');
const path = require('path');

const N8N_MODULES = path.join(process.env.N8N_DIR || path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'n8n'), 'node_modules');
const { simpleParser } = require(path.join(N8N_MODULES, 'mailparser'));

class SmtpSink {
  constructor() {
    this.messages = []; // { to: [...], subject, text, receivedAt }
    this.mode = 'ok'; // 'ok' | 'reject' | 'hang'
    this.rejectCode = '550 5.7.1 Mailbox unavailable (injected)';
    this.attempts = 0; // DATA commands seen, including rejected ones
    this.rejectCount = 0; // reject the next N messages, then accept again
    this.onData = null; // async hook(raw) - called before the reply
    this.server = null;
    this.sockets = new Set();
  }

  reset() { this.messages = []; this.mode = 'ok'; this.attempts = 0; this.rejectCount = 0; this.onData = null; }

  subjects() { return this.messages.map((m) => m.subject); }
  count(re) { return this.messages.filter((m) => re.test(m.subject)).length; }

  handleSocket(sock) {
    this.sockets.add(sock);
    sock.on('close', () => this.sockets.delete(sock));
    sock.on('error', () => {});
    let buf = '';
    let inData = false;
    let data = '';
    const send = (s) => { if (!sock.destroyed) sock.write(s + '\r\n'); };
    send('220 sink ESMTP ready');

    const onLine = async (line) => {
      if (inData) {
        if (line === '.') {
          inData = false;
          const raw = data;
          data = '';
          this.attempts += 1;
          if (this.onData) await this.onData(raw);
          if (this.mode === 'hang') return; // never reply
          if (this.mode === 'reject') return send(this.rejectCode);
          if (this.rejectCount > 0) { this.rejectCount -= 1; return send(this.rejectCode); } // reject only the next N messages
          const parsed = await simpleParser(raw);
          this.messages.push({
            to: [].concat(parsed.to ? parsed.to.value.map((a) => a.address) : []),
            subject: parsed.subject || '',
            text: parsed.text || '',
            receivedAt: Date.now(),
          });
          return send('250 2.0.0 queued');
        }
        data += (line.startsWith('..') ? line.slice(1) : line) + '\r\n';
        return undefined;
      }
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === 'EHLO') { send('250-sink'); return send('250 8BITMIME'); }
      if (cmd === 'HELO') return send('250 sink');
      if (cmd === 'MAIL' || cmd === 'RCPT' || cmd === 'RSET' || cmd === 'NOOP') return send('250 OK');
      if (cmd === 'DATA') { inData = true; return send('354 End data with <CR><LF>.<CR><LF>'); }
      if (cmd === 'QUIT') { send('221 bye'); return sock.end(); }
      return send('502 not implemented');
    };

    let chain = Promise.resolve();
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        chain = chain.then(() => onLine(line)).catch(() => {});
      }
    });
  }

  start(port = 0) {
    return new Promise((resolve) => {
      this.server = net.createServer((s) => this.handleSocket(s));
      this.server.listen(port, '127.0.0.1', () => resolve(this.server.address().port));
    });
  }
  stop() {
    return new Promise((resolve) => {
      this.sockets.forEach((s) => s.destroy());
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }
}

module.exports = { SmtpSink };
