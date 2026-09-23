import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LarkChannel } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendFinalReply } from '../../../src/bot/channel';
import { initialState } from '../../../src/card/run-state';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('generated image final reply', () => {
  it('uploads a local image and delivers it together with the answer once', async () => {
    const path = await imageFixture();
    const sent: unknown[] = [];
    const upload = vi.fn(async () => ({ image_key: 'img_test' }));
    const channel = {
      rawClient: { im: { v1: { image: { create: upload } } } },
      send: vi.fn(async (_chatId: string, content: unknown) => {
        if ((content as { image?: { source?: unknown } }).image?.source === path) {
          throw new Error('local file source requires `outbound.allowedFileDirs` to be configured');
        }
        sent.push(content);
        return { messageId: 'om_test' };
      }),
    } as unknown as LarkChannel;

    await sendFinalReply({
      channel,
      chatId: 'chat',
      scope: 'scope',
      cwd: process.cwd(),
      state: {
        ...initialState,
        terminal: 'done',
        footer: null,
        blocks: [{ kind: 'text', content: '已生成图片。', streaming: false }],
        generatedImages: [path, path],
      },
      replyMode: 'markdown',
      sendOpts: { replyTo: 'om_request' },
      cardRenderOptions: {},
    });

    expect(upload).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0])).toContain('已生成图片。');
    expect(JSON.stringify(sent[0])).toContain('img_test');
    expect(JSON.stringify(sent[0])).not.toContain('上传到飞书失败');
  });

  it('reports an upload failure in the same answer only once', async () => {
    const first = await imageFixture();
    const second = await imageFixture();
    const sent: unknown[] = [];
    const upload = vi.fn(async () => { throw new Error('upload failed'); });
    const channel = {
      rawClient: { im: { v1: { image: { create: upload } } } },
      send: vi.fn(async (_chatId: string, content: unknown) => {
        if ((content as { image?: unknown }).image) throw new Error('upload failed');
        sent.push(content);
        return { messageId: 'om_test' };
      }),
    } as unknown as LarkChannel;

    await sendFinalReply({
      channel,
      chatId: 'chat',
      scope: 'scope',
      cwd: process.cwd(),
      state: {
        ...initialState,
        terminal: 'done',
        footer: null,
        blocks: [{ kind: 'text', content: '已生成图片。', streaming: false }],
        generatedImages: [first, second],
      },
      replyMode: 'markdown',
      sendOpts: { replyTo: 'om_request' },
      cardRenderOptions: {},
    });

    expect(upload).toHaveBeenCalledTimes(2);
    expect(sent).toHaveLength(1);
    const reply = JSON.stringify(sent[0]);
    expect(reply).toContain('已生成图片。');
    expect(reply.match(/图片上传到飞书失败/g)).toHaveLength(1);
  });
});

async function imageFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-final-image-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'generated.png');
  await writeFile(path, Buffer.from('89504e470d0a1a0a', 'hex'));
  return path;
}
