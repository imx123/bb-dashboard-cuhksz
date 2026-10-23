import { randomBytes } from 'node:crypto';

/** CUHK(SZ) Classic UI. Remote values enter the DOM through textContent or
 * server-sanitized rich HTML; all navigation and media reads use typed IPC. */
export function classicDashboardHTML() {
  const nonce = randomBytes(18).toString('base64');
  return String.raw`<!doctype html><html lang="zh-Hans"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:"><title>CUHK(SZ) · Blackboard Classic</title><style>
:root{--purple:#673a91;--ink:#292039;--muted:#827b8f;--border:#e7e2ec;--bg:#f8f6fa;--warn:#946f2e;--danger:#a95151}*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;background:var(--bg);color:var(--ink);font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}button,input,select{font:inherit}button{cursor:pointer}button:disabled{opacity:.5;cursor:wait}:focus-visible{outline:3px solid #b498d0;outline-offset:3px}.shell{display:grid;grid-template-columns:225px 1fr;min-height:100vh}.sidebar{padding:34px 20px;background:#fff;border-right:1px solid var(--border);display:flex;flex-direction:column;position:sticky;top:0;height:100vh}.brand{display:flex;gap:12px;align-items:center;padding:0 10px}.mark{height:43px;width:43px;display:grid;place-items:center;background:var(--purple);color:#fff;border-radius:13px;font-family:Georgia,serif;font-size:22px}.brand b{font-size:16px;letter-spacing:.4px}.brand small{display:block;color:var(--muted);font-size:11px;margin-top:4px}.nav-label{font-size:10px;letter-spacing:2px;color:#a29aaf;margin:48px 14px 14px}nav{display:grid;gap:7px}nav button{border:0;background:transparent;text-align:left;padding:12px 15px;border-radius:10px;color:#83778f;font-weight:500;display:flex;gap:13px;align-items:center}nav button.active{color:var(--purple);background:#eee7f6}nav .symbol{font-size:17px;width:18px;text-align:center}.sidebar-bottom{margin-top:auto;padding:20px 12px 0}.online{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted);margin-bottom:14px}.dot{width:7px;height:7px;background:#b8adbf;border-radius:50%}.dot.good{background:#54a283}.plain{background:white;border:1px solid var(--border);padding:9px 14px;border-radius:9px;color:var(--ink)}.sidebar-bottom button{width:100%;margin-top:7px}.sidebar-bottom small{display:block;color:var(--muted);font-size:10px;line-height:1.8;margin-top:15px;user-select:text;overflow-wrap:anywhere}main{max-width:1400px;width:100%;padding:35px 42px 28px;margin:auto}header{display:flex;justify-content:space-between;align-items:center;gap:20px;border-bottom:1px solid var(--border);padding-bottom:24px}.eyebrow{color:var(--muted);font-size:10px;letter-spacing:1.8px}header p{color:var(--muted);font-size:12px;margin:8px 0 0}.toolbar{display:flex;align-items:center;gap:10px}select{border:1px solid var(--border);background:white;border-radius:9px;padding:10px;color:var(--ink)}.primary{border:0;background:var(--purple);color:#fff;border-radius:9px;padding:11px 17px;font-weight:500}.intro{display:flex;justify-content:space-between;align-items:center;margin:32px 0 25px}.intro h1{font-size:30px;letter-spacing:-.8px;font-weight:650;margin:0 0 10px}.intro p{color:var(--muted);margin:0;font-size:13px}.date{font-size:12px;color:var(--muted)}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:27px}.stat{background:#fff;border:1px solid var(--border);border-radius:14px;padding:22px;display:flex;justify-content:space-between;align-items:center}.stat small{font-size:12px;color:var(--muted)}.stat strong{display:block;font-size:31px;font-weight:600;margin-top:10px}.stat-icon{font-size:22px;background:#eee7f6;color:var(--purple);width:48px;height:48px;display:grid;place-items:center;border-radius:14px}.stat:nth-child(2) .stat-icon{background:#fcf0df;color:#b9853b}.stat:nth-child(3) .stat-icon{background:#e5f0eb;color:#518d70}.layout{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);gap:22px}.panel{background:#fff;border:1px solid var(--border);border-radius:15px;padding:23px;min-width:0;margin-bottom:23px}.panel-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px;gap:12px}.panel h2{font-size:17px;font-weight:600;margin:0}.small{font-size:11px;color:var(--muted)}.text-button{border:0;background:transparent;color:var(--purple);font-size:12px;padding:4px}.task{display:grid;grid-template-columns:44px 1fr auto;gap:14px;padding:17px 0;border-top:1px solid #f0edf3;align-items:start}.day{border-radius:10px;background:#f3edf8;color:var(--purple);padding:7px 3px;text-align:center}.day strong{display:block;font-size:18px;font-weight:600}.day span{font-size:9px}.task-name{border:0;background:none;padding:0;text-align:left;font-weight:550;color:var(--ink);line-height:1.5}.task-course{font-size:11px;color:var(--muted);margin:5px 0;line-height:1.5}.badge{font-size:10px;border-radius:5px;padding:4px 7px;background:#f2eef6;color:#7e6c91;white-space:nowrap;display:inline-block}.badge.urgent{background:#fff1dc;color:#ae7729}.badge.completed{background:#e5f0eb;color:#347653}.badge.overdue{background:#fbe8e8;color:#bb5d5d}.badge.offline{background:#fff4e0;color:#946f2e}.badge.partial{background:#fff4e0;color:#946f2e}.sources{font-size:10px;color:#a097ab;margin-top:5px;line-height:1.7}.completion-control{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--muted);margin-top:9px;cursor:pointer}.completion-control input{accent-color:var(--purple);cursor:pointer}.task-right{text-align:right;min-width:130px}.task-right .time{display:block;font-size:11px;margin-top:6px;color:var(--muted)}.task-actions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;margin-top:8px}.course-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.course-card{border:1px solid var(--border);border-radius:12px;padding:18px;min-width:0;border-top:3px solid #b7a2ce;background:linear-gradient(120deg,#f9f6fc,#fff)}.course-card:nth-child(3n+2){border-top-color:#d8b46d;background:linear-gradient(120deg,#fffaf0,#fff)}.course-card:nth-child(3n){border-top-color:#88b9ad;background:linear-gradient(120deg,#f1f8f5,#fff)}.course-code{font-size:10px;letter-spacing:.7px;color:var(--purple);font-weight:600;margin-bottom:11px;overflow-wrap:anywhere}.course-card h3{font-size:13px;line-height:1.6;margin:0 0 12px;font-weight:550;min-height:40px}.course-bottom{display:flex;justify-content:space-between;align-items:center;gap:7px}.course-actions{display:flex;gap:8px}.course-actions button{font-size:11px;border:0;color:var(--purple);background:none;padding:6px 0}.announcement{border-top:1px solid #f0edf3;padding:16px 0}.announcement summary{cursor:pointer;list-style:none;font-size:13px;line-height:1.6;font-weight:550}.announcement summary::-webkit-details-marker{display:none}.announcement summary:before{content:'›';display:inline-block;color:#ad99c0;margin-right:9px}.announcement[open] summary:before{transform:rotate(90deg)}.announcement-meta{font-size:10px;color:var(--muted);line-height:1.7;margin:7px 0 0 16px}.announcement-body{font-size:12px;line-height:1.8;overflow-wrap:anywhere;color:#665e71;padding:12px 16px;margin:0}.empty{color:var(--muted);font-size:13px;padding:30px 0;line-height:1.9}.search{width:240px;border:1px solid var(--border);border-radius:8px;padding:9px 12px;background:#faf9fc}.notice{background:#fff4e0;border:1px solid #eddab1;color:#946f2e;padding:13px 17px;border-radius:10px;font-size:12px;line-height:1.8;margin-bottom:20px}.notice.danger{background:#fbe8e8;border-color:#edc3c3;color:var(--danger)}.footnote{color:#9991a4;font-size:10px;line-height:1.8;margin:0}.file{display:flex;justify-content:space-between;gap:12px;align-items:center;border-top:1px solid #f0edf3;padding:13px 0}.file-name{font-weight:550;overflow-wrap:anywhere}.file-meta{font-size:10px;color:var(--muted);margin-top:4px}.rich-body{font-size:12px;line-height:1.8;overflow-wrap:anywhere}.rich-body img{display:block;max-width:100%;max-height:360px;margin:10px 0;border-radius:8px;background:#f4f0f7}.rich-body a{color:var(--purple)}.rich-body pre{white-space:pre-wrap}.rich-links{display:grid;gap:5px;margin-top:9px}.rich-link{color:var(--muted);font-size:11px}.media-failed{display:inline-block;padding:8px;border:1px dashed #d4c8dc;color:var(--muted);font-size:11px}.error-list{color:var(--danger);font-size:11px;line-height:1.7;margin:0;padding-left:18px}.coverage-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:12px}.coverage-item{border:1px solid var(--border);border-radius:8px;padding:8px;font-size:10px;color:var(--muted)}dialog{width:min(900px,90vw);max-height:85vh;border:1px solid var(--border);border-radius:16px;padding:26px;color:var(--ink)}dialog::backdrop{background:#241b3b66}dialog .dialog-body{max-height:68vh;overflow:auto}.dialog-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:20px}dialog table{border-collapse:collapse;width:100%;font-size:12px}dialog td,dialog th{border-bottom:1px solid var(--border);padding:10px;text-align:left;overflow-wrap:anywhere}.spinner{display:inline-block;width:13px;height:13px;border:2px solid #d7c8e3;border-top-color:var(--purple);border-radius:50%;animation:spin .8s linear infinite;margin-right:7px;vertical-align:middle}@keyframes spin{to{transform:rotate(360deg)}}@media(max-width:1050px){main{padding:25px}.shell{grid-template-columns:190px 1fr}.layout{grid-template-columns:1fr}.sidebar{padding:30px 14px}.date{display:none}}@media(max-width:820px){.stats{gap:10px}.stat{padding:16px}.stat-icon{display:none}.search{width:180px}.course-grid{grid-template-columns:1fr}.task{grid-template-columns:36px 1fr}.task-right{grid-column:2;text-align:left}}.stat-detail{display:block;color:var(--muted);font-size:11px;line-height:1.5;margin-top:4px}.course-identity{display:inline-block;max-width:100%;padding:4px 8px;border-radius:6px;background:#eee7f6;color:var(--purple);font-size:11px;font-weight:600;line-height:1.4;overflow-wrap:anywhere}.detail-course{margin:0 0 8px}.announcement summary{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.announcement-course{margin:0}.panel-filters{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap}.panel-filters select{padding:9px 10px;font-size:12px;max-width:230px}.task-right .badge{margin-left:4px}.badge.local{background:#e5f0eb;color:#347653}
</style></head><body><div class="shell"><aside class="sidebar"><div class="brand"><span class="mark">C</span><div><b>CUHK(SZ)</b><small>Blackboard Classic</small></div></div><p class="nav-label">MY WORKSPACE</p><nav aria-label="主导航"><button data-page="overview" class="active"><span class="symbol">▦</span>学习总览</button><button data-page="tasks"><span class="symbol">◷</span>作业与 DDL</button><button data-page="courses"><span class="symbol">▤</span>我的课程</button><button data-page="announcements"><span class="symbol">♧</span>课程公告</button><button data-page="files"><span class="symbol">⌁</span>课程资料</button></nav><div class="sidebar-bottom"><div class="online"><span class="dot" id="connection-dot"></span><span id="connection">正在检查已保存的会话</span></div><button class="plain" id="login">登录 / 重新授权</button><button class="text-button" id="cancel" hidden>取消当前读取</button><button class="text-button" id="open-diagnostics">打开诊断日志目录</button><button class="text-button" id="copy-diagnostics">复制日志位置</button><small id="diagnostic-location">诊断日志位置：读取中…</small><small id="diagnostic-recent">最近操作：—</small><small>只读 Blackboard Classic<br>登录与 MFA 由你在本机完成<br>仅检测到密码或 MFA 挑战时显示官方登录窗口</small></div></aside><main><header><div><span class="eyebrow">BLACKBOARD CLASSIC / CUHK(SZ)</span><p id="updated" role="status" aria-live="polite">正在检查已保存的 Blackboard 会话…</p></div><div class="toolbar"><select id="days" aria-label="显示范围"><option value="7">未来 7 天</option><option value="14">未来 14 天</option><option value="30">未来 30 天</option></select><button id="refresh" class="primary">↻ 刷新数据</button></div></header><div class="intro"><div><h1 id="page-title">学习总览</h1><p id="page-subtitle">课程、公告、作业和资料，都在这里。</p></div><span class="date" id="today"></span></div><div class="notice" id="notice" role="alert" hidden></div><div id="stats" class="stats"><div class="stat"><div><small>可见课程</small><strong id="course-count">—</strong></div><span class="stat-icon">▤</span></div><div class="stat"><div><small>窗口内作业</small><strong id="task-count">—</strong></div><span class="stat-icon">◷</span></div><div class="stat"><div><small>已读取公告</small><strong id="announcement-count">—</strong></div><span class="stat-icon">♧</span></div></div><div id="content"></div><p class="footnote" id="coverage">时间以 Asia/Shanghai（UTC+8）显示。来源链接由主进程按已读取业务 ID 校验；真实学校页面仍需你本机验收。</p></main></div><dialog id="detail-dialog"><div class="panel-head"><h2 id="detail-title">作业详情</h2><button class="plain" id="detail-close">关闭</button></div><div class="dialog-body" id="detail-content"></div></dialog><script nonce="${nonce}">
'use strict';console.info('CUHK_DASHBOARD_SCRIPT_START');
const $=id=>document.getElementById(id);let state=null,page='overview',busy=false,query='',courseFilter='',taskStatus='pending',loginAction='begin',lastTraceId='',lastErrorCode='',diagnosticPath='',detailToken=0,activeDetailToken=0,restoreToken=0,refreshToken=0,bridgeUnavailableReported=false;
const titles={overview:['学习总览','课程、公告、作业和资料，都在这里。'],tasks:['作业与 DDL','按完成状态、课程和名称查找，日期待确认的项目会单独显示。'],courses:['我的课程','来源页面在当前 Blackboard 会话分区中打开。'],announcements:['课程公告','按课程或名称查找，展开公告查看已清洗的正文和媒体。'],files:['课程资料','资料来源需从当前快照中的业务 ID 打开。']};
function node(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n}
function dateTime(value,options){if(!value)return '—';const parsed=Date.parse(value);return Number.isFinite(parsed)?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',...options}).format(new Date(parsed)):'日期待确认'}
function dateOnly(value){return value?value.replace(/-/g,'/').slice(5):'—'}
function message(text,danger){const box=$('notice');box.hidden=!text;box.className='notice'+(danger?' danger':'');box.style.overflowWrap='anywhere';box.textContent=text||''}
function bridgeCall(name,...args){const bridge=window.cuhk,method=bridge?.[name];if(typeof method!=='function'){if(!bridgeUnavailableReported){bridgeUnavailableReported=true;try{console.info('CUHK_DASHBOARD_BRIDGE_UNAVAILABLE')}catch{}}message('Dashboard 主进程桥接未就绪，请重新打开。',true);return Promise.resolve({ok:false,error:{code:'BRIDGE_UNAVAILABLE'}})}try{return Promise.resolve(method(...args))}catch{return Promise.resolve({ok:false,error:{code:'BRIDGE_UNAVAILABLE'}})}}
function updateDiagnosticLocation(result){const diagnostics=result?.diagnostics;if(!diagnostics)return;if(diagnostics.path)diagnosticPath=diagnostics.path;const location=$('diagnostic-location');if(location&&diagnosticPath){const status=diagnostics.healthy===false?'（日志写入失败）':diagnostics.writerReady===false?'（日志目录尚未就绪）':'（已写入 '+(Number.isInteger(diagnostics.writeCount)?diagnostics.writeCount:0)+' 条）';location.textContent='诊断日志位置：'+diagnosticPath+status}}
function updateRecentBusiness(result){const diagnostics=result?.diagnostics;if(!diagnostics)return;if(diagnostics.traceId)lastTraceId=diagnostics.traceId;if(result?.error||Array.isArray(result?.errors)){const error=result?.error||result.errors.find(item=>item?.code);lastErrorCode=error?.code||''}else lastErrorCode='';const recent=$('diagnostic-recent');if(recent)recent.textContent='最近操作 traceId：'+(lastTraceId||'—')+(lastErrorCode?' · 错误码：'+lastErrorCode:'')}
function recordBusinessDiagnostics(result){updateDiagnosticLocation(result);updateRecentBusiness(result);const authError=result?.error||(Array.isArray(result?.errors)?result.errors.find(error=>isAuthError(error)):null);if(isAuthError(authError)&&!state?.offlineCache)clearUiAccountState()}
function debugEvent(name,details={}){return bridgeCall('debugEvent',name,details).then(updateDiagnosticLocation).catch(()=>undefined)}
function installRendererDiagnostics(){window.addEventListener('error',event=>{void debugEvent('renderer.error',{errorType:event.error?.name,line:event.lineno,column:event.colno,sourceUrl:event.filename})});window.addEventListener('unhandledrejection',event=>{void debugEvent('renderer.unhandledrejection',{errorType:event.reason?.name})})}
installRendererDiagnostics();
function errorLabel(error,fallback){if(!error)return fallback;const map={AUTH_REQUIRED:'需要完成 Blackboard 登录。',SESSION_EXPIRED:'Blackboard 会话已过期，请重新授权。',TIMEOUT:'读取超时或已取消。',FORBIDDEN:'Blackboard 拒绝了该范围的读取。',NOT_FOUND:'学校没有找到该业务资源。',API_SCHEMA_CHANGED:'学校返回结构需要重新核对。',NETWORK:'网络读取失败。',URL_REJECTED:'来源链接未通过学校范围校验。',BAD_INPUT:'请求参数无效。',RESOURCE_FAILED:'媒体读取失败。',CACHE_FALLBACK:'本机标记暂不可用。',LOCAL_READ_FAILED:'本机状态无法读取，原文件已保留。',LOCAL_WRITE_FAILED:'本机状态无法保存，原文件已保留。',BRIDGE_UNAVAILABLE:'Dashboard 主进程桥接未就绪，请重新打开。'};return (map[error.code]||fallback)+(error.code?'（'+error.code+(error.scope?' · '+error.scope:'')+'）':'')}
function cacheFailureText(value){if(!value||typeof value!=='object')return'';const input=value;const code=typeof input.code==='string'?input.code.slice(0,80):'CACHE_FALLBACK';const scope=typeof input.scope==='string'?input.scope.slice(0,120):'cache-v2.read';return' 上次缓存读取失败，原文件已保留（'+code+' · '+scope+'）。'}
function offlineReasonText(reason){return reason==='network-unverified'?'当前网络暂未验证 Blackboard 会话':reason==='verification-failed'?'Blackboard 会话验证未完成':'未找到有效 Blackboard 会话'}
function errorGroups(errors){const groups=new Map();for(const error of Array.isArray(errors)?errors:[]){const code=typeof error?.code==='string'&&error.code.trim()?error.code.trim():'ERROR',scope=typeof error?.scope==='string'&&error.scope.trim()?error.scope.trim():'unknown',message=typeof error?.message==='string'&&error.message.trim()?error.message.trim():'读取未完成',key=JSON.stringify([code,scope,message]);const group=groups.get(key);if(group)group.count+=1;else groups.set(key,{code,scope,message,count:1})}return [...groups.values()]}
function errorGroupText(group){return group.code+' · '+group.scope+' · '+group.message+(group.count>1?' ×'+group.count:'')}
function errorSummary(errors){const groups=errorGroups(errors),visible=groups.slice(0,4).map(errorGroupText),remaining=groups.length-visible.length;return visible.join('；')+(remaining?'；另有 '+remaining+' 类错误，请查看下方“覆盖与读取状态”。':'')}
function isAuthError(error){const code=error?.code||error?.error?.code;return code==='AUTH_REQUIRED'||code==='SESSION_EXPIRED'}
function clearUiAccountState(){state=null;resetMediaCache();courseFilter='';activeDetailToken=++detailToken;if($('detail-dialog').open)$('detail-dialog').close();render();$('connection').textContent='等待手动连接';$('connection-dot').className='dot'}
function empty(parent,text){parent.append(node('p',text,'empty'))}
function panel(title,more){const p=node('section',undefined,'panel'),head=node('div',undefined,'panel-head');head.append(node('h2',title));if(more){const b=node('button','查看全部 →','text-button');b.onclick=()=>navigate(more);head.append(b)}p.append(head);return p}
function courseRecord(id){return (state?.courses||[]).find(c=>c.id===id)||null}
function courseName(id){return courseRecord(id)?.name||id||'课程待确认'}
function courseLabel(id){const course=courseRecord(id);if(!course)return id||'课程待确认';return course.code?course.code+' · '+course.name:course.name}
function courseMatches(id){return !courseFilter||id===courseFilter}
function openSource(kind,id,courseId){if(state?.readOnly){message('当前显示的是本机缓存，只读模式不会打开学校来源页面。',true);return}if(!id){message('该项目没有可验证的业务 ID。',true);return}const target={kind,id,...(kind==='course'?{}:{courseId})};bridgeCall('openSource',target).then(result=>{recordBusinessDiagnostics(result);if(!result?.ok)message(errorLabel(result?.error,'无法打开 Blackboard 来源页面。'),true)}).catch(()=>message('无法打开 Blackboard 来源页面。',true))}
function localTimestamp(value){if(!value)return null;const parsed=Date.parse(value.length===10?value+'T00:00:00+08:00':value+':00+08:00');return Number.isFinite(parsed)?parsed:null}
function taskTimestamp(task){const local=localTimestamp(task.localDueAt);if(local!==null)return local;if(task.dueAt){const value=Date.parse(task.dueAt);return Number.isFinite(value)?value:null}if(task.dueDateOnly){const value=Date.parse(task.dueDateOnly+'T00:00:00+08:00');return Number.isFinite(value)?value:null}return null}
function schoolDue(task){let base;if(task.dueAt)base=dateTime(task.dueAt,{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false})+(task.dueEvidence==='unknown'?' · 证据待确认':'');else if(task.dueDateOnly)base=dateOnly(task.dueDateOnly)+' · 仅日期';else base='截止日期未提供';if(task.standardDueAt&&task.personalDueAt&&task.standardDueAt!==task.personalDueAt)base+=' · 学校 '+dateTime(task.standardDueAt,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false})+' · 个人 '+dateTime(task.personalDueAt,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false})+(task.personalDueState==='unverified'?'（未核实）':'');if(task.dueConflict)base+=' · 时间冲突';return base}
function taskDue(task){const local=task.localDueAt?('本机备忘：'+(task.localDueAt.length===10?dateOnly(task.localDueAt)+' · 仅日期':dateTime(task.localDueAt+':00+08:00',{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}))):'';return local?(local+' · 学校：'+schoolDue(task)):schoolDue(task)}
function shanghaiDayNumber(value){const parts=new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(value));const year=Number(parts.find(part=>part.type==='year')?.value),month=Number(parts.find(part=>part.type==='month')?.value),day=Number(parts.find(part=>part.type==='day')?.value);return Date.UTC(year,month-1,day)/86400000}
function inDisplayWindow(task){const dateOnlyValue=task.localDueAt?.length===10?task.localDueAt:(!task.localDueAt?task.dueDateOnly:null);if(dateOnlyValue){const target=Date.parse(dateOnlyValue+'T00:00:00+08:00');if(!Number.isFinite(target))return true;const age=Date.UTC(Number(dateOnlyValue.slice(0,4)),Number(dateOnlyValue.slice(5,7))-1,Number(dateOnlyValue.slice(8,10)))/86400000-shanghaiDayNumber(Date.now());return age>=-30&&age<=Number(state?.displayWindowDays||30)}const timestamp=taskTimestamp(task);if(timestamp===null)return true;const age=timestamp-Date.now();return age>=-30*86400000&&age<=Number(state?.displayWindowDays||30)*86400000}
function taskDay(task){if(task.localDueAt){const local=task.localDueAt.length===10?task.localDueAt+'T23:59:00+08:00':task.localDueAt+':00+08:00';return [dateTime(local,{day:'2-digit'}),task.localDueAt.length===10?'仅日期':dateTime(local,{month:'short'})]}if(task.dueAt)return [dateTime(task.dueAt,{day:'2-digit'}),dateTime(task.dueAt,{month:'short'})];if(task.dueDateOnly)return [dateOnly(task.dueDateOnly).slice(3),'仅日期'];return ['?','待确认']}
function isRemoteCompleted(task){const s=task.submission||{};return s.remoteSubmission==='submitted'&&(s.evidence==='receipt'||s.evidence==='attempt-status')}
function isTaskCompleted(task){return isRemoteCompleted(task)||task.manualCompleted===true}
function taskStatusMatches(task,filter=taskStatus){return filter==='all'||(filter==='completed'?isTaskCompleted(task):!isTaskCompleted(task))}
function taskSearchText(task){return (task.title+' '+courseLabel(task.courseId)).toLowerCase()}
function filteredTasks(status=taskStatus){const needle=query.toLowerCase();return (state?.assignments||[]).filter(inDisplayWindow).filter(task=>courseMatches(task.courseId)).filter(task=>taskStatusMatches(task,status)).filter(task=>!needle||taskSearchText(task).includes(needle)).sort((left,right)=>(taskTimestamp(left)??Infinity)-(taskTimestamp(right)??Infinity)||left.courseId.localeCompare(right.courseId)||left.id.localeCompare(right.id))}
function submissionText(task){const s=task.submission||{};const parts=[];if(isRemoteCompleted(task))parts.push('学校已提交');else if(s.remoteSubmission==='not-submitted')parts.push('学校未提交');else parts.push('提交状态未确认');if(s.latestAttemptState&&s.latestAttemptState!=='unknown')parts.push('尝试：'+s.latestAttemptState);if(s.attemptCount!==null&&s.attemptCount!==undefined)parts.push('历史 '+s.attemptCount+' 次'+(s.historyComplete?'':'（未完整）'));if(s.submittedAt)parts.push('提交于 '+dateTime(s.submittedAt,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}));return parts.join(' · ')}
// 图片只在当前账号及会话代次内复用；限制缓存体积，避免长时间使用积累大图。
const mediaCache=new Map(),mediaFlights=new Map(),MEDIA_CACHE_CHARS=32*1024*1024;
let mediaScope='',mediaEpoch=0,mediaCacheChars=0;
function resetMediaCache(){mediaCache.clear();mediaFlights.clear();mediaCacheChars=0;mediaScope='';mediaEpoch++}
function syncMediaScope(){const account=state?.account,key=JSON.stringify([state?.source,account?.profileId,account?.origin,account?.userId,account?.sessionGeneration,Boolean(state?.readOnly)]);if(key!==mediaScope){resetMediaCache();mediaScope=key}}
function readImage(resourceId){
  syncMediaScope();
  const cached=mediaCache.get(resourceId);
  if(cached){mediaCache.delete(resourceId);mediaCache.set(resourceId,cached);return Promise.resolve(cached)}
  if(mediaFlights.has(resourceId))return mediaFlights.get(resourceId);
  const epoch=mediaEpoch;
  const pending=bridgeCall('readResource',resourceId,'image').then(result=>{
    if(epoch===mediaEpoch&&result?.ok&&typeof result.dataUrl==='string'&&result.dataUrl.length<=MEDIA_CACHE_CHARS){
      mediaCache.set(resourceId,result);mediaCacheChars+=result.dataUrl.length;
      while(mediaCache.size>64||mediaCacheChars>MEDIA_CACHE_CHARS){const oldest=mediaCache.keys().next().value,entry=mediaCache.get(oldest);mediaCache.delete(oldest);mediaCacheChars-=entry.dataUrl.length}
    }
    return result;
  }).finally(()=>{if(mediaFlights.get(resourceId)===pending)mediaFlights.delete(resourceId)});
  mediaFlights.set(resourceId,pending);
  return pending;
}
function appendRich(parent,body,lazy=false){
  if(!body)return;
  const wrap=node('div',undefined,'rich-body');
  if(body.sanitizedHtml){
    wrap.innerHTML=body.sanitizedHtml;
    const reads=[];
    for(const image of wrap.querySelectorAll('img')){
      const source=image.getAttribute('src')||'',match=/^lms-resource:\/\/resource\/(.+)$/.exec(source);
      image.removeAttribute('src');
      if(!match){image.replaceWith(node('span','媒体来源未通过校验','media-failed'));continue}
      if(state?.readOnly){image.replaceWith(node('span','离线缓存未读取媒体','media-failed'));continue}
      let resourceId;try{resourceId=decodeURIComponent(match[1])}catch{resourceId=''}
      image.alt=image.alt||'媒体加载中';
      reads.push(()=>{
        syncMediaScope();const snapshot=state,epoch=mediaEpoch;
        readImage(resourceId).then(result=>{
          if(!image.isConnected||state!==snapshot||epoch!==mediaEpoch)return;
          recordBusinessDiagnostics(result);
          if(result?.ok&&result.dataUrl){image.src=result.dataUrl;if(image.alt==='媒体加载中')image.alt='Blackboard 图片'}
          else image.replaceWith(node('span','媒体未能读取（'+(result?.error?.code||'RESOURCE_FAILED')+'）','media-failed'));
        }).catch(()=>{if(image.isConnected&&state===snapshot&&epoch===mediaEpoch)image.replaceWith(node('span','媒体未能读取','media-failed'))});
      });
    }
    parent.append(wrap);
    let started=false;
    const start=()=>{if(started||(lazy&&!parent.open))return;started=true;parent.removeEventListener('toggle',start);for(const read of reads)read()};
    if(lazy)parent.addEventListener('toggle',start);
    start();
  }else parent.append(node('pre',body.text||'暂无正文。','rich-body'));
  if(body.links?.length){const links=node('div',undefined,'rich-links');for(const link of body.links)links.append(node('span','链接：'+link.label,'rich-link'));parent.append(links)}
  if(body.complete!==true)parent.append(node('span','正文或附件读取不完整','badge partial'));
}
function taskDetailButton(task){const b=node('button',state?.readOnly?'查看缓存详情':'读取详情','text-button');b.disabled=busy;b.onclick=()=>showDetail(task);return b}
function taskStatusText(status){return status==='completed'?'已完成':status==='all'?'全部':'未完成'}
function renderTasks(parent,limit,statusOverride=null){
  const activeStatus=statusOverride||taskStatus;
  const tasks=filteredTasks(activeStatus);
  if(!tasks.length){
    const emptyText=!state?'登录后刷新查看作业与 DDL。':activeStatus==='pending'?'当前筛选没有未完成作业；可切换“已完成”或“全部”。':activeStatus==='completed'?'当前筛选没有已完成作业；可切换“未完成”或“全部”。':'当前显示范围没有作业；日期未提供的项目会单独显示。';
    empty(parent,emptyText);
    return;
  }
  const withDate=tasks.filter(t=>t.localDueAt||t.dueAt||t.dueDateOnly),withoutDate=tasks.filter(t=>!t.localDueAt&&!t.dueAt&&!t.dueDateOnly);
  const groups=[withDate.slice(0,limit||withDate.length),withoutDate];
  for(const group of groups){
    if(!group.length)continue;
    if(group===withoutDate)parent.append(node('h3','日期待确认','small'));
    for(const task of group){
      const row=node('div',undefined,'task'),day=node('div',undefined,'day'),parts=taskDay(task);
      day.append(node('strong',parts[0]),node('span',parts[1]));
      const body=node('div'),title=node('button',task.title,'task-name');
      title.disabled=Boolean(state?.readOnly)||!task.id;
      title.onclick=()=>openSource('assignment',task.id,task.courseId);
      body.append(title,node('p',courseLabel(task.courseId),'task-course course-identity'),node('div',taskDue(task),'sources'),node('div',submissionText(task),'sources'));
      if(task.summary)body.append(node('div',task.summary,'sources'));
      const detailActions=node('div',undefined,'task-actions');
      detailActions.append(taskDetailButton(task));
      for(const attachment of task.attachments||[]){const link=node('button','附件：'+attachment.name,'text-button');link.disabled=Boolean(state?.readOnly)||!attachment.id;link.onclick=()=>openSource('attachment',attachment.id,task.courseId);detailActions.append(link)}
      body.append(detailActions);
      const right=node('div',undefined,'task-right'),manualCompleted=task.manualCompleted===true,remoteCompleted=isRemoteCompleted(task),timestamp=taskTimestamp(task);
      if(remoteCompleted){right.append(node('span','✓ 已完成 · 已提交','badge completed'));if(manualCompleted)right.append(node('span','本机也已勾选','badge local'))}
      else if(manualCompleted)right.append(node('span','✓ 已完成 · 本机','badge completed'));
      else {const label=task.dueAt&&timestamp!==null&&timestamp<Date.now()?'已过截止时间':task.dueAt&&timestamp!==null&&timestamp-Date.now()<72*3600000?'即将截止':'待确认';right.append(node('span',label,'badge '+(label==='即将截止'?'urgent':label==='已过截止时间'?'overdue':'')))}
      const checkLabel=node('label',undefined,'completion-control'),check=node('input');check.type='checkbox';check.checked=manualCompleted;check.disabled=Boolean(state?.readOnly)||busy||!task.manualAvailable;check.setAttribute('aria-label','本机完成 '+task.title);check.onchange=()=>setCompletion(task,check.checked);checkLabel.append(check,document.createTextNode('本机完成'));right.append(checkLabel);
      row.append(day,body,right);parent.append(row);
    }
  }
  parent.append(node('p','当前筛选：'+taskStatusText(activeStatus)+' · 匹配 '+tasks.length+' 项。学校提交证据与本机完成标记分开显示；本机标记不会提交作业。','footnote'));
}
async function setCompletion(task,value){if(state?.readOnly){message('本机缓存为只读显示，不能修改完成标记。',true);return}if(busy)return;busy=true;render();try{const result=await bridgeCall('complete',task.manualKey,value);recordBusinessDiagnostics(result);if(!result.ok){if(result.error?.code==='CACHE_FALLBACK')for(const item of state?.assignments||[])if(item.manualKey===task.manualKey)item.manualAvailable=false;message(errorLabel(result.error,'完成标记未能保存，请重试。'),true)}else{for(const item of state.assignments)if(item.manualKey===task.manualKey)item.manualCompleted=value;message('')}}catch{message('完成标记未能保存，请重试。',true)}finally{busy=false;render()}}
function renderCourses(parent,limit){const grid=node('div',undefined,'course-grid'),courses=(state?.courses||[]).filter(c=>(c.name+' '+(c.code||'')).toLowerCase().includes(query.toLowerCase()));if(!courses.length){empty(parent,state?'没有匹配的课程。':'登录后刷新查看课程。');return}for(const course of courses.slice(0,limit||courses.length)){const card=node('article',undefined,'course-card');card.append(node('div',course.code||course.id,'course-code'),node('h3',course.name));const bottom=node('div',undefined,'course-bottom'),actions=node('div',undefined,'course-actions');bottom.append(node('span',course.available===false?'不可用':'Classic 只读','badge'));const open=node('button','打开 Blackboard');open.disabled=Boolean(state?.readOnly)||!course.url;open.onclick=()=>openSource('course',course.id);actions.append(open);bottom.append(actions);card.append(bottom);grid.append(card)}parent.append(grid)}
function announcementTimestamp(item){const value=item.visibleFrom||item.publishedAt||item.createdAt||item.modifiedAt;const parsed=value?Date.parse(value):NaN;return Number.isFinite(parsed)?parsed:0}
function announcementDate(item){if(item.visibleFrom)return'可见于 '+dateTime(item.visibleFrom,{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});if(item.publishedAt)return'发布于 '+dateTime(item.publishedAt,{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});if(item.createdAt)return'创建于 '+dateTime(item.createdAt,{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});if(item.modifiedAt)return'修改于 '+dateTime(item.modifiedAt,{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});return'日期未提供'}
function renderAnnouncements(parent,limit){const needle=query.toLowerCase(),list=(state?.announcements||[]).filter(a=>courseMatches(a.courseId)).filter(a=>!needle||(a.title+' '+courseLabel(a.courseId)+' '+a.body.text).toLowerCase().includes(needle)).sort((left,right)=>announcementTimestamp(right)-announcementTimestamp(left));if(!list.length){empty(parent,state?'没有匹配的公告；可切换课程或清空搜索。':'登录后刷新查看公告。');return}for(const announcement of list.slice(0,limit||list.length)){const details=node('details',undefined,'announcement'),summary=node('summary'),title=node('span',announcement.title),course=node('span',courseLabel(announcement.courseId),'announcement-course course-identity');summary.append(title,course);details.append(summary,node('div',announcementDate(announcement)+(announcement.localSeenAt?' · 本机已读':''),'announcement-meta'));appendRich(details,announcement.body,true);const b=node('button','在 Blackboard 查看 →','text-button');b.disabled=Boolean(state?.readOnly)||!announcement.id;b.onclick=()=>openSource('announcement',announcement.id,announcement.courseId);const seen=node('button',announcement.localSeenAt?'取消本机已读':'标记本机已读','text-button');seen.disabled=Boolean(state?.readOnly);seen.onclick=async()=>{const result=await bridgeCall('markAnnouncementSeen',{courseId:announcement.courseId,id:announcement.id},!announcement.localSeenAt);recordBusinessDiagnostics(result);if(result?.ok){announcement.localSeenAt=result.localSeen?new Date().toISOString():null;render()}else message(errorLabel(result?.error,'本机已读标记未能保存。'),true)};details.append(b,seen);parent.append(details)}}
function fileDate(item){if(item.publishedAt)return'发布于 '+dateTime(item.publishedAt,{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});if(item.createdAt)return'创建于 '+dateTime(item.createdAt,{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});if(item.modifiedAt)return'修改于 '+dateTime(item.modifiedAt,{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});return'日期未提供'}
function renderFiles(parent){const needle=query.toLowerCase(),files=(state?.files||[]).filter(f=>courseMatches(f.courseId)).filter(f=>!needle||(f.name+' '+courseLabel(f.courseId)).toLowerCase().includes(needle));if(!files.length){empty(parent,state?'没有匹配的课程资料；可切换课程或清空搜索。':'登录后刷新查看课程资料。');return}for(const file of files){const row=node('div',undefined,'file'),info=node('div'),b=node('button',file.url?'打开来源 ↗':'无来源链接','text-button');info.append(node('div',file.name,'file-name'),node('div',courseLabel(file.courseId),'course-identity'),node('div',fileDate(file),'file-meta'));b.disabled=Boolean(state?.readOnly)||!file.id;b.onclick=()=>openSource('file',file.id,file.courseId);row.append(info,b);parent.append(row)}}
function renderCoverage(){
  if(!state)return node('section');
  const stale=[...(state.announcements||[]),...(state.assignments||[]),...(state.files||[])].filter(item=>item.provenance?.stale).length;
  const p=panel('覆盖与读取状态');
  const provenance=state.offlineCache?'本机缓存（只读） · 上次同步 '+dateTime(state.cachedAt||state.fetchedAt,{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}):state.source==='live'?'Blackboard API':'离线 fixture';
  p.append(node('div','状态：'+state.state+' · 来源：'+provenance+' · 过期缓存资源：'+stale,'sources'));
  const grid=node('div',undefined,'coverage-grid');
  for(const item of state.coverage||[]){
    const text=item.resource+' · '+(item.courseId||'全部课程')+'：'+item.state+'，'+item.received+' 条，'+item.pages+' 页'+(item.truncated?'（已截断）':'');
    grid.append(node('div',text,'coverage-item'));
  }
  p.append(grid);
  if(state.errors?.length||state.localErrors?.length){
    const list=node('ul',undefined,'error-list');
    list.style.overflowWrap='anywhere';
    for(const group of errorGroups(state.errors))list.append(node('li',errorGroupText(group)));
    for(const error of state.localErrors||[])list.append(node('li','LOCAL_STATE · '+error));
    p.append(list);
  }
  return p;
}
function courseFilterControl(){const select=node('select');select.setAttribute('aria-label','按课程筛选');const all=node('option','全部课程');all.value='';select.append(all);for(const course of state?.courses||[]){const option=node('option',course.code?course.code+' · '+course.name:course.name);option.value=course.id;select.append(option)}if(courseFilter&&!(state?.courses||[]).some(course=>course.id===courseFilter))courseFilter='';select.value=courseFilter;select.onchange=()=>{courseFilter=select.value;void debugEvent('filter',{page,filterKind:'course',hasCourseFilter:Boolean(courseFilter),queryLength:query.length});render()};return select}
function taskStatusControl(){const select=node('select');select.setAttribute('aria-label','按作业状态筛选');for(const [value,label] of [['pending','未完成'],['completed','已完成'],['all','全部']]){const option=node('option',label);option.value=value;select.append(option)}select.value=taskStatus;select.onchange=()=>{taskStatus=select.value;void debugEvent('filter',{page,filterKind:'status',taskStatus});render()};return select}
function updateTaskStats(){const count=$('task-count'),detail=$('task-count-detail'),label=count?.parentElement?.querySelector('small');if(label)label.textContent='未完成窗口内作业';if(!count)return;if(!state){count.textContent='—';if(detail)detail.textContent='';return}const windowTasks=(state.assignments||[]).filter(inDisplayWindow),completed=windowTasks.filter(isTaskCompleted),pending=windowTasks.length-completed.length;count.textContent=String(pending);if(detail)detail.textContent='已完成 '+completed.length+' · 共 '+windowTasks.length+' 项'}
function render(){const target=$('content');target.replaceChildren();$('page-title').textContent=titles[page][0];$('page-subtitle').textContent=titles[page][1];document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('active',b.dataset.page===page));$('stats').hidden=page!=='overview';if(state){$('course-count').textContent=state.courses.length;$('announcement-count').textContent=state.announcements.length}else{$('course-count').textContent='—';$('announcement-count').textContent='—'}if(!$('task-count-detail')){$('task-count').after(node('span',undefined,'stat-detail'));$('task-count').nextElementSibling.id='task-count-detail'}updateTaskStats();if(page==='overview'){const layout=node('div',undefined,'layout'),left=node('div'),right=node('div'),tasks=panel('近期未完成作业与 DDL','tasks');renderTasks(tasks,5,'pending');const courses=panel('我的课程','courses');renderCourses(courses,4);const announcements=panel('最新公告','announcements');renderAnnouncements(announcements,6);left.append(tasks,courses);right.append(announcements,renderCoverage(target));layout.append(left,right);target.append(layout)}else{if(courseFilter&&!(state?.courses||[]).some(course=>course.id===courseFilter))courseFilter='';const title={tasks:'作业与 DDL · '+taskStatusText(taskStatus),courses:'课程列表',announcements:'公告列表',files:'课程资料'}[page],p=panel(title),controls=node('div',undefined,'panel-filters'),search=node('input',undefined,'search');search.placeholder=page==='tasks'?'搜索作业标题、课程代码或名称…':page==='announcements'?'搜索公告标题、正文、课程代码或名称…':page==='files'?'搜索文件名、课程代码或名称…':'搜索课程或名称…';search.value=query;search.setAttribute('aria-label','搜索');search.oninput=()=>{query=search.value;void debugEvent('filter',{page,filterKind:'query',hasQuery:Boolean(query),queryLength:query.length});render();const next=$('content').querySelector('.search');if(next){next.focus();next.setSelectionRange(query.length,query.length)}};controls.append(search);if(page==='tasks'||page==='announcements'||page==='files')controls.append(courseFilterControl());if(page==='tasks')controls.append(taskStatusControl());p.firstChild.append(controls);if(page==='tasks')renderTasks(p);else if(page==='courses')renderCourses(p);else if(page==='announcements')renderAnnouncements(p);else renderFiles(p);target.append(p);if(state)target.append(renderCoverage(target))}$('coverage').textContent=state?(state.offlineCache?'当前为本机缓存只读显示，上次同步于 '+dateTime(state.cachedAt||state.fetchedAt,{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false})+'；登录后刷新最新数据，学校来源和媒体不会联网读取。':'显示未来 '+(state.displayWindowDays||30)+' 天、过去 30 天及日期待确认项目；数据仅在本机展示，来源需通过已读取业务 ID 打开。'):'登录后点击刷新，启动会检查已保存会话；仅在检测到密码或 MFA 挑战时显示官方登录窗口。'}
function navigate(next){page=next;query='';courseFilter='';void debugEvent('navigate',{page:next});render()}
function setLoginAction(action){loginAction=action;$('login').textContent=action==='complete'?'我已登录，检查连接':'登录 / 重新授权'}
async function restoreOnStartup(){
  if(busy)return;
  const token=++restoreToken;
  let awaitingInteraction=false;
  busy=true;
  render();
  $('refresh').disabled=$('days').disabled=$('login').disabled=true;
  $('cancel').hidden=false;
  $('updated').replaceChildren(node('span',undefined,'spinner'),document.createTextNode('正在准备 Blackboard Dashboard…'));
  message('');
  try{
    const result=await bridgeCall('restore',true,Number($('days').value),true);
    if(token!==restoreToken)return;
    recordBusinessDiagnostics(result);
    if(result?.firstUse){
      setLoginAction('begin');
      $('connection').textContent='首次使用 · 请登录';
      $('connection-dot').className='dot';
      $('updated').textContent='尚未登录和同步';
      message('欢迎使用 CUHK(SZ) Dashboard。请点击「登录 / 重新授权」，在学校窗口完成登录后再检查连接。');
      return;
    }
    if(result?.state==='authenticating'&&result?.recovery?.challenge){
      awaitingInteraction=true;
      setLoginAction('complete');
      if(result.offlineCache&&result.snapshot){
        state=result.snapshot;
        render();
        const cachedAt=result.cachedAt||result.snapshot.cachedAt||result.snapshot.fetchedAt;
        $('connection').textContent='等待登录确认 · 本机缓存';
        $('connection-dot').className='dot';
        $('updated').textContent='本机缓存快照 · 上次同步 '+dateTime(cachedAt,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});
      }else{
        $('connection').textContent='等待登录确认';
        $('connection-dot').className='dot';
      }
      message((result.offlineCache?'当前保留本机缓存（只读）。':'')+'已打开 Blackboard 官方登录窗口；如需密码或 MFA，请在窗口完成后点击“我已登录，检查连接”。'+cacheFailureText(result?.cacheError),true);
      return;
    }
    if(!result?.ok){
      setLoginAction('begin');
      const cacheFailure=cacheFailureText(result?.cacheError);
      if(result?.state==='unauthenticated'||result?.state==='expired'||result?.error?.code==='AUTH_REQUIRED'||result?.error?.code==='SESSION_EXPIRED'){
        $('connection').textContent='未找到有效会话，请登录';
        $('connection-dot').className='dot';
        message('未找到有效的已保存 Blackboard 会话，请点击「登录 / 重新授权」。'+cacheFailure,true);
      }else{
        $('connection').textContent='会话暂未确认';
        $('connection-dot').className='dot';
        message(errorLabel(result?.error,'暂时无法确认已保存的 Blackboard 会话，请稍后重试。')+cacheFailure,true);
      }
      return;
    }
    if(result.offlineCache&&result.snapshot){
      setLoginAction('begin');
      state=result.snapshot;
      render();
      const cachedAt=result.cachedAt||result.snapshot.cachedAt||result.snapshot.fetchedAt;
      $('connection').textContent='离线缓存 · 未连接 Blackboard';
      $('connection-dot').className='dot';
      $('updated').textContent='本机缓存快照 · 上次同步 '+dateTime(cachedAt,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});
      message(offlineReasonText(result.offlineReason)+'，显示本机上次缓存（只读）。上次同步时间：'+dateTime(cachedAt,{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false})+'；登录后可刷新最新数据。');
      return;
    }
    setLoginAction('begin');
    $('connection').textContent='已恢复会话，正在同步…';
    $('connection-dot').className='dot good';
    $('updated').replaceChildren(node('span',undefined,'spinner'),document.createTextNode('已恢复会话，正在同步 Blackboard Classic…'));
    const loaded=await bridgeCall('load',Number($('days').value));
    if(token!==restoreToken)return;
    recordBusinessDiagnostics(loaded);
    if(loaded?.error){
      if(isAuthError(loaded.error)&&!state?.offlineCache)clearUiAccountState();
      message(errorLabel(loaded.error,'同步失败，请重试。'),true);
      $('connection').textContent=loaded.error?.code==='SESSION_EXPIRED'?'会话已过期，请重新授权':'同步失败';
      $('connection-dot').className='dot';
      return;
    }
    state=loaded;
    render();
    const errors=loaded.errors||[];
    const auth=loaded.state==='auth-required'||errors.some(e=>e.code==='AUTH_REQUIRED'||e.code==='SESSION_EXPIRED');
    message(auth?'需要在本机完成 Blackboard 登录。'+(errors.length?' '+errorSummary(errors):''):errors.length?'部分内容未能读取：'+errorSummary(errors):'');
    $('connection').textContent=auth?'需要登录':loaded.state==='ok'?(loaded.source==='offline-fixture'?'离线演示':'已连接 Blackboard'):loaded.state==='partial'?'部分读取成功':'读取未完成';
    $('connection-dot').className='dot'+(loaded.state==='ok'?' good':'');
    $('updated').textContent=(loaded.source==='offline-fixture'?'离线演示 · ':'最近同步 ')+dateTime(loaded.fetchedAt,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});
  }catch(error){
    if(isAuthError(error?.error||error)&&!state?.offlineCache)clearUiAccountState();
    message(errorLabel(error?.error||error,'会话验证暂未完成，请稍后重试。'),true);
    $('connection').textContent=isAuthError(error?.error||error)?'未找到有效会话，请登录':'会话暂未确认';
    $('connection-dot').className='dot';
  }finally{
    busy=false;
    $('cancel').hidden=!awaitingInteraction;
    render();
    $('refresh').disabled=$('days').disabled=$('login').disabled=false;
    if($('updated').querySelector('.spinner'))$('updated').textContent='未完成会话检查，请重试。';
  }
}
async function refresh(){
  if(busy)return;
  const token=++refreshToken;
  busy=true;
  render();
  $('refresh').disabled=$('days').disabled=$('login').disabled=true;
  $('cancel').hidden=false;
  $('updated').replaceChildren(node('span',undefined,'spinner'),document.createTextNode('正在读取 Blackboard Classic…'));
  message('');
  try{
    const status=await bridgeCall('status');
    if(token!==refreshToken)return;
    recordBusinessDiagnostics(status);
    if(status?.firstUse){
      setLoginAction('begin');
      $('connection').textContent='首次使用 · 请登录';
      $('connection-dot').className='dot';
      message('首次使用请先点击「登录 / 重新授权」，完成学校登录后再刷新数据。');
      return;
    }
    if(status?.state==='authenticating'&&loginAction==='complete'){
      message('请在本机 Blackboard 登录窗口完成登录和 MFA，然后点击“我已登录，检查连接”。',true);
      $('connection').textContent='等待登录确认';
      $('connection-dot').className='dot';
      return;
    }
    if(status?.state!=='authenticated'){
      const restored=await bridgeCall('restore',false,Number($('days').value));
      if(token!==refreshToken)return;
      recordBusinessDiagnostics(restored);
      if(!restored?.ok){
        if(isAuthError(restored?.error)&&!state?.offlineCache)clearUiAccountState();
        if(state?.offlineCache){
          message('当前仍显示本机缓存（只读）；登录后可刷新最新数据。',true);
          $('connection').textContent='离线缓存 · 未连接 Blackboard';
        }else{
          message(errorLabel(restored?.error,'会话验证暂未完成，请稍后重试。'),true);
          $('connection').textContent=restored?.state==='expired'||restored?.error?.code==='SESSION_EXPIRED'?'会话已过期，请重新授权':'会话暂未确认';
        }
        $('connection-dot').className='dot';
        return;
      }
      if(state?.offlineCache)clearUiAccountState();
    }else if(state?.offlineCache)clearUiAccountState();
    const result=await bridgeCall('load',Number($('days').value));
    if(token!==refreshToken)return;
    recordBusinessDiagnostics(result);
    if(result?.error){
      if(isAuthError(result.error)&&!state?.offlineCache)clearUiAccountState();
      if(state?.offlineCache){
        message('当前仍显示本机缓存（只读）；登录后可刷新最新数据。',true);
        $('connection').textContent='离线缓存 · 未连接 Blackboard';
      }else{
        message(errorLabel(result.error,'读取失败，请重试。'),true);
        $('connection').textContent='连接失败';
      }
      $('connection-dot').className='dot';
    }else{
      state=result;
      render();
      const errors=result.errors||[];
      const auth=result.state==='auth-required'||errors.some(e=>e.code==='AUTH_REQUIRED'||e.code==='SESSION_EXPIRED');
      message(auth?'需要在本机完成 Blackboard 登录。'+(errors.length?' '+errorSummary(errors):''):errors.length?'部分内容未能读取：'+errorSummary(errors):'');
      $('connection').textContent=result.state==='ok'?(result.source==='offline-fixture'?'离线演示':'已连接 Blackboard'):result.state==='auth-required'?'需要登录':result.state==='partial'?'部分读取成功':'读取未完成';
      $('connection-dot').className='dot'+(result.state==='ok'?' good':'');
      $('updated').textContent=(result.source==='offline-fixture'?'离线演示 · ':'最近同步 ')+dateTime(result.fetchedAt,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});
    }
  }catch(error){
    if(isAuthError(error)&&!state?.offlineCache)clearUiAccountState();
    if(state?.offlineCache){
      message('当前仍显示本机缓存（只读）；登录后可刷新最新数据。',true);
      $('connection').textContent='离线缓存 · 未连接 Blackboard';
    }else{
      message(errorLabel(error?.error||error,'同步失败，请检查连接后重试。'),true);
      $('connection').textContent='同步失败';
    }
    $('connection-dot').className='dot';
  }finally{
    busy=false;
    $('cancel').hidden=true;
    render();
    $('refresh').disabled=$('days').disabled=$('login').disabled=false;
    if($('updated').querySelector('.spinner'))$('updated').textContent='未完成同步，请重试。';
  }
}
async function showDetail(task){
  if(busy)return;
  const token=++detailToken;activeDetailToken=token;
  const dialog=$('detail-dialog'),body=$('detail-content');
  $('detail-title').textContent=task.title;body.replaceChildren(node('p','正在读取作业详情…','empty'));dialog.showModal();
  if(state?.readOnly){
    body.replaceChildren();
    body.append(node('p','课程：'+courseLabel(task.courseId),'course-identity detail-course'),node('p','截止：'+taskDue(task),'sources'),node('p',submissionText(task),'sources'));
    if(task.details)appendRich(body,task.details);else if(task.summary)body.append(node('p',task.summary,'rich-body'));else body.append(node('p','该作业详情尚未缓存，登录后读取。','empty'));
    if(task.attachments?.length){body.append(node('h3','附件'));for(const attachment of task.attachments){const row=node('p'),b=node('button',attachment.name,'text-button');b.disabled=true;row.append(b,node('span',' · '+(attachment.mimeType||'类型未提供'),'sources'));body.append(row)}}
    body.append(node('p','本机缓存为只读显示；详情和附件元信息来自上次同步，媒体不会联网读取。','badge offline'));
    return;
  }
  try{
    const result=await bridgeCall('detail',{courseId:task.courseId,id:task.id});recordBusinessDiagnostics(result);
    if(token!==activeDetailToken||!dialog.open||!state)return;
    if(!result?.ok){body.replaceChildren(node('p',errorLabel(result.error,'详情读取失败。'),'empty'));return}
    const updated=result.assignment,existing=state.assignments.find(item=>item.courseId===updated.courseId&&item.id===updated.id);
    const localDueAt=existing?.localDueAt??task.localDueAt??null,manualCompleted=existing?.manualCompleted??task.manualCompleted;
    const merged={...updated,manualKey:existing?.manualKey??updated.manualKey,manualAvailable:existing?.manualAvailable??updated.manualAvailable,...(manualCompleted===undefined?{}:{manualCompleted}),...(localDueAt?{localDueAt}:{})};
    if(existing)Object.assign(existing,merged);
    const effective=merged;
    body.replaceChildren();body.append(node('p','课程：'+courseLabel(updated.courseId),'course-identity detail-course'),node('p','截止：'+taskDue(effective),'sources'),node('p',submissionText(updated),'sources'));
    const override=node('div',undefined,'sources'),input=node('input');input.type='datetime-local';input.value=localDueAt||'';input.setAttribute('aria-label','本机备忘截止日期');
    const save=node('button','保存本机日期','text-button');save.onclick=async()=>{const value=input.value||null;const saved=await bridgeCall('setDueOverride',{courseId:updated.courseId,id:updated.id},value);recordBusinessDiagnostics(saved);if(saved?.ok){task.localDueAt=saved.localDueAt;for(const item of state.assignments)if(item.courseId===updated.courseId&&item.id===updated.id)item.localDueAt=saved.localDueAt;message('本机日期已保存，不会修改 Blackboard。');render()}else message(errorLabel(saved?.error,'本机日期未能保存。'),true)};
    const clear=node('button','清除本机日期','text-button');clear.onclick=async()=>{const saved=await bridgeCall('setDueOverride',{courseId:updated.courseId,id:updated.id},null);recordBusinessDiagnostics(saved);if(saved?.ok){task.localDueAt=null;for(const item of state.assignments)if(item.courseId===updated.courseId&&item.id===updated.id)item.localDueAt=null;message('本机日期已清除。');render()}else message(errorLabel(saved?.error,'本机日期未能清除。'),true)};
    override.append(node('span','本机备忘（与学校日期分开）：'),input,save,clear);body.append(override);
    if(updated.details)appendRich(body,updated.details);else if(updated.summary)body.append(node('p',updated.summary,'rich-body'));
    if(updated.attachments?.length){body.append(node('h3','附件'));for(const attachment of updated.attachments){const row=node('p'),b=node('button',attachment.name,'text-button');b.disabled=!attachment.id;b.onclick=()=>openSource('attachment',attachment.id,updated.courseId);row.append(b,node('span',' · '+(attachment.mimeType||'类型未提供'),'sources'));body.append(row)}}
    if(result.errors?.length){const list=node('ul',undefined,'error-list');for(const error of result.errors)list.append(node('li',errorLabel(error,'详情未完整读取。')));body.append(list)}
    render();
  }catch(error){if(token!==activeDetailToken)return;body.replaceChildren(node('p',errorLabel(error?.error||error,'详情读取失败。'),'empty'))}
}
document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>navigate(b.dataset.page));$('refresh').onclick=refresh;$('days').onchange=()=>{if(state?.offlineCache){state.displayWindowDays=Number($('days').value);render();message('已调整本机缓存显示范围；缓存仍为只读。')}else void refresh()};$('cancel').onclick=async()=>{restoreToken++;refreshToken++;await bridgeCall('cancel',true);setLoginAction('begin');$('cancel').hidden=true;message('已请求取消当前读取。')};$('detail-dialog').addEventListener('close',()=>{activeDetailToken=++detailToken;void bridgeCall('cancel')});$('detail-close').onclick=()=>$('detail-dialog').close();$('open-diagnostics').onclick=async()=>{try{const result=await bridgeCall('openDiagnostics');updateDiagnosticLocation(result);message(result?.ok?'诊断日志目录已打开。':'无法打开诊断日志目录。',!result?.ok)}catch{message('无法打开诊断日志目录。',true)}};$('copy-diagnostics').onclick=async()=>{try{const result=await bridgeCall('copyDiagnostics');updateDiagnosticLocation(result);message(result?.ok?'诊断日志位置已复制。':'无法复制诊断日志位置。',!result?.ok)}catch{message('无法复制诊断日志位置。',true)}};$('login').onclick=async()=>{if(busy)return;const action=loginAction;const actionToken=++restoreToken;let refreshAfterLogin=false;activeDetailToken=++detailToken;if($('detail-dialog').open)$('detail-dialog').close();if(!(action==='complete'&&state?.offlineCache))clearUiAccountState();busy=true;$('login').disabled=$('refresh').disabled=$('days').disabled=true;message(action==='begin'?'正在打开本机 Blackboard 登录窗口…':'正在确认本机 Blackboard 登录状态…');try{const result=await bridgeCall('login',action);if(actionToken!==restoreToken)return;recordBusinessDiagnostics(result);if(result?.ok){if(action==='complete'&&state?.offlineCache)clearUiAccountState();setLoginAction('begin');$('connection').textContent='已连接 Blackboard';$('connection-dot').className='dot good';message(action==='complete'?'登录已确认，正在同步 Blackboard Classic…':'本机登录已确认，请点击刷新读取数据。');refreshAfterLogin=action==='complete';}else if(result?.state==='authenticating'){setLoginAction('complete');message('浏览器已打开。请在本机 Blackboard 窗口完成登录和 MFA，然后点击“我已登录，检查连接”。')}else{setLoginAction(action==='complete'?'complete':'begin');message(errorLabel(result?.error,'登录尚未确认，请重试。'),true)}}catch(error){if(actionToken!==restoreToken)return;setLoginAction(action==='complete'?'complete':'begin');message(errorLabel(error?.error||error,'登录操作失败，请重试。'),true)}finally{busy=false;$('login').disabled=$('refresh').disabled=$('days').disabled=false;if(actionToken===restoreToken&&refreshAfterLogin)void refresh()}};$('today').textContent=dateTime(new Date().toISOString(),{year:'numeric',month:'long',day:'numeric',weekday:'long'});render();bridgeCall('debugInfo').then(result=>updateDiagnosticLocation(result)).catch(()=>{});void restoreOnStartup();
</script></body></html>`;
}
