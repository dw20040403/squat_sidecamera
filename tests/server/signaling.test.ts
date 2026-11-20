import { describe, expect, it } from 'vitest';
import { Room, type Peer } from '../../server/src/signaling';

class FakePeer implements Peer {
  inbox: any[] = [];
  closed = false;
  send(m: unknown) {
    this.inbox.push(m);
  }
  close() {
    this.closed = true;
  }
  last() {
    return this.inbox[this.inbox.length - 1];
  }
}

describe('シグナリング', () => {
  it('main・subが参加し、offer/answer/iceを中継する', () => {
    const room = new Room();
    const m = new FakePeer();
    const s = new FakePeer();
    room.handle(m, JSON.stringify({ type: 'join', role: 'main' }));
    expect(m.last()).toEqual({ type: 'joined', role: 'main', peerPresent: false });
    room.handle(s, { type: 'join', role: 'sub' });
    expect(s.last()).toEqual({ type: 'joined', role: 'sub', peerPresent: true });
    expect(m.last()).toEqual({ type: 'peer-joined' });
    room.handle(m, { type: 'offer', sdp: 'v=0...' });
    expect(s.last()).toEqual({ type: 'offer', sdp: 'v=0...' });
    room.handle(s, { type: 'answer', sdp: 'ans' });
    expect(m.last()).toEqual({ type: 'answer', sdp: 'ans' });
    room.handle(s, { type: 'ice', candidate: { candidate: 'c' } });
    expect(m.last()).toEqual({ type: 'ice', candidate: { candidate: 'c' } });
  });

  it('同じ役割の2台目は拒否する', () => {
    const room = new Room();
    const a = new FakePeer();
    const b = new FakePeer();
    room.handle(a, { type: 'join', role: 'main' });
    room.handle(b, { type: 'join', role: 'main' });
    expect(b.last()).toEqual({ type: 'error', reason: 'role-taken' });
    // 拒否された側は中継できない
    room.handle(b, { type: 'offer', sdp: 'x' });
    expect(b.last()).toEqual({ type: 'error', reason: 'not-joined' });
  });

  it('切断を検知したら、残った端末にpeer-leftを通知し、再参加できる', () => {
    const room = new Room();
    const m = new FakePeer();
    const s = new FakePeer();
    room.handle(m, { type: 'join', role: 'main' });
    room.handle(s, { type: 'join', role: 'sub' });
    room.leave(s);
    expect(m.last()).toEqual({ type: 'peer-left' });
    const s2 = new FakePeer();
    room.handle(s2, { type: 'join', role: 'sub' });
    expect(s2.last()).toEqual({ type: 'joined', role: 'sub', peerPresent: true });
    expect(m.last()).toEqual({ type: 'peer-joined' });
  });

  it('不正なメッセージ', () => {
    const room = new Room();
    const p = new FakePeer();
    room.handle(p, '{bad');
    expect(p.last()).toEqual({ type: 'error', reason: 'bad-json' });
    room.handle(p, { type: 'join', role: 'boss' });
    expect(p.last()).toEqual({ type: 'error', reason: 'bad-role' });
  });
});
