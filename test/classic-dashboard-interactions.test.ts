import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext, Script } from 'node:vm';
import { classicDashboardHTML } from '../src/dashboard/classic-ui.js';

// 执行实际 renderer 程序；只替换宿主 DOM/IPC，不复制排序或缓存实现。
class Element {
  children: Element[] = [];
  attributes = new Map<string, string>();
  listeners = new Map<string, Set<() => void>>();
  open = false;
  isConnected = true;
  alt = '';
  src = '';
  textContent = '';
  className = '';
  append(...children: Element[]) { this.children.push(...children); }
  set innerHTML(value: string) {
    this.children = [...value.matchAll(/<img\b[^>]*src="([^"]+)"[^>]*>/g)].map(match => {
      const image = new Element();
      image.attributes.set('src', match[1]!);
      return image;
    });
  }
  getAttribute(key: string) { return this.attributes.get(key) ?? null; }
  removeAttribute(key: string) { this.attributes.delete(key); }
  querySelectorAll() { return this.children; }
  replaceWith() { this.isConnected = false; }
  addEventListener(name: string, listener: () => void) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(listener);
  }
  removeEventListener(name: string, listener: () => void) { this.listeners.get(name)?.delete(listener); }
  toggle() { this.open = !this.open; for (const listener of [...(this.listeners.get('toggle') ?? [])]) listener(); }
}

function renderer(readResource: (...args: unknown[]) => Promise<unknown> = async () => ({ ok: true, dataUrl: 'data:image/png;base64,AA==' })) {
  const script = /<script\b[^>]*>([\s\S]*?)<\/script>/.exec(classicDashboardHTML())![1]!;
  const startup = script.lastIndexOf("document.querySelectorAll('nav button')");
  assert.ok(startup > 0);
  const context = createContext({
    console: { info() {} },
    document: { createElement: () => new Element(), getElementById: () => null },
    window: { addEventListener() {}, cuhk: { readResource } },
  });
  new Script(script.slice(0, startup)).runInContext(context);
  const run = <T = unknown>(code: string): T => new Script(code).runInContext(context) as T;
  run("state={source:'live',account:{profileId:'cuhksz',origin:'https://bb.cuhk.edu.cn',userId:'one',sessionGeneration:1},assignments:[],courses:[],displayWindowDays:7}");
  return { context, run };
}

test('总览排序先显示临近截止作业，本机日期修改后重新排序', () => {
  const { run } = renderer();
  run(`state.assignments=Array.from({length:5},(_,i)=>({id:'later-'+i,courseId:'_1_1',title:'later',dueAt:new Date(Date.now()+6*86400000).toISOString()}));
    state.assignments.push({id:'urgent',courseId:'_2_1',title:'urgent',dueAt:new Date(Date.now()+3600000).toISOString()});`);
  assert.equal(run<string>('filteredTasks().slice(0,5)[0].id'), 'urgent');
  run("state.assignments[0].localDueAt=new Date(Date.now()+8*3600000-3600000).toISOString().slice(0,16)");
  assert.equal(run<string>('filteredTasks()[0].id'), 'later-0');
});

test('折叠公告不读取图片，展开及重绘复用已完成的图片请求', async () => {
  let calls = 0;
  const { run, context } = renderer(async () => { calls++; return { ok: true, dataUrl: 'data:image/png;base64,AA==' }; });
  const first = new Element();
  context.parent = first;
  run('var body={sanitizedHtml:\'<img src="lms-resource://resource/image-one">\',complete:true};appendRich(parent,body,true)');
  assert.equal(calls, 0);
  first.toggle();
  await run<Promise<unknown>>("readImage('image-one')");
  assert.equal(calls, 1);
  first.toggle(); first.toggle();
  context.parent = new Element();
  run('appendRich(parent,body,true);parent.toggle()');
  await run<Promise<unknown>>("readImage('image-one')");
  assert.equal(calls, 1);
});

test('并发读取合并，换账号后旧响应不进入新账号缓存', async () => {
  const finish: Array<(value: unknown) => void> = [];
  const { run } = renderer(() => new Promise(resolve => finish.push(resolve)));
  const first = run<Promise<unknown>>("readImage('same-resource')");
  assert.equal(run<Promise<unknown>>("readImage('same-resource')"), first);
  run("state.account.userId='two'");
  const second = run<Promise<unknown>>("readImage('same-resource')");
  assert.notEqual(first, second);
  finish[0]!({ ok: true, dataUrl: 'data:image/png;base64,OLD' });
  await first;
  assert.equal(run('mediaCache.size'), 0);
  assert.equal(run<Promise<unknown>>("readImage('same-resource')"), second);
  finish[1]!({ ok: true, dataUrl: 'data:image/png;base64,NEW' });
  await second;
  assert.equal(run("mediaCache.get('same-resource').dataUrl"), 'data:image/png;base64,NEW');
});

test('图片缓存有数量和体积上限，失败结果允许重试', async () => {
  let calls = 0;
  const { run } = renderer(async () => { calls++; return calls === 1 ? { ok: false } : { ok: true, dataUrl: 'data:image/png;base64,AA==' }; });
  await run<Promise<unknown>>("readImage('retry')");
  await run<Promise<unknown>>("readImage('retry')");
  assert.equal(calls, 2);
  for (let i = 0; i < 66; i++) await run<Promise<unknown>>(`readImage('image-${i}')`);
  assert.equal(run('mediaCache.size'), 64);
  assert.equal(run('mediaCacheChars<=MEDIA_CACHE_CHARS'), true);
  assert.equal(run("mediaCache.has('retry')"), false);
});

test('大图按缓存体积淘汰，单张超限图片不进入缓存', async () => {
  let dataUrl = 'data:image/png;base64,' + 'A'.repeat(17 * 1024 * 1024);
  const { run } = renderer(async () => ({ ok: true, dataUrl }));
  await run<Promise<unknown>>("readImage('large-one')");
  await run<Promise<unknown>>("readImage('large-two')");
  assert.equal(run('mediaCache.size'), 1);
  assert.equal(run("mediaCache.has('large-one')"), false);
  dataUrl = 'A'.repeat(33 * 1024 * 1024);
  await run<Promise<unknown>>("readImage('oversized')");
  assert.equal(run("mediaCache.has('oversized')"), false);
  assert.equal(run('mediaCacheChars<=MEDIA_CACHE_CHARS'), true);
});
