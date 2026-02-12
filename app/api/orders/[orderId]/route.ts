import { NextResponse } from 'next/server';
import { cancelOrder } from '@/lib/polymarket/trading';
import { prisma } from '@/lib/db/prisma';

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ orderId: string }> },
) {
  try {
    const { orderId } = await params;

    // Cancel on Polymarket
    await cancelOrder(orderId);

    // Update DB if we have a record
    const dbOrder = await prisma.order.findUnique({
      where: { externalId: orderId },
    });

    if (dbOrder) {
      await prisma.order.update({
        where: { id: dbOrder.id },
        data: { status: 'CANCELLED' },
      });
    }

    return NextResponse.json({ success: true, orderId });
  } catch (error) {
    console.error('Failed to cancel order:', error);
    return NextResponse.json(
      { error: 'Failed to cancel order' },
      { status: 500 },
    );
  }
}
