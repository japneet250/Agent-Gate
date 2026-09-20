#!/usr/bin/env node
import { startStdioServer } from './make-server.js';

startStdioServer('coding').catch((err) => {
  console.error('[mock:coding] fatal', err);
  process.exit(1);
});
