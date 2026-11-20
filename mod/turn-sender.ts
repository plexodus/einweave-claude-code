/**
 * RFC-038 D3 — ONE ordered sender from the mod to its MCP server (`POST /turn`, the UI socket).
 *
 * - One post in flight.
 * - Ordered posts (tool, spawn, report) go in event order; a snapshot queued before one goes before it, so
 *   the server never sees a spawn ahead of the step that lit the spawning turn.
 * - Snapshots are coalesced (one marker at the tail at most) and BUILT WHEN SENT, so a snapshot is never older
 *   than an ordered post ahead of it.
 * - Every post carries `epoch` (random per module instance) and `seq` (counter, given at each attempt).
 * - A failed post stays at the head and is tried again at the next event or `resend()` (the socket changed or
 *   answered again). Nothing is derived from time.
 */
import type { TurnPost } from '../types/turn'
import type { OrderedPost, SnapshotBody } from './turn-loops'

type Item = OrderedPost | 'snapshot'

export class TurnSender {
  private readonly queue: Item[] = []
  private seq = 0
  private sending = false
  /** Until `release()`: the first snapshot waits for the seed (a reload must name the loops still working). */
  private held = true
  /** The head failed and waits for an event or `resend()`. */
  private failed = false
  /** The head is being posted now. */
  private inFlight = false

  constructor(
    readonly epoch: string,
    private readonly build: () => SnapshotBody,
    /** Sends one post; resolves true when the server took it. */
    private readonly post: (p: TurnPost) => Promise<boolean>,
  ) {}

  /** The loops changed: a snapshot goes (once, however many changes come before it is sent). */
  changed(): void {
    // The head in flight was built already: a change after it needs a snapshot of its own.
    const tail = this.queue.length - 1
    if (this.queue[tail] !== 'snapshot' || (tail === 0 && this.inFlight)) this.queue.push('snapshot')
    this.kick()
  }

  /** An ordered post, behind everything queued before it. */
  ordered(p: OrderedPost): void {
    this.queue.push(p)
    this.kick()
  }

  /** The socket changed or answered after a failure: send the snapshot again (and anything still queued). */
  resend(): void {
    this.changed()
  }

  /** Start sending (after the seed). */
  release(): void {
    this.held = false
    this.kick()
  }

  /** The head failed and nothing has retried it yet. */
  get stalled(): boolean {
    return this.failed
  }

  /** Posts waiting (for a test). */
  get waiting(): number {
    return this.queue.length
  }

  private kick(): void {
    if (this.sending || this.held) return
    this.sending = true
    void this.drain().then(ok => {
      this.sending = false
      this.failed = !ok
      // Queued after the drain's last look, before this ran: send it now (a failure waits for the next event).
      if (ok && this.queue.length) this.kick()
    })
  }

  /** True when the queue ran empty, false when a post failed (it stays at the head). */
  private async drain(): Promise<boolean> {
    while (this.queue.length) {
      const head = this.queue[0]
      const body = (head === 'snapshot' ? { ...this.build(), epoch: this.epoch, seq: ++this.seq } : { ...head, epoch: this.epoch, seq: ++this.seq }) as TurnPost
      let ok = false
      this.inFlight = true
      try {
        ok = await this.post(body)
      } catch {
        ok = false
      } finally {
        this.inFlight = false
      }
      if (!ok) return false // stays at the head: the next event or resend() tries again
      this.queue.shift()
    }
    return true
  }
}
