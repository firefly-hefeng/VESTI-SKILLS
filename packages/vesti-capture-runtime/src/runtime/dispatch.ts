import {
  CAPTURE_DAEMON_PROTOCOL_VERSION,
  type CaptureDaemonPingResult,
  type CaptureDaemonRequest,
  type CaptureDaemonResponse,
  type CaptureDaemonStatus,
  type CaptureSyncSummary,
} from './types.js';

export interface CaptureDaemonCommandController {
  getStatus(): CaptureDaemonStatus;
  sync(reason?: string): Promise<CaptureSyncSummary>;
  requestShutdown(): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function dispatchCaptureDaemonRequest(
  request: CaptureDaemonRequest,
  controller: CaptureDaemonCommandController,
): Promise<CaptureDaemonResponse> {
  try {
    if (request.command === 'ping') {
      const status = controller.getStatus();
      const result: CaptureDaemonPingResult = {
        protocolVersion: CAPTURE_DAEMON_PROTOCOL_VERSION,
        pid: status.pid,
        ready: status.state === 'running' && status.initialSyncComplete,
        state: status.state,
      };
      return { id: request.id, ok: true, result };
    }
    if (request.command === 'status') {
      return { id: request.id, ok: true, result: controller.getStatus() };
    }
    if (request.command === 'sync') {
      const status = controller.getStatus();
      if (status.state !== 'running' || !status.initialSyncComplete) {
        return {
          id: request.id,
          ok: false,
          error: { code: 'NOT_READY', message: 'Capture daemon is still initializing' },
        };
      }
      return {
        id: request.id,
        ok: true,
        result: await controller.sync(request.reason ?? 'ipc'),
      };
    }
    controller.requestShutdown();
    return { id: request.id, ok: true, result: { shuttingDown: true } };
  } catch (error) {
    return {
      id: request.id,
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: errorMessage(error) },
    };
  }
}
