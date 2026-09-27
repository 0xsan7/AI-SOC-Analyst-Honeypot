/**
 * Connection cap for public honeypot listeners.
 *
 * A public listener on a small VPS will eventually meet more concurrent
 * connections than it can hold. Without a cap, each one allocates a socket, a
 * buffer and (for SSH) crypto state, so the process gets OOM-killed or the
 * box becomes unresponsive — taking capture down entirely.
 *
 * When the cap is hit, the NEW connection is refused immediately rather than
 * the oldest being killed. Refusing is the right shape for a honeypot: a
 * scanner that gets refused retries later, while killing a live session
 * destroys the very capture we want to keep.
 *
 * Config:
 *   MAX_CONNECTIONS   concurrent sessions allowed (default 64)
 *   MAX_PER_IP        concurrent sessions from one source IP (default 8)
 */
export class ConnectionLimiter {
  private active = 0;
  private readonly perIp = new Map<string, number>();

  constructor(
    private readonly max = Number(process.env.MAX_CONNECTIONS ?? 64),
    private readonly maxPerIp = Number(process.env.MAX_PER_IP ?? 8),
  ) {}

  /** Reserve a slot, or return null when at capacity. */
  acquire(ip: string): boolean {
    const fromIp = this.perIp.get(ip) ?? 0;
    if (this.active >= this.max || fromIp >= this.maxPerIp) return false;
    this.active += 1;
    this.perIp.set(ip, fromIp + 1);
    return true;
  }

  release(ip: string): void {
    this.active = Math.max(0, this.active - 1);
    const left = (this.perIp.get(ip) ?? 1) - 1;
    if (left <= 0) this.perIp.delete(ip);
    else this.perIp.set(ip, left);
  }

  get activeCount(): number {
    return this.active;
  }
  get trackedIps(): number {
    return this.perIp.size;
  }
}
