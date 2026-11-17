import type { Role, Status } from './enums';

/**
 * What caused a status change. The same table drives api validation, the web UI
 * (which buttons are offered) and the README.
 */
export const TRANSITION_TRIGGERS = [
  'staff_manual',
  'staff_public_reply',
  'staff_reply_pending',
  'staff_reply_resolve',
  'customer_reply',
  'customer_resolve',
  'auto_close',
] as const;
export type TransitionTrigger = (typeof TRANSITION_TRIGGERS)[number];

export type TransitionActor = Role | 'system';

export interface TransitionRule {
  from: Status;
  to: Status;
  trigger: TransitionTrigger;
  actors: readonly TransitionActor[];
}

const STAFF = ['agent', 'lead'] as const;

export const TRANSITIONS: readonly TransitionRule[] = [
  // Manual changes by staff (PATCH /tickets/:id, POST /tickets/bulk)
  { from: 'new', to: 'open', trigger: 'staff_manual', actors: STAFF },
  { from: 'new', to: 'pending', trigger: 'staff_manual', actors: STAFF },
  { from: 'new', to: 'resolved', trigger: 'staff_manual', actors: STAFF },
  { from: 'open', to: 'pending', trigger: 'staff_manual', actors: STAFF },
  { from: 'open', to: 'resolved', trigger: 'staff_manual', actors: STAFF },
  { from: 'pending', to: 'open', trigger: 'staff_manual', actors: STAFF },
  { from: 'pending', to: 'resolved', trigger: 'staff_manual', actors: STAFF },
  { from: 'resolved', to: 'open', trigger: 'staff_manual', actors: STAFF },
  { from: 'resolved', to: 'closed', trigger: 'staff_manual', actors: STAFF },

  // Public reply by staff without an explicit follow-up status
  { from: 'new', to: 'open', trigger: 'staff_public_reply', actors: STAFF },
  { from: 'pending', to: 'open', trigger: 'staff_public_reply', actors: STAFF },

  // "Send and wait for customer"
  { from: 'new', to: 'pending', trigger: 'staff_reply_pending', actors: STAFF },
  { from: 'open', to: 'pending', trigger: 'staff_reply_pending', actors: STAFF },
  { from: 'resolved', to: 'pending', trigger: 'staff_reply_pending', actors: STAFF },

  // "Send and resolve"
  { from: 'new', to: 'resolved', trigger: 'staff_reply_resolve', actors: STAFF },
  { from: 'open', to: 'resolved', trigger: 'staff_reply_resolve', actors: STAFF },
  { from: 'pending', to: 'resolved', trigger: 'staff_reply_resolve', actors: STAFF },

  // Customer replies
  { from: 'pending', to: 'open', trigger: 'customer_reply', actors: ['customer'] },
  { from: 'resolved', to: 'open', trigger: 'customer_reply', actors: ['customer'] },

  // "Problem solved" button
  { from: 'new', to: 'resolved', trigger: 'customer_resolve', actors: ['customer'] },
  { from: 'open', to: 'resolved', trigger: 'customer_resolve', actors: ['customer'] },
  { from: 'pending', to: 'resolved', trigger: 'customer_resolve', actors: ['customer'] },

  // Background job: resolved for 3 days without a customer reply
  { from: 'resolved', to: 'closed', trigger: 'auto_close', actors: ['system'] },
];

export function findTransition(
  from: Status,
  to: Status,
  trigger: TransitionTrigger,
): TransitionRule | undefined {
  return TRANSITIONS.find((r) => r.from === from && r.to === to && r.trigger === trigger);
}

export function canTransition(
  from: Status,
  to: Status,
  trigger: TransitionTrigger,
  actor: TransitionActor,
): boolean {
  const rule = findTransition(from, to, trigger);
  return rule !== undefined && rule.actors.includes(actor);
}

/** Targets a staff member may pick manually from the given status. */
export function manualTargets(from: Status): Status[] {
  return TRANSITIONS.filter((r) => r.from === from && r.trigger === 'staff_manual').map(
    (r) => r.to,
  );
}

export type ReplyFollowUp = 'pending' | 'resolved';

export type ReplyOutcome =
  | { kind: 'keep' }
  | { kind: 'set'; to: Status; trigger: TransitionTrigger }
  /** Customer replied to a closed ticket: create a new ticket linked to the old one. */
  | { kind: 'spawn' }
  | { kind: 'reject'; reason: 'ticket_closed' | 'invalid_transition' | 'forbidden' };

/**
 * Decides what happens to the ticket status when a message is posted.
 * Internal notes never change the status.
 */
export function statusAfterMessage(input: {
  current: Status;
  role: Role;
  internal: boolean;
  followUp?: ReplyFollowUp | undefined;
}): ReplyOutcome {
  const { current, role, internal, followUp } = input;

  if (role === 'customer') {
    if (internal || followUp !== undefined) return { kind: 'reject', reason: 'forbidden' };
    if (current === 'closed') return { kind: 'spawn' };
    if (canTransition(current, 'open', 'customer_reply', 'customer')) {
      return { kind: 'set', to: 'open', trigger: 'customer_reply' };
    }
    return { kind: 'keep' };
  }

  if (current === 'closed') return { kind: 'reject', reason: 'ticket_closed' };
  if (internal) {
    return followUp === undefined ? { kind: 'keep' } : { kind: 'reject', reason: 'forbidden' };
  }

  if (followUp !== undefined) {
    if (current === followUp) return { kind: 'keep' };
    const trigger: TransitionTrigger =
      followUp === 'pending' ? 'staff_reply_pending' : 'staff_reply_resolve';
    return canTransition(current, followUp, trigger, role)
      ? { kind: 'set', to: followUp, trigger }
      : { kind: 'reject', reason: 'invalid_transition' };
  }

  if (canTransition(current, 'open', 'staff_public_reply', role)) {
    return { kind: 'set', to: 'open', trigger: 'staff_public_reply' };
  }
  return { kind: 'keep' };
}
