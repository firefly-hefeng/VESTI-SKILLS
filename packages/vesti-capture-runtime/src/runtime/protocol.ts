import type {
  CaptureDaemonRequest,
  CaptureDaemonResponse,
} from './types.js';

const REQUEST_COMMANDS = new Set(['ping', 'status', 'sync', 'shutdown']);
export const DEFAULT_MAX_NDJSON_LINE_BYTES = 1024 * 1024;

export class CaptureProtocolError extends Error {
  constructor(message: string, readonly code = 'INVALID_REQUEST') {
    super(message);
    this.name = 'CaptureProtocolError';
  }
}

export function encodeNdjson(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export function parseCaptureDaemonRequest(value: unknown): CaptureDaemonRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CaptureProtocolError('Request must be a JSON object');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || record.id.trim().length === 0 || record.id.length > 128) {
    throw new CaptureProtocolError('Request id must be a non-empty string of at most 128 characters');
  }
  if (typeof record.command !== 'string' || !REQUEST_COMMANDS.has(record.command)) {
    throw new CaptureProtocolError('Unsupported capture daemon command', 'UNKNOWN_COMMAND');
  }
  if (record.command === 'sync') {
    if (record.reason !== undefined && typeof record.reason !== 'string') {
      throw new CaptureProtocolError('sync.reason must be a string');
    }
    return {
      id: record.id,
      command: 'sync',
      reason: typeof record.reason === 'string' ? record.reason.slice(0, 200) : undefined,
    };
  }
  return { id: record.id, command: record.command } as CaptureDaemonRequest;
}

export function parseCaptureDaemonResponse(value: unknown): CaptureDaemonResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CaptureProtocolError('Response must be a JSON object', 'INVALID_RESPONSE');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || typeof record.ok !== 'boolean') {
    throw new CaptureProtocolError('Malformed capture daemon response', 'INVALID_RESPONSE');
  }
  if (record.ok) {
    return { id: record.id, ok: true, result: record.result };
  }
  const error = record.error;
  if (!error || typeof error !== 'object' || Array.isArray(error)) {
    throw new CaptureProtocolError('Malformed capture daemon error response', 'INVALID_RESPONSE');
  }
  const errorRecord = error as Record<string, unknown>;
  if (typeof errorRecord.code !== 'string' || typeof errorRecord.message !== 'string') {
    throw new CaptureProtocolError('Malformed capture daemon error response', 'INVALID_RESPONSE');
  }
  return {
    id: record.id,
    ok: false,
    error: { code: errorRecord.code, message: errorRecord.message },
  };
}

export interface NdjsonDecoder {
  push(chunk: Buffer | string): void;
  end(): void;
}

export function createNdjsonDecoder(
  onValue: (value: unknown) => void,
  onError: (error: Error) => void,
  maxLineBytes = DEFAULT_MAX_NDJSON_LINE_BYTES,
): NdjsonDecoder {
  let buffer = '';

  const parseLine = (line: string): void => {
    const normalized = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (normalized.trim().length === 0) return;
    if (Buffer.byteLength(normalized) > maxLineBytes) {
      onError(new CaptureProtocolError('NDJSON line exceeds the size limit', 'MESSAGE_TOO_LARGE'));
      return;
    }
    try {
      onValue(JSON.parse(normalized));
    } catch {
      onError(new CaptureProtocolError('Invalid JSON in NDJSON message', 'INVALID_JSON'));
    }
  };

  return {
    push(chunk) {
      buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
      if (Buffer.byteLength(buffer) > maxLineBytes && !buffer.includes('\n')) {
        buffer = '';
        onError(new CaptureProtocolError('NDJSON line exceeds the size limit', 'MESSAGE_TOO_LARGE'));
        return;
      }
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        parseLine(line);
        newline = buffer.indexOf('\n');
      }
    },
    end() {
      if (buffer.trim().length > 0) parseLine(buffer);
      buffer = '';
    },
  };
}
