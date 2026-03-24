import { getEngine } from '@/lib/arb/engine';

export const dynamic = 'force-dynamic';

/**
 * SSE endpoint streaming real-time prices from Binance, Coinbase, and Polymarket.
 * Pushes every 200ms for smooth chart updates.
 */
export async function GET() {
  const encoder = new TextEncoder();
  const engine = getEngine();

  const stream = new ReadableStream({
    start(controller) {
      const interval = setInterval(() => {
        try {
          const prices = engine.getPrices();
          const data = JSON.stringify(prices);
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        } catch {
          // ignore errors during encoding
        }
      }, 200);

      // Cleanup when client disconnects
      const cleanup = () => {
        clearInterval(interval);
        try { controller.close(); } catch { /* already closed */ }
      };

      // Store cleanup for cancel signal
      (controller as any)._cleanup = cleanup;
    },
    cancel() {
      // Called when client disconnects
      if ((this as any)._cleanup) (this as any)._cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
