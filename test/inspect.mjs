// Attaches to a node inspector the way a debugger would and evaluates an
// expression in the debugged process.
//
// Usage: node inspect.mjs HOST [PORT]
const [host, port = '9229'] = process.argv.slice(2);

setTimeout(() => {
  console.error('Timed out connecting to the inspector');
  process.exit(1);
}, 10000).unref();

const targets = await (await fetch(`http://${host}:${port}/json/list`)).json();
const socket = new WebSocket(targets[0].webSocketDebuggerUrl);

socket.addEventListener('open', () => {
  socket.send(JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: { expression: 'process.argv[1]' }
  }));
});
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id === 1) {
    console.log(JSON.stringify({ targets: targets.length, script: message.result.result.value }));
    socket.close();
    process.exit(0);
  }
});
socket.addEventListener('error', (event) => {
  console.error('Inspector connection failed', event.message || '');
  process.exit(1);
});
