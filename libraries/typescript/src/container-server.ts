/**
 * Container Server Entrypoint — boots the ContainerSlotManager HTTP/WebSocket server
 * on port 8080 (or process.env.CAPACITY_HTTP_PORT) for Cloudflare Containers.
 */

import { ContainerSlotManager } from './utils/container-slot-manager';
import { getLogger } from './logger';

const port = parseInt(process.env.CAPACITY_HTTP_PORT || '8080', 10);
const maxSlots = parseInt(process.env.MAX_CONTAINER_CALL_SLOTS || '4', 10);

getLogger().info(
  `[PATTER] Booting C++ ONNX Inference Container Engine (maxSlots=${maxSlots}, port=${port})...`
);

const slotManager = new ContainerSlotManager({
  maxSlots,
  httpPort: port,
});

// Keep process event loop active indefinitely for Cloudflare Containers
setInterval(() => {
  const stats = slotManager.getCapacityStats();
  getLogger().debug(`[PATTER] ContainerSlotManager heart-beat: active=${stats.activeCalls}/${stats.maxSlots}`);
}, 60000);

process.on('SIGTERM', () => {
  getLogger().info('[PATTER] Container server shutting down cleanly (SIGTERM)');
  slotManager.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  getLogger().info('[PATTER] Container server shutting down cleanly (SIGINT)');
  slotManager.close();
  process.exit(0);
});
