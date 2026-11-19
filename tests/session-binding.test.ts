import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeKernel } from '../runtime/bridge/native-kernel.cjs';

interface Socket {
  service: any;
  listener: any;
  id: string;
}

/** 模拟一个会话：getMsgService 返回的 service 对象可以在同一会话下被换掉。 */
function harness() {
  const sockets: Socket[] = [];
  const delivered: string[] = [];
  let current: any = null;
  let nextId = 1;
  const makeService = () => {
    const service: any = {
      added: 0,
      removed: [] as string[],
      addKernelMsgListener(listener: any) {
        this.added += 1;
        const id = 'L' + nextId++;
        sockets.push({ service: this, listener, id });
        return id;
      },
      removeKernelMsgListener(id: string) {
        this.removed.push(id);
      },
    };
    return service;
  };
  const session: any = {
    getMsgService: () => current,
    getBuddyService: () => ({ addKernelBuddyListener() {} }),
    getGroupService: () => ({ addKernelGroupListener() {} }),
    getProfileService: () => ({ getUserDetailInfoByUin: async () => ({}) }),
  };
  const kernel = new NativeKernel({ sessionProvider: () => session });
  kernel.emit = () => {};
  kernel.onNativeMessage = (message: any) => { delivered.push(String(message.msgId)); };
  kernel.uin = '10001';
  kernel.loginSucceeded = true;
  return {
    kernel,
    sockets,
    delivered,
    makeService,
    setService: (service: any) => { current = service; },
    socketFor: (service: any) => sockets.filter((s) => s.service === service).at(-1),
  };
}

test('同会话换新 service 对象：必须重绑，旧监听不投递、新监听只投递一次', () => {
  const h = harness();
  const first = h.makeService();
  h.setService(first);
  h.kernel.attachMessages();
  assert.equal(h.kernel.msgService, first);
  const firstSocket = h.socketFor(first)!;
  assert.ok(firstSocket);

  const second = h.makeService();
  h.setService(second);
  h.kernel.attachMessages();

  assert.equal(h.kernel.msgService, second, '同会话换对象必须重绑（M1）');
  assert.equal(second.added, 1, '新 service 必须装一次监听');

  firstSocket.listener.onRecvMsg([{ msgId: 'old-1' }]);
  assert.deepEqual(h.delivered, [], '旧监听必须被 active() 抑制');

  const secondSocket = h.socketFor(second)!;
  secondSocket.listener.onRecvMsg([{ msgId: 'new-1' }]);
  assert.deepEqual(h.delivered, ['new-1'], '同一条消息只能投递一次');
});

test('同一绑定重复 attach：不重复装监听、不重复投递', () => {
  const h = harness();
  const service = h.makeService();
  h.setService(service);
  h.kernel.attachMessages();
  h.kernel.attachMessages();
  h.kernel.attachMessages();
  assert.equal(service.added, 1, '绑定健康时不得重复 add');
  const socket = h.socketFor(service);
  assert.ok(socket);
  socket.listener.onRecvMsg([{ msgId: 'once-1' }]);
  socket.listener.onRecvMsg([{ msgId: 'once-1' }]);
  // 两条回调各投递一次（框架侧另有去重），但每个回调只投一次，不被重复代理。
  assert.deepEqual(h.delivered, ['once-1', 'once-1']);
});

test('服务对象消失再回来：重绑而不是复用旧监听', () => {
  const h = harness();
  const service = h.makeService();
  h.setService(service);
  h.kernel.attachMessages();
  assert.equal(service.added, 1);

  h.setService(null);
  h.kernel.attachMessages();
  assert.equal(h.kernel.msgService, null);
  assert.equal(h.kernel.status().messageReady, false, '服务消失后 messageReady 必须为 false');

  h.setService(service);
  h.kernel.attachMessages();
  assert.equal(service.added, 2, '服务回来必须重新装监听（M3）');
  assert.equal(h.kernel.status().messageReady, true);
});

test('stop 期间不建立绑定，start 后必然重绑一次', async () => {
  const h = harness();
  const service = h.makeService();
  h.setService(service);
  h.kernel.attachMessages();
  assert.equal(service.added, 1);

  await h.kernel.stop();
  h.kernel.attachMessages();
  assert.equal(h.kernel.msgService, null, 'stop 期间不得建立新绑定（M7）');

  await h.kernel.start(() => {});
  assert.equal(service.added, 2, 'start 后必须重绑');
});
