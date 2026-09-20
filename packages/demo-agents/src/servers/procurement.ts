#!/usr/bin/env node
import { startStdioServer } from './make-server.js';

startStdioServer('procurement').catch((err) => {
  console.error('[mock:procurement] fatal', err);
  process.exit(1);
});
