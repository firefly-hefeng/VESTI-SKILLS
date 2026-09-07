/**
 * VESTI Configuration
 * Manages ~/.vesti/ paths and config file
 */

import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import type { VestiConfigData } from '../types/index.js';

const DEFAULT_CONFIG: VestiConfigData = {
  storage: {
    basePath: path.join(os.homedir(), '.vesti'),
  },
  api: {
    host: '127.0.0.1',
    port: 7777,
  },
  watch: {
    enabled: true,
    stabilityThreshold: 500,
  },
};

export class VestiConfig {
  private data: VestiConfigData;
  private configFilePath: string;

  constructor(overrides?: Partial<VestiConfigData>) {
    this.data = { ...DEFAULT_CONFIG };
    if (overrides?.storage) this.data.storage = { ...this.data.storage, ...overrides.storage };
    if (overrides?.api) this.data.api = { ...this.data.api, ...overrides.api };
    if (overrides?.watch) this.data.watch = { ...this.data.watch, ...overrides.watch };
    this.configFilePath = path.join(this.data.storage.basePath, 'config', 'vesti.json');
  }

  get basePath(): string { return this.data.storage.basePath; }
  get dbPath(): string { return path.join(this.basePath, 'db', 'vesti.db'); }
  get vaultPath(): string { return path.join(this.basePath, 'vault'); }
  get exportsPath(): string { return path.join(this.basePath, 'exports'); }
  get logsPath(): string { return path.join(this.basePath, 'logs'); }
  get apiHost(): string { return this.data.api.host; }
  get apiPort(): number { return this.data.api.port; }
  get watchEnabled(): boolean { return this.data.watch.enabled; }
  get stabilityThreshold(): number { return this.data.watch.stabilityThreshold; }

  async load(): Promise<void> {
    if (await fs.pathExists(this.configFilePath)) {
      try {
        const saved = await fs.readJSON(this.configFilePath);
        if (saved.storage) this.data.storage = { ...this.data.storage, ...saved.storage };
        if (saved.api) this.data.api = { ...this.data.api, ...saved.api };
        if (saved.watch) this.data.watch = { ...this.data.watch, ...saved.watch };
      } catch {
        // Use defaults on parse error
      }
    }
  }

  async save(): Promise<void> {
    await fs.ensureDir(path.dirname(this.configFilePath));
    await fs.writeJSON(this.configFilePath, this.data, { spaces: 2 });
  }

  async ensureDirectories(): Promise<void> {
    const dirs = [
      this.basePath,
      path.join(this.basePath, 'db'),
      this.vaultPath,
      this.exportsPath,
      this.logsPath,
      path.join(this.basePath, 'config'),
    ];
    for (const dir of dirs) {
      await fs.ensureDir(dir);
    }
  }

  toJSON(): VestiConfigData {
    return { ...this.data };
  }

  set(key: string, value: string): void {
    const parts = key.split('.');
    if (parts.length === 2) {
      const [section, field] = parts;
      if (section in this.data) {
        (this.data as any)[section][field] = isNaN(Number(value)) ? value : Number(value);
      }
    }
  }

  get(key: string): string | undefined {
    const parts = key.split('.');
    if (parts.length === 2) {
      const [section, field] = parts;
      if (section in this.data) {
        return String((this.data as any)[section]?.[field]);
      }
    }
    return undefined;
  }
}
