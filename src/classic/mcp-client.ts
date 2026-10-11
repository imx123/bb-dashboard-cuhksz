import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { stateHome } from '../config.js';
import { ClassicError, classifyConnectorError } from './errors.js';
import { ClassicToolNameSchema, type ClassicToolName } from './schema.js';

export const CLASSIC_READ_TOOLS = [
  'classic_status',
  'classic_login',
  'classic_snapshot',
  'classic_list_courses',
  'classic_announcements',
  'classic_list_assignments',
  'classic_assignment_details',
  'classic_list_course_files',
] as const satisfies readonly ClassicToolName[];
const allowedTools = new Set<string>(CLASSIC_READ_TOOLS);

type ToolArguments = Record<string, unknown>;
type Connection = {
  client: Client;
  transport: StdioClientTransport;
  tools: Map<string, Tool>;
  isAlive?: () => boolean;
  close: () => Promise<void>;
};

export interface ClassicMcpClientOptions {
  /** Only used by trusted main-process configuration or tests. Renderer input
   * never reaches this object. */
  sidecarRoot?: string;
  pythonCommand?: string;
  scriptPath?: string;
  cwd?: string;
  mode?: 'live' | 'offline-fixture';
  fixturePath?: string;
  /** Trusted main-process path for the live Playwright profile. */
  userDataDir?: string;
  /** Trusted provider cap forwarded to the Sidecar; renderer input never reaches it. */
  maxCourses?: number;
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
  /** Snapshot is a bounded multi-course read, so it gets its own larger RPC budget. */
  snapshotCallTimeoutMs?: number;
  retryCount?: number;
  /** Test-only seam; production uses the fixed stdio factory below. */
  connectionFactory?: (options: ResolvedRuntime) => Promise<Connection>;
}

