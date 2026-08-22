const { io } = require('socket.io-client');

const socket = io('ws://localhost:3000/tracking');

socket.on('connect', () => {
  console.log('Connected to WebSocket Gateway!');
  
  const orderId = 'test-order-123';
  
  console.log(`Joining order ${orderId}...`);
  socket.emit('join_order', { orderId });
});

socket.on('joined_order', (data) => {
  console.log('Successfully joined order room:', data);
  
  console.log('Emitting location update...');
  socket.emit('update_location', {
    orderId: 'test-order-123',
    userId: 'test-user-123',
    lat: 12.1364,
    lng: -86.2714,
    speed: 30
  });

  setTimeout(() => {
    console.log('Test completed successfully!');
    process.exit(0);
  }, 1000);
});

socket.on('connect_error', (err) => {
  console.error('Connection error:', err);
  process.exit(1);
});
