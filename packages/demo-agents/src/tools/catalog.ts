import { z } from 'zod';

/**
 * Single source of truth for the mock tool surface.
 * The MCP servers (src/servers) and the OpenAI demo agents (src/agents) both
 * derive from this, so a tool name/arg shape is only ever defined once.
 */
export type MockTool = {
  name: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  /** Canned success payload. Receives the parsed args so it can echo them back. */
  respond: (args: Record<string, unknown>) => Record<string, unknown>;
};

export type ToolServerName = 'customer-support' | 'procurement' | 'coding';

const id = (prefix: string) =>
  `${prefix}_${Math.random().toString(36).slice(2, 10)}`;

export const customerSupportTools: MockTool[] = [
  {
    name: 'send_email',
    description: 'Send an email to a customer.',
    schema: z.object({
      to: z.string().describe('Recipient email address'),
      subject: z.string(),
      body: z.string(),
    }),
    respond: (a) => ({
      status: 'sent',
      messageId: id('msg'),
      to: a.to,
      deliveredAt: new Date().toISOString(),
    }),
  },
  {
    name: 'lookup_customer',
    description: 'Look up a customer record by email or customer id.',
    schema: z.object({
      query: z.string().describe('Email address or customer id'),
      fields: z
        .array(z.string())
        .optional()
        .describe('Specific fields to return, e.g. ["ssn","card_number"]'),
    }),
    respond: (a) => ({
      customerId: 'cus_10432',
      name: 'Dana Whitfield',
      email: 'dana.whitfield@example.com',
      plan: 'pro',
      ssn: '***-**-4412',
      card_number: '**** **** **** 7781',
      matchedOn: a.query,
    }),
  },
  {
    name: 'issue_refund',
    description: 'Issue a refund against a customer order.',
    schema: z.object({
      orderId: z.string(),
      amount: z.number().describe('Refund amount in USD'),
      reason: z.string().optional(),
    }),
    respond: (a) => ({
      status: 'refunded',
      refundId: id('ref'),
      orderId: a.orderId,
      amount: a.amount,
    }),
  },
];

export const procurementTools: MockTool[] = [
  {
    name: 'create_purchase_order',
    description: 'Create a purchase order with a vendor.',
    schema: z.object({
      vendor: z.string(),
      amount: z.number().describe('Total PO amount in USD'),
      lineItems: z.array(z.string()).optional(),
    }),
    respond: (a) => ({
      status: 'created',
      poNumber: id('po'),
      vendor: a.vendor,
      amount: a.amount,
    }),
  },
  {
    name: 'approve_payment',
    description: 'Approve an outgoing payment to a vendor.',
    schema: z.object({
      poNumber: z.string(),
      amount: z.number().describe('Payment amount in USD'),
    }),
    respond: (a) => ({
      status: 'approved',
      paymentId: id('pay'),
      poNumber: a.poNumber,
      amount: a.amount,
    }),
  },
  {
    name: 'check_budget',
    description: 'Check the remaining budget for a department.',
    schema: z.object({
      department: z.string(),
    }),
    respond: (a) => ({
      department: a.department,
      budgetUsd: 50000,
      spentUsd: 18250,
      remainingUsd: 31750,
      approvalThresholdUsd: 10000,
    }),
  },
];

export const codingTools: MockTool[] = [
  {
    name: 'run_command',
    description: 'Run a shell command in the project workspace.',
    schema: z.object({
      command: z.string(),
      cwd: z.string().optional(),
    }),
    respond: (a) => ({
      exitCode: 0,
      stdout: `[mock] executed: ${String(a.command)}`,
      stderr: '',
    }),
  },
  {
    name: 'write_file',
    description: 'Write contents to a file in the project workspace.',
    schema: z.object({
      path: z.string(),
      contents: z.string(),
    }),
    respond: (a) => ({
      status: 'written',
      path: a.path,
      bytes: String(a.contents ?? '').length,
    }),
  },
  {
    name: 'query_database',
    description: 'Run a SQL query against the application database.',
    schema: z.object({
      sql: z.string(),
    }),
    respond: (a) => ({
      rowCount: 3,
      rows: [
        { id: 1, email: 'dana.whitfield@example.com' },
        { id: 2, email: 'omar.reyes@example.com' },
        { id: 3, email: 'lin.zhou@example.com' },
      ],
      executed: a.sql,
    }),
  },
];

export const TOOL_SERVERS: Record<ToolServerName, MockTool[]> = {
  'customer-support': customerSupportTools,
  procurement: procurementTools,
  coding: codingTools,
};

export function toolsFor(server: ToolServerName): MockTool[] {
  return TOOL_SERVERS[server];
}

/** Flat lookup across every server, for the eval harness and agents. */
export const ALL_TOOLS: MockTool[] = Object.values(TOOL_SERVERS).flat();

export function findTool(name: string): MockTool | undefined {
  return ALL_TOOLS.find((t) => t.name === name);
}
