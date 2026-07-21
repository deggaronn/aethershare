const map = new Map();

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (data && data.type === 'PORT') {
    const port = event.ports[0];
    const transferId = data.transferId;
    
    port.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'start') {
        const { filename, size } = msg;
        let controller;
        const stream = new ReadableStream({
          start(c) {
            controller = c;
          },
          cancel() {
            port.postMessage({ type: 'cancelled' });
          }
        });
        map.set(transferId, { stream, controller, filename, size });
        port.postMessage({ type: 'ready' });
      } else if (msg.type === 'chunk') {
        const item = map.get(transferId);
        if (item && item.controller) {
          // Convert array buffer or array back to Uint8Array if needed
          const chunkData = msg.chunk instanceof Uint8Array ? msg.chunk : new Uint8Array(msg.chunk);
          item.controller.enqueue(chunkData);
        }
      } else if (msg.type === 'end') {
        const item = map.get(transferId);
        if (item && item.controller) {
          item.controller.close();
          map.delete(transferId);
        }
      } else if (msg.type === 'error') {
        const item = map.get(transferId);
        if (item && item.controller) {
          item.controller.error(new Error(msg.error || 'Transfer error'));
          map.delete(transferId);
        }
      }
    };
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.includes('download-stream')) {
    const transferId = url.searchParams.get('id');
    const item = map.get(transferId);
    if (!item) {
      event.respondWith(new Response('Active transfer stream expired or not found.', { status: 404 }));
      return;
    }
    
    // Set headers for download dialog
    const headers = new Headers({
      'Content-Type': 'application/octet-stream; charset=utf-8',
      // Safe content disposition
      'Content-Disposition': `attachment; filename="${encodeURIComponent(item.filename)}"; filename*=UTF-8''${encodeURIComponent(item.filename)}`,
      'Content-Length': item.size,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
      'X-Content-Type-Options': 'nosniff'
    });
    
    event.respondWith(new Response(item.stream, { headers }));
  }
});
