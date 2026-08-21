import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server } from 'socket.io';

// Aquí va el Redis adapter (se implementa en T-106)
@WebSocketGateway({ namespace: '/tracking' })
export class TrackingGateway {
  @WebSocketServer()
  server: Server;
}
