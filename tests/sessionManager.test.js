import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionManager, publicGuests, safeSend } from '../server/sessionManager.js';

class MockRedis {
  constructor() {
    this.store = new Map();
  }

  async set(key, value, ...args) {
    const isNx = args.includes('NX');
    if (isNx && this.store.has(key)) {
      return null;
    }
    this.store.set(key, value);
    return 'OK';
  }

  async get(key) {
    return this.store.get(key) || null;
  }

  async del(key) {
    const existed = this.store.has(key);
    this.store.delete(key);
    return existed ? 1 : 0;
  }

  async scan(cursor, ...args) {
    const keys = Array.from(this.store.keys());
    return ['0', keys];
  }
}

test('createSession generates unique session ID, hostToken, and default permissions', async () => {
  const redisClient = new MockRedis();
  const manager = createSessionManager({
    clientUrl: 'http://localhost:5173',
    redisClient,
    serverId: 'test-server-1'
  });

  const session = await manager.createSession({ hostName: 'Alice' });
  assert.ok(session.id, 'Session should have an ID');
  assert.equal(typeof session.id, 'string');
  assert.equal(session.id.length, 8, 'Session ID should be an 8-character hex string');
  assert.equal(session.hostName, 'Alice');
  assert.ok(session.hostToken, 'Session should have a hostToken');
  assert.equal(session.hostToken.length, 64, 'Host token should be 64-character hex string');
  assert.deepEqual(session.permissions, {
    canHighlight: true,
    canAnnotate: true,
    canScroll: true,
    canClick: false,
    canType: false,
    canNavigate: false
  });
});

test('getSession retrieves session and hydrates socket references', async () => {
  const redisClient = new MockRedis();
  const manager = createSessionManager({
    clientUrl: 'http://localhost:5173',
    redisClient,
    serverId: 'test-server-1'
  });

  const created = await manager.createSession({ hostName: 'Bob' });
  const fetched = await manager.getSession(created.id);

  assert.ok(fetched);
  assert.equal(fetched.id, created.id);
  assert.equal(fetched.hostName, 'Bob');
  assert.equal(fetched.hostSocket, null);
  assert.deepEqual(fetched.guests, []);
});

test('attachHost associates hostSocket with session', async () => {
  const redisClient = new MockRedis();
  const manager = createSessionManager({
    clientUrl: 'http://localhost:5173',
    redisClient,
    serverId: 'test-server-1'
  });

  const created = await manager.createSession({ hostName: 'Charlie' });
  const dummySocket = { id: 'sock-1' };
  const updated = await manager.attachHost(created.id, dummySocket);

  assert.ok(updated);
  assert.equal(updated.hostSocket, dummySocket);
});

test('addGuest and removeSocket manage participant lifecycle correctly', async () => {
  const redisClient = new MockRedis();
  const manager = createSessionManager({
    clientUrl: 'http://localhost:5173',
    redisClient,
    serverId: 'test-server-1'
  });

  const created = await manager.createSession({ hostName: 'Diana' });
  const hostMessages = [];
  const hostSocket = {
    id: 'host-sock-1',
    readyState: 1,
    send: (data) => hostMessages.push(JSON.parse(data))
  };
  await manager.attachHost(created.id, hostSocket);

  const guestSocket = { id: 'guest-sock-1', readyState: 1, send: () => {} };
  const joined = await manager.addGuest(created.id, guestSocket, { name: 'Eve' });

  assert.ok(joined);
  assert.equal(joined.guest.name, 'Eve');
  assert.equal(joined.session.guests.length, 1);
  assert.equal(joined.session.guests[0].socket, guestSocket);
  assert.ok(joined.guest.color.startsWith('#'), 'Guest should have a hex color assigned');

  await manager.removeSocket(guestSocket);
  const fetched = await manager.getSession(created.id);
  assert.ok(fetched);
  assert.equal(fetched.guests.length, 0);
  assert.equal(hostMessages.length, 1);
  assert.equal(hostMessages[0].event, 'session:guest-left');
  assert.equal(hostMessages[0].payload.guests.length, 0);
});

test('endSession removes session from storage', async () => {
  const redisClient = new MockRedis();
  const manager = createSessionManager({
    clientUrl: 'http://localhost:5173',
    redisClient,
    serverId: 'test-server-1'
  });

  const created = await manager.createSession({ hostName: 'Grace' });
  const existed = await manager.getSession(created.id);
  assert.ok(existed);

  const ended = await manager.endSession(created.id);
  assert.equal(ended, true);
  const afterClose = await manager.getSession(created.id);
  assert.equal(afterClose, null);
});

test('count returns total sessions in redis', async () => {
  const redisClient = new MockRedis();
  const manager = createSessionManager({
    clientUrl: 'http://localhost:5173',
    redisClient,
    serverId: 'test-server-1'
  });

  await manager.createSession({ hostName: 'Host1' });
  await manager.createSession({ hostName: 'Host2' });

  const total = await manager.count();
  assert.equal(total, 2);
});

test('publicGuests formats guest array safely', () => {
  const session = {
    guests: [
      { id: 'g1', name: 'Alice', color: '#ff0000', permissions: { canClick: true }, secret: 'hide-me' }
    ]
  };
  const publicList = publicGuests(session);
  assert.equal(publicList.length, 1);
  assert.deepEqual(publicList[0], {
    id: 'g1',
    name: 'Alice',
    color: '#ff0000',
    permissions: { canClick: true }
  });
  assert.equal(publicList[0].secret, undefined);
});

test('safeSend sends JSON message only when readyState is 1', () => {
  let sentData = null;
  const openSocket = {
    readyState: 1,
    send(data) {
      sentData = data;
    }
  };

  safeSend(openSocket, { test: 'hello' });
  assert.equal(sentData, '{"test":"hello"}');

  let closedSent = false;
  const closedSocket = {
    readyState: 3,
    send() {
      closedSent = true;
    }
  };
  safeSend(closedSocket, { test: 'world' });
  assert.equal(closedSent, false);
});
