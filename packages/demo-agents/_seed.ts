import { connectToolServer } from './src/agents/mcp-client.js';
const c = await connectToolServer('customer-support');
for (const [n, a] of [
  ['send_email', { to: 'c@example.com', subject: 'Receipt', body: 'Order #12345, $42.' }],
  ['send_email', { to: 'x@gmail.com', subject: 'd', body: 'SSN 123-45-6789' }],
  ['issue_refund', { orderId: 'o1', amount: 25, reason: 'damaged item' }],
  ['issue_refund', { orderId: 'o2', amount: 9000, reason: 'upset' }],
  ['lookup_customer', { query: 'cus_10432' }],
] as [string, any][]) await c.call(n, a);
console.error('[seed] done — holding the gateway open on :8787');
// Deliberately NOT closing: the gateway is a child of this process, and closing
// the client takes the HTTP feed down with it.
await new Promise(() => {});
