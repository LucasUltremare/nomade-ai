import { randomUUID } from 'node:crypto';

export interface HandoffEntry {
  id: string;
  at: string;
  from?: string;
  to: string;
  source: 'selection' | 'last-output' | 'manual';
  submitted: boolean;
  chars: number;
  preview: string;
}

export class HandoffLog {
  private readonly entries: HandoffEntry[] = [];
  constructor(private readonly max = 500) {}

  add(entry: Omit<HandoffEntry, 'id' | 'at' | 'chars' | 'preview'> & { text: string }): HandoffEntry {
    const { text, ...rest } = entry;
    const e: HandoffEntry = {
      id: randomUUID(),
      at: new Date().toISOString(),
      ...rest,
      chars: text.length,
      preview: text.replace(/\s+/g, ' ').slice(0, 120),
    };
    this.entries.push(e);
    if (this.entries.length > this.max) this.entries.shift();
    return e;
  }

  list(): HandoffEntry[] {
    return [...this.entries];
  }
}
