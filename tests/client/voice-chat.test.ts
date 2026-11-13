/** Voice mesh fixes (glare, mic never stuck, ICE refresh, auto restart) and chat bubbles for incoming lines. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VoiceMesh, ICE_MAX_AGE_MS } from '../../src/client/voice/mesh';
import { Chat } from '../../src/client/ui/chat';
import { SIGNAL_PER_10S } from '../../src/worker/core';
import type { ChatMsg, Net } from '../../src/client/net/types';

function fakeNet() {
  const h: Record<string, Array<(v: unknown) => void>> = {};
  const sent: unknown[] = [];
  let iceCalls = 0;
  const net = {
    on: (k: string, f: (v: unknown) => void) => { (h[k] ??= []).push(f); return () => {}; },
    send: (m: unknown) => sent.push(m),
    iceServers: async () => { iceCalls++; return [{ urls: 'stun:stun.example:3478' }]; },
  } as unknown as Net;
  return { net, sent, fire: (k: string, v: unknown) => h[k]?.forEach((f) => f(v)), get iceCalls() { return iceCalls; } };
}

class FakePC {
  static all: FakePC[] = [];
  transceivers: { sender: { replaceTrack: (t: unknown) => Promise<void> }; direction: string }[] = [];
  connectionState = 'new';
  onconnectionstatechange: (() => void) | null = null;
  restarts = 0;
  throwOnTransceivers = false;
  config: unknown;
  constructor(c: unknown) { this.config = c; FakePC.all.push(this); }
  addTransceiver() { const t = { sender: { replaceTrack: async () => {} }, direction: 'sendrecv' }; this.transceivers.push(t); return t; }
  getTransceivers() { if (this.throwOnTransceivers) throw new Error('closed'); return this.transceivers; }
  getConfiguration() { return this.config; }
  setConfiguration(c: unknown) { this.config = c; }
  restartIce() { this.restarts++; }
  close() {}
}

const g = globalThis as Record<string, unknown>;
const saved: Record<string, unknown> = {};
beforeEach(() => {
  FakePC.all = [];
  for (const k of ['RTCPeerConnection', 'Audio', 'document', 'window', 'AudioContext']) saved[k] = g[k];
  g.RTCPeerConnection = FakePC;
  g.Audio = class { style = {}; srcObject = null; setAttribute() {} remove() {} };
  g.document = { body: { append() {} } };
  g.window = { setTimeout: () => 0, setInterval: () => 0 };
  g.AudioContext = undefined; // no Web Audio: the level meter fails, the mic must still work
});
afterEach(() => { for (const [k, v] of Object.entries(saved)) g[k] = v; });

const openLink = (m: VoiceMesh, self: string, other: string) => {
  (m as unknown as { selfId: string }).selfId = self;
  m.setRoster([self, other]);
  return FakePC.all.at(-1)!;
};

describe('voice: no offer glare', () => {
  it('only the impolite side (smaller id) adds the audio transceiver', () => {
    const a = new VoiceMesh(fakeNet().net);
    expect(openLink(a, 'aaaa000000', 'bbbb000000').transceivers.length).toBe(1);
    const b = new VoiceMesh(fakeNet().net);
    expect(openLink(b, 'bbbb000000', 'aaaa000000').transceivers.length).toBe(0);
  });
});

describe('voice: mic never stuck on connecting', () => {
  it('a throwing link and no AudioContext still end in live', async () => {
    const track = { kind: 'audio', enabled: true, stop() {} };
    const nav = globalThis.navigator as unknown as Record<string, unknown>;
    const prev = Object.getOwnPropertyDescriptor(nav, 'mediaDevices');
    Object.defineProperty(nav, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getAudioTracks: () => [track], getTracks: () => [track] }) } });
    try {
      const m = new VoiceMesh(fakeNet().net);
      openLink(m, 'aaaa000000', 'bbbb000000').throwOnTransceivers = true;
      await m.enableMic();
      expect(m.micState).toBe('live');
    } finally {
      if (prev) Object.defineProperty(nav, 'mediaDevices', prev); else delete nav.mediaDevices;
    }
  });
  it('a refused mic ends in denied', async () => {
    const nav = globalThis.navigator as unknown as Record<string, unknown>;
    const prev = Object.getOwnPropertyDescriptor(nav, 'mediaDevices');
    Object.defineProperty(nav, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => { throw new Error('NotAllowed'); } } });
    try {
      const m = new VoiceMesh(fakeNet().net);
      await m.enableMic();
      expect(m.micState).toBe('denied');
    } finally {
      if (prev) Object.defineProperty(nav, 'mediaDevices', prev); else delete nav.mediaDevices;
    }
  });
});

describe('voice: ICE servers refreshed before TURN credentials expire', () => {
  it('refetches only when older than 30 min and applies the list to open links', async () => {
    const f = fakeNet();
    const m = new VoiceMesh(f.net);
    const pc = openLink(m, 'aaaa000000', 'bbbb000000');
    await m.refreshIce(); // never fetched yet -> fetch
    const n = f.iceCalls;
    expect(n).toBeGreaterThanOrEqual(1);
    await m.refreshIce(Date.now() + 60_000);
    expect(f.iceCalls).toBe(n);
    await m.refreshIce(Date.now() + ICE_MAX_AGE_MS + 1000);
    expect(f.iceCalls).toBe(n + 1);
    expect((pc.config as { iceServers: unknown[] }).iceServers).toEqual([{ urls: 'stun:stun.example:3478' }]);
  });
});

describe('voice: automatic ICE restart on failure (bounded)', () => {
  it('restarts ICE when a link fails, at most twice', async () => {
    const m = new VoiceMesh(fakeNet().net);
    const pc = openLink(m, 'aaaa000000', 'bbbb000000');
    (m as unknown as { iceAt: number }).iceAt = Date.now(); // fresh: restart without a fetch
    for (let i = 0; i < 4; i++) { pc.connectionState = 'failed'; pc.onconnectionstatechange?.(); await Promise.resolve(); await Promise.resolve(); }
    expect(pc.restarts).toBe(2);
    expect(m.peers.get('bbbb000000')?.status).toBe('failed');
  });
  it('signalling marks lastSignalAt (rate errors from voice traffic are not toasted)', () => {
    const f = fakeNet();
    const m = new VoiceMesh(f.net);
    (m as unknown as { sig(to: string, d: unknown): void }).sig('bbbb000000', { c: { candidate: 'x' } });
    expect(Date.now() - m.lastSignalAt).toBeLessThan(1000);
    expect(SIGNAL_PER_10S).toBe(600);
  });
});

describe('chat: incoming lines pop up', () => {
  const msg = (from: string, text = 'مرحبا يا جماعة'): ChatMsg => ({ id: 'i' + from, from, name: 'أبو علي', text, at: 1 });
  it('only for other people, not muted, while the sheet is closed', () => {
    const f = fakeNet();
    const c = new Chat(f.net, () => 'me');
    const got: ChatMsg[] = [];
    c.onIncoming = (m) => got.push(m);
    f.fire('chat', { msg: msg('me') });
    f.fire('chat', { msg: msg('other') });
    (c as unknown as { muted: Set<string> }).muted.add('rude');
    f.fire('chat', { msg: msg('rude') });
    expect(got.map((m) => m.from)).toEqual(['other']);
    expect(c.unread).toBe(1);
  });
});
