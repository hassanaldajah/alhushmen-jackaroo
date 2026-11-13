import { h, icon, clear } from './dom';
import { T } from './ar';
import type { MicState } from '../voice/mesh';

/**
 * Left-edge dock (lobby and table only, never before login): the big mic button (tap = mute/unmute),
 * the joke button right under it, then chat. Hidden on the intro, the passphrase gate and every end screen.
 */
export function createDock(onMic: () => void, onChat: () => void, onJoke: () => void, onHost: () => void) {
  const mic = h('button', { type: 'button', class: 'dock-mic muted', 'aria-pressed': 'false', 'aria-label': T.micOff });
  const joke = h('button', { type: 'button', class: 'dock-btn dock-joke', 'aria-label': T.jokeBtn, title: T.jokeBtn }, icon('joke'), h('span', { class: 'dock-lbl' }, T.jokeBtn));
  const host = h('button', { type: 'button', class: 'dock-btn dock-host', 'aria-label': T.claimHost, title: T.claimHost }, icon('crown'), h('span', { class: 'dock-lbl' }, T.claimHost));
  const chat = h('button', { type: 'button', class: 'dock-btn dock-chat', 'aria-label': T.chat, title: T.chat }, icon('chat'), h('span', { class: 'dock-lbl' }, T.chatLabel));
  const el = h('div', { class: 'dock', hidden: true }, mic, host, joke, chat);
  mic.addEventListener('click', () => { navigator.vibrate?.(10); onMic(); });
  chat.addEventListener('click', onChat);
  joke.addEventListener('click', onJoke);
  host.addEventListener('click', onHost);
  let unread = 0;
  const drawChat = () => {
    clear(chat, icon('chat'), h('span', { class: 'dock-lbl' }, T.chatLabel), unread ? h('span', { class: 'badge dock-badge' }, String(unread)) : null);
    chat.setAttribute('aria-label', unread ? `${T.chat} (${unread})` : T.chat);
  };
  drawChat();
  const labels: Record<MicState, [string, string, string]> = {
    live: ['live', 'mic', T.micLive], muted: ['muted', 'mic-off', T.micMuted], listen: ['muted', 'mic-off', T.micMuted],
    connecting: ['connecting', 'mic', '...'], denied: ['denied', 'mic-off', T.micBlocked], unavailable: ['muted', 'mic-off', T.voiceNo],
  };
  return {
    el,
    get shown(): boolean { return !el.hidden; },
    show(on: boolean): void { el.hidden = !on; document.documentElement.classList.toggle('has-dock', on); },
    setMic(state: MicState, speaking: boolean): void {
      const [cls, ic, lbl] = labels[state];
      mic.className = 'dock-mic ' + cls + (speaking ? ' speaking' : '');
      mic.setAttribute('aria-pressed', String(state === 'live'));
      mic.setAttribute('aria-label', `${state === 'live' ? T.micOn : T.micOff} (${lbl})`);
      clear(mic, icon(ic), h('span', { class: 'dock-lbl' }, state === 'live' ? T.micLive : T.micMuted));
    },
    setUnread(n: number): void { unread = n; drawChat(); },
    /** Host button state: nobody is host (claim), I am host (menu) or someone else is (ask to change). */
    setHost(kind: 'none' | 'me' | 'other'): void {
      const label = kind === 'none' ? T.claimHost : kind === 'me' ? T.stHost : T.changeHost;
      host.className = 'dock-btn dock-host ' + kind;
      host.setAttribute('aria-label', label); host.title = label;
      clear(host, icon('crown'), h('span', { class: 'dock-lbl' }, label));
    },
    /** Brief "wait" state while the joke cooldown runs. */
    jokeBusy(on: boolean): void { joke.toggleAttribute('aria-busy', on); joke.classList.toggle('busy', on); },
  };
}
