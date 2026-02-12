import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOpenOrders, placeOrder } from '@/lib/polymarket/trading';
import { prisma } from '@/lib/db/prisma';

const placeOrderSchema = z.object({
  conditionId: z.string().min(1),
  tokenId: z.string().min(1),
  side: z.enum(['BUY', 'SELL']),
  price: z.number().gt(0).lt(1),
  size: z.number().gt(0),
  outcome: z.string().min(1),
});

export async function GET() {
  try {
    const orders = await getOpenOrders();
    return NextResponse.json({ orders });
  } catch (error) {
    console.error('Failed to fetch open orders:', error);
    return NextResponse.json(
      { error: 'Failed to fetch open orders. Check trading credentials.' },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = placeOrderSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid order', details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const { conditionId, tokenId, side, price, size, outcome } = parsed.data;

    // Place order on Polymarket
    const result = await placeOrder({ tokenId, side, price, size });

    // Persist to DB
    let dbMarket = await prisma.market.findUnique({
      where: { conditionId },
    });

    if (!dbMarket) {
      dbMarket = await prisma.market.create({
        data: {
          conditionId,
          question: '',
          slug: '',
          endDate: '',
        },
      });
    }

    const dbOrder = await prisma.order.create({
      data: {
        externalId: result?.orderID || result?.id || null,
        marketId: dbMarket.id,
        tokenId,
        side,
        price,
        size,
        outcome,
        status: 'OPEN',
        type: 'LIMIT',
      },
    });

    return NextResponse.json({ order: dbOrder, polymarketResult: result });
  } catch (error) {
    console.error('Failed to place order:', error);
    return NextResponse.json(
      { error: 'Failed to place order. Check trading credentials and balance.' },
      { status: 500 },
    );
  }
}
