/**
 * 示例插件：把收到的每条消息写进插件自己的数据目录。
 *
 * 使用方法：
 *   1. 把本文件复制到 <工作目录>/plugins/ 下（文件名任意，扩展名 .mjs / .js）
 *   2. 重启实例。控制台的“关于 → 能力范围 → 插件机制”会显示已加载数量。
 *
 * 插件运行在框架进程内：拿到了 ctx 之后可以订阅事件、调用任意 OneBot 动作，
 * 也可以在 dataDir 里存放自己的状态。抛出的异常会被隔离，不会影响框架本身。
 */
export const version = '1.0.0';

export default function setup(ctx) {
  ctx.logger.info('demo', '示例插件已启动');

  ctx.onEvent((event) => {
    if (event.type !== 'message.private' && event.type !== 'message.group') return;
    ctx.logger.debug('demo', '收到 ' + event.type + ' · ' + event.summary);
  });

  // 演示动作调用：插件和机器人走完全相同的动作注册表。
  // 这里只在第一次事件到达时打一条日志，避免产生额外副作用。
  let answered = false;
  ctx.onEvent(async () => {
    if (answered) return;
    answered = true;
    try {
      const info = await ctx.call('get_version_info');
      ctx.logger.info('demo', '协议版本：' + info.data.protocol_version + '，实现：' + info.data.app_name);
    } catch (error) {
      ctx.logger.warn('demo', '动作调用失败：' + String(error));
    }
  });
}
