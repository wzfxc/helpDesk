import type { Category, Priority } from '@helpdesk/shared';
import type TestAgent from 'supertest/lib/agent.js';
import type { TestContext, TestUser } from './app.js';
import { createUser, loginAs } from './app.js';

export interface World {
  customer: TestUser;
  customer2: TestUser;
  billingAgent: TestUser;
  techAgent: TestUser;
  lead: TestUser;
  as: {
    customer: TestAgent;
    customer2: TestAgent;
    billingAgent: TestAgent;
    techAgent: TestAgent;
    lead: TestAgent;
  };
}

export async function createWorld(ctx: TestContext): Promise<World> {
  const customer = await createUser(ctx.db, 'customer', [], 'Olena Customer');
  const customer2 = await createUser(ctx.db, 'customer', [], 'Petro Customer');
  const billingAgent = await createUser(ctx.db, 'agent', ['billing'], 'Ivan Billing');
  const techAgent = await createUser(ctx.db, 'agent', ['technical'], 'Maria Tech');
  const lead = await createUser(ctx.db, 'lead', [], 'Lead');
  return {
    customer,
    customer2,
    billingAgent,
    techAgent,
    lead,
    as: {
      customer: await loginAs(ctx, customer),
      customer2: await loginAs(ctx, customer2),
      billingAgent: await loginAs(ctx, billingAgent),
      techAgent: await loginAs(ctx, techAgent),
      lead: await loginAs(ctx, lead),
    },
  };
}

export interface CreatedTicket {
  id: string;
  number: number;
  version: number;
  status: string;
  priority: Priority;
  firstResponseDueAt: string | null;
  resolutionDueAt: string | null;
}

export async function createTicket(
  agent: TestAgent,
  overrides: Partial<{
    subject: string;
    category: Category;
    priority: Priority;
    body: string;
    attachmentIds: string[];
  }> = {},
): Promise<CreatedTicket> {
  const res = await agent.post('/tickets').send({
    subject: 'Payment failed',
    category: 'billing',
    priority: 'normal',
    body: 'My card was charged twice',
    ...overrides,
  });
  if (res.status !== 201)
    throw new Error(`create failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as CreatedTicket;
}
