import { McjsError } from "../errors.ts";
import { type JsonValue, serialize } from "./serialize.ts";

export class EventBuffer {
  private sequence = 0;
  private streamId = crypto.randomUUID();
  private entries: {
    cursor: string;
    sequence: number;
    botId: string;
    generation: number;
    timestamp: string;
    type: string;
    payload: JsonValue;
  }[] = [];
  constructor(
    private daemonId: string,
    private botId: string,
    private capacity = 10_000,
  ) {}
  push(type: string, payload: unknown, generation: number) {
    const sequence = ++this.sequence;
    const cursor = `${this.daemonId}:${this.botId}:${this.streamId}:${sequence}`;
    this.entries.push({
      cursor,
      sequence,
      botId: this.botId,
      generation,
      timestamp: new Date().toISOString(),
      type,
      payload: serialize(payload, 64 * 1024),
    });
    if (this.entries.length > this.capacity) this.entries.shift();
    return cursor;
  }
  read(since?: string) {
    let sequence = 0;
    if (since) {
      const prefix = `${this.daemonId}:${this.botId}:${this.streamId}:`;
      if (
        !since.startsWith(prefix) ||
        !/^\d+$/.test(since.slice(prefix.length))
      )
        throw new McjsError(
          "CURSOR_INVALID",
          "Cursor belongs to another bot or daemon",
        );
      sequence = Number(since.slice(prefix.length));
      if (sequence > this.sequence)
        throw new McjsError(
          "CURSOR_INVALID",
          "Cursor is ahead of event history",
        );
      const oldest = this.entries[0];
      if (oldest && sequence < oldest.sequence - 1)
        throw new McjsError(
          "CURSOR_EXPIRED",
          `Oldest available cursor: ${oldest.cursor}`,
        );
    }
    return {
      events: this.entries.filter((e) => e.sequence > sequence),
      cursor: `${this.daemonId}:${this.botId}:${this.streamId}:${this.sequence}`,
    };
  }
}
