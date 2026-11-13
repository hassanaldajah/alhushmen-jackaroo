import './ui/tokens.css';
import './ui/app.css';
import { startApp } from './ui/app';
import { WsNet } from './net/socket';
import type { Net } from './net/types';

// MockNet is dev-only: the dynamic import is dropped from production builds.
async function makeNet(): Promise<Net> {
  if (import.meta.env.DEV && location.hostname === 'localhost' && new URLSearchParams(location.search).has('mock')) {
    const { MockNet } = await import('./net/mock');
    return new MockNet();
  }
  return new WsNet();
}
const root = document.getElementById('app');
if (root) void makeNet().then((net) => startApp(root, net));
