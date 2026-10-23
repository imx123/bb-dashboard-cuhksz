import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContext, Script } from 'node:vm';
import { classicDashboardHTML } from '../src/dashboard/classic-ui.js';

// 执行实际 renderer 程序；只替换宿主 DOM/IPC，不复制排序或缓存实现。
class Element {
  constructor(readonly tagName = 'div') {}
  children: Element[] = [];
  parentElement: Element | null = null;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  scrollLeft = 0;
  focused = false;
  onclick?: () => void;
  attributes = new Map<string, string>();
  listeners = new Map<string, Set<() => void>>();
  open = false;
  isConnected = true;
  alt = '';
  src = '';
  textContent = '';
  className = '';
  get firstChild() { return this.children[0]; }
  append(...children: Element[]) { for (const child of children) child.parentElement = this; this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = []; this.append(...children); }
  set innerHTML(value: string) {
    this.children = [...value.matchAll(/<img\b[^>]*src="([^"]+)"[^>]*>/g)].map(match => {
      const image = new Element('img');
      image.attributes.set('src', match[1]!);
      return image;
    });
  }
  getAttribute(key: string) { return this.attributes.get(key) ?? null; }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  removeAttribute(key: string) { this.attributes.delete(key); }
  querySelectorAll(selector: string): Element[] {
    const matches = (element: Element) => selector.startsWith('.') ? element.className.split(' ').includes(selector.slice(1)) : element.tagName === selector;
    return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  focus() { this.focused = true; }
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
  const elements = new Map(['course-filter', 'content', 'page-title', 'page-subtitle', 'stats', 'course-count', 'announcement-count', 'task-count', 'task-count-detail', 'coverage'].map(id => [id, new Element()]));
  const context = createContext({
    console: { info() {} },
    document: {
      createElement: (tag: string) => new Element(tag), getElementById: (id: string) => elements.get(id) ?? null,
      createTextNode: (text: string) => Object.assign(new Element('#text'), { textContent: text }),
      querySelectorAll: () => [],
    },
    window: { addEventListener() {}, cuhk: { readResource, debugEvent: async () => ({ ok: true }) } },
  });
  new Script(script.slice(0, startup)).runInContext(context);
  const run = <T = unknown>(code: string): T => new Script(code).runInContext(context) as T;
  run("state={source:'live',account:{profileId:'cuhksz',origin:'https://bb.cuhk.edu.cn',userId:'one',sessionGeneration:1},assignments:[],courses:[],displayWindowDays:7}");
  return { context, run, elements };
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

function textOf(element: Element): string { return [element.textContent, ...element.children.map(textOf)].join(' '); }

function coursesRenderer() {
  let requests = 0;
  const ui = renderer(async () => { requests++; throw new Error('Course filtering must not fetch'); });
  ui.run(`state={...state,state:'ok',fetchedAt:new Date().toISOString(),errors:[],coverage:[],
    courses:[{id:'_1_1',name:'Selected course',code:'AIE1000: Long course title'},{id:'_2_1',name:'Other course',code:'MAT1000：Long course title'}],
    assignments:['_1_1','_2_1'].map(courseId=>({id:courseId,courseId,title:courseId==='_1_1'?'Selected task':'Other task',dueAt:new Date(Date.now()+3600000).toISOString(),attachments:[]})),
    announcements:['_1_1','_2_1'].map(courseId=>({id:courseId,courseId,title:courseId==='_1_1'?'Selected announcement':'Other announcement',body:{text:'Synthetic',complete:true}})),
    files:['_1_1','_2_1'].map(courseId=>({id:courseId,courseId,name:courseId==='_1_1'?'Selected file':'Other file'}))};`);
  return { ...ui, requests: () => requests };
}

test('五个页面都可点击课程顶栏筛选，全部课程恢复列表，统计同步更新', () => {
  const { run, elements, requests } = coursesRenderer();
  const expected = { overview: 'Selected task', tasks: 'Selected task', courses: 'Selected course', announcements: 'Selected announcement', files: 'Selected file' };
  for (const [page, title] of Object.entries(expected)) {
    run(`page='${page}';courseFilter='';render()`);
    const host = elements.get('course-filter')!;
    assert.doesNotMatch(textOf(host), /Long course title|[:：]/);
    assert.equal(host.parentElement, page === 'overview' ? elements.get('content') : elements.get('content')!.children[0]);
    if (page !== 'overview') assert.equal(host.parentElement!.children[1], host);
    assert.equal(host.querySelectorAll('.course-filter-button').length, 3);
    host.querySelectorAll('.course-filter-button').find(button => button.dataset.courseId === '_1_1')!.onclick!();
    const selected = host.querySelectorAll('.course-filter-button').find(button => button.dataset.courseId === '_1_1')!;
    assert.equal(selected.getAttribute('aria-pressed'), 'true');
    assert.equal(selected.focused, true);
    assert.ok(textOf(elements.get('content')!).includes(title));
    assert.doesNotMatch(textOf(elements.get('content')!), /Other (task|course|announcement|file)/);
    assert.equal(String(elements.get('course-count')!.textContent), '1');
    assert.equal(String(elements.get('task-count')!.textContent), '1');
    assert.equal(String(elements.get('announcement-count')!.textContent), '1');
    host.querySelectorAll('.course-filter-button')[0]!.onclick!();
    assert.match(textOf(elements.get('content')!), /Other (task|course|announcement|file)/);
    assert.equal(String(elements.get('course-count')!.textContent), '2');
  }
  assert.equal(requests(), 0);
});

test('课程选择跨页面保留，与搜索/状态联合过滤，离线也能切换', () => {
  const { run, elements, requests } = coursesRenderer();
  run("courseFilter='_1_1';state.readOnly=true;state.offlineCache=true;navigate('files')");
  assert.equal(run('courseFilter'), '_1_1');
  assert.doesNotMatch(textOf(elements.get('content')!), /Other file/);
  run("navigate('tasks');query='Other';render()");
  assert.match(textOf(elements.get('content')!), /没有未完成作业/);
  run("query='';state.assignments[0].manualCompleted=true;taskStatus='completed';render()");
  assert.match(textOf(elements.get('content')!), /Selected task/);
  assert.doesNotMatch(textOf(elements.get('content')!), /Other task/);
  run('state.courses=state.courses.slice(1);render()');
  assert.equal(run('courseFilter'), '');
  assert.equal(requests(), 0);
});
