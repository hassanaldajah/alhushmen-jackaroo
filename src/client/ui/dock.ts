import { h, icon, clear } from './dom';
import { T } from './ar';
import type { MicState } from '../voice/mesh';

/** Left-edge dock, always visible (lobby and table): one big mic button (tap = mute/unmute) and chat. */
export function createDock(onMic: () => void, onChat: () => void) {
  const mic = h('button', { type: 'button', class: 'dock-mic muted', 'aria-pressed': 'false', 'aria-label': T.micOff });
  const chat = h('button', { type: 'button', class: 'dock-chat', 'aria-label': T.chat }, icon('chat'));
  const el = h('div', { class: 'dock', hidden: true }, mic, chat);
  mic.addEventListener('click', () => { navigator.vibrate?.(10); onMic(); });
  chat.addEventListener('click', onChat);
  let unread = 0;
  const drawChat = () => { clear(chat, icon('chat'), unread ? h('span', { class: 'badge dock-badge' }, String(unread)) : null); };
  drawChat();
  const labels: Record<MicState, [string, string, string]> = {
    live: ['live', 'mic', T.micLive], muted: ['muted', 'mic-off', T.micMuted], listen: ['muted', 'mic-off', T.micMuted],
    connecting: ['connecting', 'mic', '...'], denied: ['denied', 'mic-off', T.micBlocked], unavailable: ['muted', 'mic-off', T.voiceNo],
  };
  return {
    el,
    show(on: boolean): void { el.hidden = !on; },
    setMic(state: MicState, speaking: boolean): void {
      const [cls, ic, lbl] = labels[state];
      mic.className = 'dock-mic ' + cls + (speaking ? ' speaking' : '');
      mic.setAttribute('aria-pressed', String(state === 'live'));
      mic.setAttribute('aria-label', `${state === 'live' ? T.micOn : T.micOff} (${lbl})`);
      clear(mic, icon(ic), h('span', { class: 'dock-lbl' }, state === 'live' ? T.micLive : T.micMuted));
    },
    setUnread(n: number): void { unread = n; drawChat(); },
  };
}
