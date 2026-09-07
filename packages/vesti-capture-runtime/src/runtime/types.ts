import type { AgentPlatform } from '../types/index.js';
import type { WslDetection } from '../platform/WslDetector.js';

export const CAPTURE_DAEMON_PROTOCOL_VERSION = 1 as const;

export const DEFAULT_CAPTURE_PLATFORMS = [
  'codex',
  'cursor',
  'kimi-code',
  'claude-code',
  'trae',
  'coder',
  'workbuddy',
] as const satisfies readonly AgentPlatform[];

export type CaptureRuntimePlatform = typeof DEFAULT_CAPTURE_PLATFORMS[number];
export type CaptureRuntimeState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

export interface CaptureSyncSummary {
  reason: string;
  startedAt: number;
  completedAt: number;
  sessions: number;
  messages: number;
  tools: number;
  turns: number;
  linksResolved: number;
  errors: string[];
}

export interface CaptureSourceStatus {
  platform: CaptureRuntimePlatform;
  enabled: boolean;
  installed: boolean | null;
  sessionFileCount: number | null;
  lastError?: string;
}

export interface CaptureRuntimeStatus {
  state: CaptureRuntimeState;
  pid: number;
  basePath: string;
  dbPath: string;
  vaultPath: string;
  startedAt: number | null;
  uptimeMs: number;
  watching: boolean;
  syncing: boolean;
  initialSyncComplete: boolean;
  enabledPlatforms: CaptureRuntimePlatform[];
  sources: CaptureSourceStatus[];
  wsl: WslDetection | null;
  lastSync: CaptureSyncSummary | null;
  lastError: string | null;
  wslPollIntervalMs: number;
  reconcileIntervalMs: number;
}

export interface CaptureDaemonStatus extends CaptureRuntimeStatus {
  protocolVersion: typeof CAPTURE_DAEMON_PROTOCOL_VERSION;
  socketPath: string;
  lockPath: string;
}

export type CaptureDaemonRequest =
  | { id: string; command: 'ping' }
  | { id: string; command: 'status' }
  | { id: string; command: 'sync'; reason?: string }
  | { id: string; command: 'shutdown' };

export type CaptureDaemonRequestInput =
  | { id?: string; command: 'ping' }
  | { id?: string; command: 'status' }
  | { id?: string; command: 'sync'; reason?: string }
  | { id?: string; command: 'shutdown' };

export interface CaptureDaemonPingResult {
  protocolVersion: typeof CAPTURE_DAEMON_PROTOCOL_VERSION;
  pid: number;
  ready: boolean;
  state: CaptureRuntimeState;
}

export interface CaptureDaemonSuccessResponse<T = unknown> {
  id: string;
  ok: true;
  result: T;
}

export interface CaptureDaemonErrorResponse {
  id: string;
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

export type CaptureDaemonResponse<T = unknown> =
  | CaptureDaemonSuccessResponse<T>
  | CaptureDaemonErrorResponse;
