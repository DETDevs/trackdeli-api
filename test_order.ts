import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  try {
    const businessId = 'd32a6baa-cf48-422c-a4e2-8826702f3257';
    const createdBy = '070e0f9f-4990-41a2-9a62-cd294684669b'; // user carlos

    const business = await prisma.business.findUnique({ where: { id: businessId } });
    console.log('Business:', business);

    const order = await prisma.order.create({
      data: {
        customerName: "Ana González",
        customerPhone: "88887777",
        destinationAddress: "Semáforos del Colonial 2c al sur",
        destinationLat: 12.1364,
        destinationLng: -86.2714,
        geofenceRadiusM: 100,
        description: "1 pollo entero + 2 refrescos",
        deliveryPaymentStatus: "CONTRA_ENTREGA",
        deliveryFee: 30,
        status: "PENDIENTE",
        businessId,
        createdBy,
      },
      include: {
        deliveryUser: true,
        photos: true,
      },
    });

    console.log('Order created:', order);

    const trackingSession = await prisma.trackingSession.findUnique({
      where: { orderId: order.id },
    });
    console.log('Tracking session:', trackingSession);
  } catch (err) {
    console.error('Error creating order:');
    console.error(err);
  } finally {
    await prisma.$disconnect();
  }
}

main();
