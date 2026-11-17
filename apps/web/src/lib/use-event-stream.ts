'use client';

import { useEffect } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { ServerEvent, Ticket, TicketDetail } from '@helpdesk/shared';
import {
  appendMessage,
  mergeTicketIntoPages,
  replaceTicket,
  type TicketPages,
} from './ticket-cache';

export interface TypingInfo {
  userId: string;
  name: string;
  at: number;
}

/** Applies one server event to the TanStack Query cache. Exported for unit tests. */
export function applyServerEvent(qc: QueryClient, event: ServerEvent): void {
  switch (event.type) {
    case 'ticket.created':
    case 'ticket.updated': {
      const ticket: Ticket = event.ticket;
      qc.setQueryData<TicketDetail>(['ticket', ticket.id], (d) => replaceTicket(d, ticket));
      let missing = false;
      for (const [key, data] of qc.getQueriesData<TicketPages>({ queryKey: ['tickets'] })) {
        const merged = mergeTicketIntoPages(data, ticket);
        if (merged.found) qc.setQueryData(key, merged.data);
        else missing = true;
      }
      // A ticket that is not in any loaded list may belong to one (new ticket, new match):
      // refetch the active lists; rows already shown keep their DOM position and selection.
      if (missing) void qc.invalidateQueries({ queryKey: ['tickets'], refetchType: 'active' });
      break;
    }
    case 'message.created':
      qc.setQueryData<TicketDetail>(['ticket', event.ticketId], (d) =>
        appendMessage(d, event.message),
      );
      break;
    case 'notification.created':
      void qc.invalidateQueries({ queryKey: ['notifications'] });
      break;
    case 'typing':
      qc.setQueryData<TypingInfo>(['typing', event.ticketId], {
        userId: event.user.id,
        name: event.user.name,
        at: Date.now(),
      });
      break;
  }
}

const EVENT_TYPES = [
  'message.created',
  'ticket.created',
  'ticket.updated',
  'notification.created',
  'typing',
] as const;

/** One SSE connection per signed-in session; EventSource reconnects by itself. */
export function useEventStream(enabled: boolean): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    const source = new EventSource('/api/events');
    let opened = false;
    const onMessage = (e: MessageEvent<string>) => {
      try {
        applyServerEvent(qc, JSON.parse(e.data) as ServerEvent);
      } catch {
        /* ignore malformed events */
      }
    };
    for (const type of EVENT_TYPES) source.addEventListener(type, onMessage as EventListener);
    source.onopen = () => {
      // After a reconnect events may have been missed: refetch what is on screen.
      if (opened) void qc.invalidateQueries({ refetchType: 'active' });
      opened = true;
    };
    return () => {
      source.close();
    };
  }, [enabled, qc]);
}
