import type { Message, Ticket, TicketDetail, TicketListResponse } from '@helpdesk/shared';

/** Structural subset of TanStack's InfiniteData (avoids depending on its generics). */
export interface TicketPages {
  pages: TicketListResponse[];
  pageParams: unknown[];
}

/**
 * Applies a ticket.updated/created event to a cached list WITHOUT re-sorting or re-rendering
 * other rows: an existing row is replaced in place (same position → scroll and selection stay),
 * unknown tickets are reported so the caller can refetch. Pure, unit-tested.
 */
export function mergeTicketIntoPages(
  data: TicketPages | undefined,
  ticket: Ticket,
): { data: TicketPages | undefined; found: boolean } {
  if (!data) return { data, found: false };
  const pageIndex = data.pages.findIndex((p) => p.items.some((t) => t.id === ticket.id));
  const page = data.pages[pageIndex];
  if (!page) return { data, found: false };
  const index = page.items.findIndex((t) => t.id === ticket.id);
  const existing = page.items[index];
  // Never replace a newer version with an older one (out-of-order events).
  if (existing && existing.version > ticket.version) return { data, found: true };
  const items = page.items.slice();
  items[index] = ticket;
  const pages = data.pages.slice();
  pages[pageIndex] = { ...page, items };
  return { data: { ...data, pages }, found: true };
}
export function appendMessage(
  detail: TicketDetail | undefined,
  message: Message,
): TicketDetail | undefined {
  if (!detail) return detail;
  if (detail.messages.some((m) => m.id === message.id)) return detail;
  return { ...detail, messages: [...detail.messages, message] };
}

export function replaceTicket(
  detail: TicketDetail | undefined,
  ticket: Ticket,
): TicketDetail | undefined {
  if (!detail || detail.ticket.version > ticket.version) return detail;
  return { ...detail, ticket };
}

/** All ids across pages, flattened. */
export const flattenTickets = (data: TicketPages | undefined): Ticket[] =>
  data ? data.pages.flatMap((p) => p.items) : [];
