import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface LlmConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs: number;
  maxTokens: number;
}

/** Deliberately separate from desktop settings and capture's vesti.json. */
export function loadLlmConfig(env: NodeJS.ProcessEnv = process.env, homeDir = os.homedir()): LlmConfig | null {
  if (env.VESTI_LLM_ENABLED === 'false' || env.VESTI_LLM_ENABLED === '0') return null;
  const configPath = env.VESTI_LLM_CONFIG?.trim()
    || path.join(env.VESTI_HOME?.trim() || env.VESTI_DATA_DIR?.trim() || path.join(homeDir, '.vesti'), 'config', 'llm.json');
  let saved: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    saved = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || env.VESTI_LLM_CONFIG) {
      throw new Error('Cannot read VESTI LLM configuration: expected a readable JSON object.');
    }
  }
  if (saved.enabled === false && env.VESTI_LLM_ENABLED !== 'true' && env.VESTI_LLM_ENABLED !== '1') return null;
  const string = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
  const baseUrl = string(env.VESTI_LLM_BASE_URL ?? saved.baseUrl).replace(/\/+$/, '');
  const model = string(env.VESTI_LLM_MODEL ?? saved.model);
  const apiKey = string(env.VESTI_LLM_API_KEY ?? saved.apiKey);
  if (!baseUrl && !model && !apiKey && !Object.keys(saved).length && !env.VESTI_LLM_ENABLED) return null;
  if (!baseUrl || !model) throw new Error('VESTI LLM requires baseUrl and model (or VESTI_LLM_BASE_URL and VESTI_LLM_MODEL).');
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new Error('VESTI LLM baseUrl must be an HTTP(S) URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('VESTI LLM baseUrl must be an HTTP(S) URL without credentials, query or fragment.');
  }
  const integer = (value: unknown, fallback: number, max: number, field: string): number => {
    const n = value === undefined ? fallback : Number(value);
    if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`VESTI LLM ${field} must be an integer between 1 and ${max}.`);
    return n;
  };
  return {
    baseUrl, model, ...(apiKey ? { apiKey } : {}),
    timeoutMs: integer(env.VESTI_LLM_TIMEOUT_MS ?? saved.timeoutMs, 30000, 120000, 'timeoutMs'),
    maxTokens: integer(env.VESTI_LLM_MAX_TOKENS ?? saved.maxTokens, 1500, 16384, 'maxTokens'),
  };
}

export class LlmClient {
  constructor(readonly config: LlmConfig, private readonly fetcher: typeof fetch = fetch) {}

  async complete(system: string, user: string, signal?: AbortSignal): Promise<string> {
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
    try {
      const response = await this.fetcher(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST', redirect: 'error', signal: combined,
        headers: { 'Content-Type': 'application/json', ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}) },
        body: JSON.stringify({
          model: this.config.model, stream: false, max_tokens: this.config.maxTokens,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`VESTI LLM HTTP ${response.status}`);
      }
      // Bound provider responses as well as the outgoing memory context.
      const reader = response.body?.getReader();
      if (!reader) throw new Error('VESTI LLM returned an empty response.');
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 2 * 1024 * 1024) {
            await reader.cancel();
            throw new Error('VESTI LLM response exceeds 2 MiB.');
          }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      let data;
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new Error('VESTI LLM returned invalid JSON.'); }
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) throw new Error('VESTI LLM returned no text in choices[0].message.content.');
      return content.trim();
    } catch (error) {
      if (combined.aborted) throw new Error(signal?.aborted ? 'VESTI LLM request cancelled.' : 'VESTI LLM request timed out.');
      // Never forward provider bodies or transport errors containing credentials.
      if (error instanceof Error && error.message.startsWith('VESTI LLM ')) throw error;
      throw new Error('VESTI LLM request failed. Check the endpoint and network connection.');
    }
  }
}
