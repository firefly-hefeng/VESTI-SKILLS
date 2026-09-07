export interface CaptureRuntimeClient {
  ensure(): Promise<unknown>;
  status(): Promise<unknown>;
  sync(reason?: string): Promise<unknown>;
}

export interface CaptureRuntimeConnectionOptions {
  dbPath?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

interface CaptureRuntimeClientModule {
  ensureCaptureDaemon?: (options?: CaptureRuntimeConnectionOptions) => Promise<unknown>;
  getCaptureDaemonStatus?: (options?: CaptureRuntimeConnectionOptions) => Promise<unknown>;
  requestCaptureDaemon?: (
    request: { id?: string; command: 'ping' | 'status' | 'sync' | 'shutdown'; reason?: string },
    options?: CaptureRuntimeConnectionOptions,
  ) => Promise<unknown>;
}

/**
 * Load the runtime lazily so `vesti status` can still explain a broken or
 * incomplete installation instead of failing during module initialization.
 */
export async function loadCaptureRuntimeClient(
  options: CaptureRuntimeConnectionOptions = {},
): Promise<CaptureRuntimeClient> {
  const specifier: string = '@vesti/capture-runtime/client';
  let runtime: CaptureRuntimeClientModule;
  try {
    runtime = await import(specifier) as CaptureRuntimeClientModule;
  } catch (error) {
    throw new Error(
      `cannot load ${specifier}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (
    typeof runtime.ensureCaptureDaemon !== 'function'
    || typeof runtime.getCaptureDaemonStatus !== 'function'
    || typeof runtime.requestCaptureDaemon !== 'function'
  ) {
    throw new Error(`${specifier} does not expose the expected daemon client API`);
  }

  return {
    ensure: () => runtime.ensureCaptureDaemon!(options),
    status: () => runtime.getCaptureDaemonStatus!(options),
    sync: async (reason = 'vesti-cli') => {
      await runtime.ensureCaptureDaemon!(options);
      return runtime.requestCaptureDaemon!({ command: 'sync', reason }, options);
    },
  };
}

export function daemonLooksReady(status: unknown): boolean {
  if (status === true) return true;
  if (!status || typeof status !== 'object' || Array.isArray(status)) return false;
  const value = status as Record<string, unknown>;
  if (value.running === false || value.ready === false || value.ok === false) return false;
  // The current daemon publishes both fields. Do not call a merely-listening
  // process ready until schema creation and its first reconciliation finished.
  if (value.state === 'running') return value.initialSyncComplete === true;
  return value.running === true
    || value.ready === true
    || value.ok === true
    || value.alive === true
    || value.status === 'running'
    || value.status === 'ready';
}
