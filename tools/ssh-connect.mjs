// Minimal HTTP CONNECT pipe for ssh ProxyCommand.
// usage: node tools/ssh-connect.mjs <host> <port>
import net from 'node:net';

const host = process.argv[2];
const port = Number(process.argv[3] ?? 22);
const proxy = process.env.SSH_PROXY || 'http://127.0.0.1:7900';
const url = new URL(proxy);

const socket = net.connect(Number(url.port || 8080), url.hostname, () => {
  socket.write('CONNECT ' + host + ':' + port + ' HTTP/1.1\r\nHost: ' + host + ':' + port + '\r\n\r\n');
});
let buffer = Buffer.alloc(0);
let connected = false;
socket.on('data', (chunk) => {
  if (connected) {
    process.stdout.write(chunk);
    return;
  }
  buffer = Buffer.concat([buffer, chunk]);
  const end = buffer.indexOf('\r\n\r\n');
  if (end < 0) return;
  const head = buffer.subarray(0, end).toString('latin1');
  if (!/^HTTP\/1\.[01] 200/i.test(head)) {
    console.error('proxy error: ' + head.split('\r\n')[0]);
    process.exit(1);
  }
  connected = true;
  const rest = buffer.subarray(end + 4);
  if (rest.length > 0) process.stdout.write(rest);
  buffer = Buffer.alloc(0);
});
socket.on('error', (error) => {
  console.error('proxy socket error: ' + error.message);
  process.exit(1);
});
process.stdin.on('data', (chunk) => socket.write(chunk));
process.stdin.on('end', () => socket.end());
process.stdin.resume();
