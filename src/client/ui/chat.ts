import type { ChatMsg, Net } from '../net/types';
import { h, clear, bdi } from './dom';
import { T } from './ar';
import { button, openSheet } from './widgets';

const MAX = 300;

/**
 * Text chat. Messages live in memory only; per-person mute is local to this device.
 * Every string from the server is rendered with textContent (via the h() builder text nodes).
 */
export class Chat {
  private msgs: ChatMsg[] = [];
  private muted = new Set<string>();
  private open: { draw(): void } | null = null;
  unread = 0;
  onUnread: (n: number) => void = () => {};

  constructor(private net: Net, private selfId: () => string) {
    net.on('chatHistory', (m) => { this.msgs = m.msgs.slice(-100); this.open?.draw(); });
    net.on('chat', (m) => {
      this.msgs.push(m.msg); if (this.msgs.length > 100) this.msgs.shift();
      if (this.open) this.open.draw();
      else if (m.msg.from !== this.selfId() && !this.muted.has(m.msg.from)) { this.unread++; this.onUnread(this.unread); }
    });
  }

  show(): void {
    this.unread = 0; this.onUnread(0);
    const s = openSheet(T.chat, { side: true, tall: true, onClose: () => { this.open = null; } });
    const list = h('div', { class: 'list chatlist', role: 'log', 'aria-live': 'polite' });
    const draw = () => {
      const vis = this.msgs.filter((m) => !this.muted.has(m.from));
      clear(list, ...(vis.length ? vis.map((m) => {
        const mine = m.from === this.selfId();
        return h('div', { class: 'li chatline' + (mine ? ' mine' : '') },
          h('div', { style: { flex: 1, minWidth: 0 } }, h('strong', null, bdi(m.name)), h('div', { class: 'chattext' }, m.text)),
          mine ? null : button(T.chatMute, 'btn-secondary', () => { this.muted.add(m.from); draw(); }));
      }) : [h('div', { class: 'muted' }, T.chatEmpty)]));
      if (this.muted.size) list.append(button(`${T.chatUnmute} (${T.chatMuted}: ${this.muted.size})`, 'btn-secondary', () => { this.muted.clear(); draw(); }));
      list.scrollTop = list.scrollHeight;
    };
    this.open = { draw };
    const input = h('input', { class: 'input', maxlength: String(MAX), placeholder: T.chatPh, 'aria-label': T.chatPh, autocomplete: 'off', enterkeyhint: 'send' }) as HTMLInputElement;
    const form = h('form', { class: 'row', onsubmit: (e: Event) => {
      e.preventDefault();
      const t = input.value.trim();
      if (t) { this.net.send({ t: 'chat', text: t.slice(0, MAX) }); input.value = ''; }
    } }, input, h('button', { type: 'submit', class: 'btn btn-primary' }, T.chatSend));
    s.body.append(list, form);
    draw();
    input.focus();
  }
}