export interface ResolvedRuntime {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

const projectRoot = () => resolve(fileURLToPath(new URL('../../', import.meta.url)));

/** Derive a stable live profile below the configured local state directory. */
export function classicUserDataDir(scope: string): string {
  const token = createHash('sha256').update(scope).digest('hex').slice(0, 32);
  return resolve(join(stateHome(), 'classic-profiles', token));
}

function trustedUserDataDir(value: string): string {
  const root = resolve(join(stateHome(), 'classic-profiles'));
  const absolute = resolve(value);
  const remainder = relative(root, absolute);
  if (!remainder || remainder.startsWith('..') || isAbsolute(remainder)) {
    throw new ClassicError('CONNECTOR_START_FAILED', 'Classic 登录 profile 路径未通过固定本机目录校验。', { recoverable: false });
  }
  return absolute;
}

function candidateSidecarRoots() {
  const roots = [
    resolve(process.cwd(), 'sidecar', 'bb-mcp'),
    resolve(projectRoot(), 'sidecar', 'bb-mcp'),
    typeof process.resourcesPath === 'string' ? resolve(process.resourcesPath, 'sidecar', 'bb-mcp') : '',
  ];
  return [...new Set(roots.filter(Boolean))];
}

function candidatePythonPaths(root: string) {
  return [join(root, 'venv', 'Scripts', 'python.exe'), join(root, '.venv', 'Scripts', 'python.exe')];
}

function trustedPath(value: string, root: string): string {
  const absolute = resolve(value);
  const allowed = candidatePythonPaths(root).map(value => resolve(value));
  if (!allowed.includes(absolute)) throw new ClassicError('CONNECTOR_START_FAILED', 'Classic 连接器 Python 环境路径未通过固定配置校验。', { recoverable: false });
  return absolute;
}

export function resolveClassicRuntime(options: ClassicMcpClientOptions = {}): ResolvedRuntime {
  const roots = candidateSidecarRoots();
  const root = resolve(options.sidecarRoot ?? roots.find(value => existsSync(join(value, 'server.py')) && candidatePythonPaths(value).some(existsSync)) ?? roots[0] ?? '');
  const expectedScript = resolve(join(root, 'server.py'));
  const script = resolve(options.scriptPath ?? expectedScript);
  if (script !== expectedScript) throw new ClassicError('CONNECTOR_START_FAILED', 'Classic 连接器脚本路径未通过固定项目校验。', { recoverable: false });
  const cwd = resolve(options.cwd ?? root);
  if (cwd !== root) throw new ClassicError('CONNECTOR_START_FAILED', 'Classic 连接器工作目录未通过固定项目校验。', { recoverable: false });
  const python = options.pythonCommand
    ? trustedPath(options.pythonCommand, root)
    : candidatePythonPaths(root).find(existsSync);
  if (!python || !existsSync(script)) {
    throw new ClassicError('CONNECTOR_START_FAILED', 'Classic 连接器或项目虚拟环境未找到，请先完成 Sidecar 安装。', { recoverable: false });
  }
  const mode = options.mode ?? (process.env.CUHK_CLASSIC_MODE === 'offline-fixture' ? 'offline-fixture' : 'live');
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !/^BB_(USERNAME|PASSWORD|COOKIE|TOKEN|CREDENTIAL)/i.test(key)) env[key] = value;
  env.BB_BASE_URL = 'https://bb.cuhk.edu.cn';
  const maxCourses = Math.min(50, Math.max(1, Math.floor(options.maxCourses ?? 15)));
  env.BB_MAX_COURSES = String(maxCourses);
  // Keep the Sidecar's bounded work budget below the Node RPC budget.  This
  // prevents an inherited BB_* environment value from making snapshot calls
  // outlive the caller while still preserving completed partial data.
  env.BB_SNAPSHOT_TIMEOUT_MS = '180000';
  env.BB_MAX_CONTENT_PAGES = '48';
  if (mode === 'offline-fixture') {
    const fixture = options.fixturePath ? resolve(options.fixturePath) : resolve(process.cwd(), 'test', 'fixtures', 'classic');
    env.BB_OFFLINE_FIXTURE = fixture;
    delete env.BB_USER_DATA_DIR;
  } else {
    delete env.BB_OFFLINE_FIXTURE;
    if (!options.userDataDir) throw new ClassicError('CONNECTOR_START_FAILED', 'Classic live 登录 profile 未提供固定本机目录。', { recoverable: false });
    env.BB_USER_DATA_DIR = trustedUserDataDir(options.userDataDir);
  }
  return { command: python, args: [script], cwd, env };
}

async function defaultConnection(runtime: ResolvedRuntime, timeoutMs: number): Promise<Connection> {
  const transport = new StdioClientTransport({ command: runtime.command, args: runtime.args, cwd: runtime.cwd, env: runtime.env, stderr: 'pipe' });
  const client = new Client({ name: 'cuhksz-classic-dashboard', version: '0.1.0' });
  transport.stderr?.on('data', () => { /* never expose Python/HTML diagnostics to the renderer */ });
  try {
    await client.connect(transport, { timeout: timeoutMs });
    const { tools } = await client.listTools();
    const reviewed = new Map((tools ?? []).filter(tool => allowedTools.has(tool.name)).map(tool => [tool.name, tool]));
    let transportAlive = true;
    const previousOnClose = transport.onclose;
    const previousOnError = transport.onerror;
    transport.onclose = () => { transportAlive = false; previousOnClose?.(); };
    transport.onerror = error => { transportAlive = false; previousOnError?.(error); };
    return {
      client,
      transport,
      tools: reviewed,
      isAlive: () => transportAlive,
      close: async () => { await client.close().catch(() => {}); await transport.close().catch(() => {}); },
    };
  } catch (error) {
    await client.close().catch(() => {}); await transport.close().catch(() => {});
    throw new ClassicError('CONNECTOR_START_FAILED', 'Classic 连接器未能启动，请检查本机 Sidecar 环境。', { cause: error });
  }
}

