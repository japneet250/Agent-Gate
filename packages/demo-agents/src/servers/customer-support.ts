#!/usr/bin/env node
import { startStdioServer } from './make-server.js';

startStdioServer('customer-support').catch((err) => {
  console.error('[mock:customer-support] fatal', err);
  process.exit(1);
});
