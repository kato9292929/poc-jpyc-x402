import { closeSync, existsSync, mkdirSync, openSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { del, head, put } from '@vercel/blob';
import type { RecordStore } from './buyer.ts';
import { VercelBlobLogStore } from './logstore/blob.ts';
import { FileLogStore } from './logstore/file.ts';

const lockName = (key: string) => key.replace(/[^0-9A-Za-z_-]/g, '_');

/** ローカル（CLI）：$dir/YYYY-MM-DD.jsonl とロックファイル */
export class FileRecordStore implements RecordStore {
  private readonly logs: FileLogStore;
  constructor(private readonly dir: string) {
    this.logs = new FileLogStore(dir);
  }
  append(day: string, line: string) {
    return this.logs.append(day, line);
  }
  read(day: string) {
    return this.logs.read(day);
  }
  async tryLock(key: string) {
    const d = join(this.dir, 'lock');
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
    try {
      closeSync(openSync(join(d, lockName(key)), 'wx'));
      return true;
    } catch {
      return false;
    }
  }
  async unlock(key: string) {
    rmSync(join(this.dir, 'lock', lockName(key)), { force: true });
  }
}

/** Vercel（Cron）：買い手専用の Blob ストアの log/YYYY-MM-DD.jsonl と lock/<key> */
export class BlobRecordStore implements RecordStore {
  private readonly logs: VercelBlobLogStore;
  constructor(private readonly token: string) {
    this.logs = new VercelBlobLogStore({ token });
  }
  append(day: string, line: string) {
    return this.logs.append(day, line);
  }
  read(day: string) {
    return this.logs.read(day);
  }
  async tryLock(key: string) {
    try {
      await put(`lock/${lockName(key)}`, new Date().toISOString(), { access: 'private', token: this.token, addRandomSuffix: false, allowOverwrite: false });
      return true;
    } catch (e) {
      // 既にある（別の実行が取った）
      try {
        await head(`lock/${lockName(key)}`, { token: this.token });
        return false;
      } catch {
        throw e;
      }
    }
  }
  async unlock(key: string) {
    await del(`lock/${lockName(key)}`, { token: this.token });
  }
}
