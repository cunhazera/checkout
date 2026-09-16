import type { ChargeRequest, ChargeResult, PaymentTerminal } from './payment-terminal.js';
import { config, type FakeTerminalMode } from '../config.js';

/**
 * Development and test driver. Every payment path in the arch doc is reachable
 * from here, so Phase 4 is fully testable with no hardware.
 *
 * `timeout_then_approve` returns 'unknown' from charge(), then keeps returning
 * 'unknown' from getStatus() until `resolveAfterPolls` polls have happened —
 * exercising the 2s/30s reconciliation loop rather than short-circuiting it.
 */
export class FakeTerminal implements PaymentTerminal {
  private polls = new Map<string, number>();

  constructor(
    private mode: FakeTerminalMode = config.fakeTerminalMode,
    private resolveAfterPolls = 3,
  ) {}

  setMode(mode: FakeTerminalMode): void {
    this.mode = mode;
    this.polls.clear();
  }

  async charge(req: ChargeRequest): Promise<ChargeResult> {
    switch (this.mode) {
      case 'approve':
        return { status: 'succeeded', providerPaymentId: `fake_${req.idempotencyKey}` };
      case 'decline':
        return { status: 'failed', declineReason: 'card_declined' };
      case 'timeout':
      case 'timeout_then_approve':
        return { status: 'unknown' };
    }
  }

  async getStatus(idempotencyKey: string): Promise<ChargeResult> {
    if (this.mode !== 'timeout_then_approve') return { status: 'unknown' };

    const seen = (this.polls.get(idempotencyKey) ?? 0) + 1;
    this.polls.set(idempotencyKey, seen);
    return seen >= this.resolveAfterPolls
      ? { status: 'succeeded', providerPaymentId: `fake_${idempotencyKey}` }
      : { status: 'unknown' };
  }
}
