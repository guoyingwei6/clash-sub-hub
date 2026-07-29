import { TextKv } from '../../src/storage/config-state';

export interface KvOperation {
  type: 'get' | 'put' | 'delete';
  key: string;
  value?: string;
  expirationTtl?: number;
}

export class FakeKv implements TextKv {
  readonly operations: KvOperation[] = [];
  private readonly values = new Map<string, string>();
  private failOnWriteNumber: number | null = null;
  private writeCount = 0;

  constructor(initial: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(initial)) this.values.set(key, value);
  }

  async get(key: string): Promise<string | null> {
    this.operations.push({ type: 'get', key });
    return this.values.get(key) ?? null;
  }

  async put(
    key: string,
    value: string,
    options?: { expirationTtl?: number }
  ): Promise<void> {
    this.writeCount += 1;
    this.operations.push({
      type: 'put',
      key,
      value,
      expirationTtl: options?.expirationTtl,
    });
    if (this.failOnWriteNumber === this.writeCount) {
      throw new Error(`fixture write ${this.writeCount} failed`);
    }
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.writeCount += 1;
    this.operations.push({ type: 'delete', key });
    if (this.failOnWriteNumber === this.writeCount) {
      throw new Error(`fixture write ${this.writeCount} failed`);
    }
    this.values.delete(key);
  }

  failOnWrite(number: number): void {
    this.failOnWriteNumber = number;
  }

  clearOperations(): void {
    this.operations.length = 0;
    this.writeCount = 0;
  }

  peek(key: string): string | null {
    return this.values.get(key) ?? null;
  }
}