function validateArguments(tool: ClassicToolName, args: ToolArguments): void {
  if (tool === 'classic_status' || tool === 'classic_list_courses') {
    if (Object.keys(args).length) throw new ClassicError('BAD_INPUT', `${tool} 不接受参数。`, { recoverable: false });
    return;
  }
  if (tool === 'classic_login') {
    if (args.action !== undefined && args.action !== 'begin' && args.action !== 'complete') throw new ClassicError('BAD_INPUT', '登录动作无效。', { recoverable: false });
    if (Object.keys(args).some(key => key !== 'action')) throw new ClassicError('BAD_INPUT', '登录参数超出白名单。', { recoverable: false });
    return;
  }
  if (tool === 'classic_snapshot') {
    const supported = new Set(['course_ids', 'include', 'limits']);
    if (Object.keys(args).some(key => !supported.has(key))) throw new ClassicError('BAD_INPUT', '快照参数超出只读白名单。', { recoverable: false });
    if (args.course_ids !== undefined && (!Array.isArray(args.course_ids) || args.course_ids.some(value => typeof value !== 'string' || !/^_\d+_\d+$/.test(value)))) throw new ClassicError('BAD_INPUT', '课程筛选参数无效。', { recoverable: false });
    if (args.include !== undefined && (!Array.isArray(args.include) || args.include.some(value => !['announcements', 'assignments', 'files'].includes(String(value))))) throw new ClassicError('BAD_INPUT', '资源筛选参数无效。', { recoverable: false });
    if (args.limits !== undefined) {
      if (!args.limits || typeof args.limits !== 'object' || Array.isArray(args.limits)) throw new ClassicError('BAD_INPUT', '读取上限参数无效。', { recoverable: false });
      const limits = args.limits as Record<string, unknown>;
      const maxByKind: Record<string, number> = { announcements: 20, assignments: 100, files: 100 };
      if (Object.keys(limits).some(key => !(key in maxByKind))) throw new ClassicError('BAD_INPUT', '读取上限参数超出白名单。', { recoverable: false });
      for (const [kind, value] of Object.entries(limits)) {
        const max = maxByKind[kind]!;
        if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > max) throw new ClassicError('BAD_INPUT', `${kind} 数量必须是 1 到 ${max}。`, { recoverable: false });
      }
    }
    return;
  }
  const course = args.course_id;
  if (typeof course !== 'string' || !/^_\d+_\d+$/.test(course.trim())) throw new ClassicError('BAD_INPUT', '课程 ID 参数无效。', { recoverable: false });
  if (args.limit !== undefined) {
    const max = tool === 'classic_announcements' ? 20 : 100;
    if (!Number.isInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > max) throw new ClassicError('BAD_INPUT', `读取数量必须是 1 到 ${max}。`, { recoverable: false });
  }
  if (tool === 'classic_assignment_details') {
    if (args.keyword !== undefined && (typeof args.keyword !== 'string' || args.keyword.length > 200)) throw new ClassicError('BAD_INPUT', '作业筛选词无效。', { recoverable: false });
  }
  const supported = tool === 'classic_announcements' || tool === 'classic_list_assignments' || tool === 'classic_list_course_files' ? new Set(['course_id', 'limit'])
    : tool === 'classic_assignment_details' ? new Set(['course_id', 'keyword', 'limit'])
      : new Set(['course_id']);
  if (Object.keys(args).some(key => !supported.has(key))) throw new ClassicError('BAD_INPUT', '连接器参数超出只读白名单。', { recoverable: false });
}

export class ClassicMcpClient {
  private connection?: Connection;
  private connecting?: Promise<Connection>;
  private closed = false;
  private readonly options: Required<Pick<ClassicMcpClientOptions, 'connectTimeoutMs' | 'callTimeoutMs' | 'snapshotCallTimeoutMs' | 'retryCount'>>;

  constructor(private readonly config: ClassicMcpClientOptions = {}) {
    this.options = {
      connectTimeoutMs: config.connectTimeoutMs ?? 15_000,
      callTimeoutMs: config.callTimeoutMs ?? 45_000,
      snapshotCallTimeoutMs: config.snapshotCallTimeoutMs ?? 210_000,
      retryCount: config.retryCount ?? 1,
    };
  }

  private async getConnection(): Promise<Connection> {
    if (this.closed) throw new ClassicError('CONNECTOR_DISCONNECTED', 'Classic 连接器已关闭，请重新加载。');
    if (this.connection) return this.connection;
    if (!this.connecting) {
      this.connecting = (async () => {
        // Test connection factories do not spawn the trusted Sidecar.  Give
        // their omitted mode a fixture runtime so live profile requirements
        // cannot make a fake transport appear to be a real login attempt.
        const runtime = resolveClassicRuntime(this.config.connectionFactory && this.config.mode === undefined
          ? { ...this.config, mode: 'offline-fixture' }
          : this.config);
        const connection = await (this.config.connectionFactory?.(runtime) ?? defaultConnection(runtime, this.options.connectTimeoutMs));
        if (this.closed) {
          await connection.close().catch(() => {});
          throw new ClassicError('CONNECTOR_DISCONNECTED', 'Classic 连接器已关闭，请重新加载。');
        }
        this.connection = connection;
        return connection;
      })().catch(error => { throw classifyConnectorError(error); }).finally(() => { this.connecting = undefined; });
    }
    return this.connecting;
  }

  async listTools(): Promise<string[]> {
    const connection = await this.getConnection();
    return [...connection.tools.keys()];
  }

  async call(toolValue: string, args: ToolArguments = {}): Promise<CallToolResult> {
    const parsed = ClassicToolNameSchema.safeParse(toolValue);
    if (!parsed.success || !allowedTools.has(toolValue)) throw new ClassicError('TOOL_NOT_ALLOWED', '该 Blackboard 工具不在应用只读白名单内。', { recoverable: false });
    const tool = parsed.data;
    validateArguments(tool, args);
    let last: unknown;
    for (let attempt = 0; attempt <= this.options.retryCount; attempt++) {
      let activeConnection: Connection | undefined;
      try {
        const connection = await this.getConnection();
        activeConnection = connection;
        if (!connection.tools.has(tool)) throw new ClassicError('TOOL_UNAVAILABLE', 'Classic 连接器版本未提供该只读工具。');
        const timeoutMs = tool === 'classic_snapshot' ? this.options.snapshotCallTimeoutMs : this.options.callTimeoutMs;
        const call = connection.client.callTool({ name: tool, arguments: args }, undefined, { timeout: timeoutMs }) as Promise<CallToolResult>;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            call,
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ClassicError('TIMEOUT', 'Blackboard 读取超时，请保持登录窗口打开后重试。')), timeoutMs); }),
          ]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      } catch (error) {
        const classified = classifyConnectorError(error);
        last = classified;
        // A timeout or tool failure can happen while the Python worker still
        // owns the user's persistent Playwright context.  Resetting the MCP
        // transport here closes that context and forces a fresh login.  Keep a
        // live connection for the caller to retry; close() remains the
        // explicit application-shutdown cleanup path.
        const transportAlive = activeConnection?.isAlive?.() ?? (classified.code !== 'CONNECTOR_DISCONNECTED');
        const preserveActiveSession = transportAlive && classified.code !== 'CONNECTOR_DISCONNECTED' && (Boolean(this.connection)
          || tool === 'classic_snapshot'
          || ['AUTH_REQUIRED', 'SESSION_EXPIRED', 'TIMEOUT'].includes(classified.code));
        if (
          attempt >= this.options.retryCount
          || preserveActiveSession
          || ['BAD_INPUT', 'TOOL_NOT_ALLOWED', 'TOOL_UNAVAILABLE'].includes(classified.code)
        ) throw classified;
        await this.resetConnection();
      }
    }
    throw classifyConnectorError(last);
  }

  async status(): Promise<CallToolResult> { return this.call('classic_status'); }

  private async resetConnection() {
    const old = this.connection;
    this.connection = undefined;
    if (old) await old.close().catch(() => {});
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.resetConnection();
  }
}
