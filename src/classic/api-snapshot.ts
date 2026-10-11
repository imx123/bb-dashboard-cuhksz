import { ClassicApiError, isAuthenticationError, publicApiError, type PublicClassicApiError } from './api-errors.js';
import type { ClassicApiCallOptions } from './api-contract.js';
import type { ClassicApiClient } from './api-client.js';
import { debugLog } from '../debug-log.js';
import { readContentTree, type ContentTreeResult } from './content-tree.js';
import type { PaginatedResult } from './pagination.js';
import type { RichTextOptions } from './rich-text.js';
import type { ClassicResourceRegistrar } from './detail-reader.js';
import { assertSubmissionScope, deriveSubmissionSummary, mergeSubmissionSummaries } from './submissions.js';
import { normalizeAnnouncement, normalizeAssignment, normalizeCourse, normalizeFile, normalizeSubmission, sameDueValue, type NormalizationContext } from './normalize.js';
import { rawId, rawRecord, rawString, type RawAnnouncement, type RawAttempt, type RawCalendarItem, type RawContentNode, type RawGrade, type RawGradeColumn, type RawObject } from './raw-schema.js';
import { AssignmentV2Schema, SnapshotV2Schema, type AssignmentV2, type CoverageEntry, type CoverageResource, type CoverageState, type SnapshotV2 } from './schema-v2.js';

export interface ClassicSnapshotReadOptions extends ClassicApiCallOptions {
  readonly source?: SnapshotV2['source'];
  readonly maxCourses?: number;
  readonly maxContentNodes?: number;
  readonly maxContentDepth?: number;
  readonly richText?: RichTextOptions;
  readonly resourceRegistry?: ClassicResourceRegistrar;
}

export interface ClassicSnapshotReadResult {
  readonly snapshot: SnapshotV2;
  readonly accountUserId: string;
}

function fixedErrorMessage(code: PublicClassicApiError['code']): string {
  switch (code) {
    case 'AUTH_REQUIRED': return 'Classic 会话尚未验证。';
    case 'SESSION_EXPIRED': return 'Classic 会话已过期。';
    case 'FORBIDDEN': return '学校限制了该范围的读取。';
    case 'CONTENT_UNAVAILABLE': return '该内容当前不可用。';
    case 'NOT_FOUND': return '学校未找到该资源。';
    case 'PARTIAL_RESULTS': return '该范围只读取了部分结果。';
    case 'API_SCHEMA_CHANGED': return '学校返回结构需要重新核对。';
    case 'TIMEOUT': return '该范围读取超时。';
    case 'RATE_LIMITED': return '学校暂时限制了读取频率。';
    case 'NETWORK': return '该范围网络读取失败。';
    default: return '该范围读取未完成。';
  }
}

function snapshotError(error: unknown, fallbackScope: string): SnapshotV2['errors'][number] {
  const publicError = publicApiError(error);
  return { scope: publicError.scope === 'unknown' ? fallbackScope : publicError.scope, code: publicError.code, message: fixedErrorMessage(publicError.code) };
}

function addPublicErrors(output: SnapshotV2['errors'], errors: readonly PublicClassicApiError[], fallbackScope: string): void {
  for (const error of errors) output.push({ scope: error.scope || fallbackScope, code: error.code, message: fixedErrorMessage(error.code) });
}

function coverageState(received: number, complete: boolean, errors: readonly PublicClassicApiError[]): CoverageState {
  if (complete && errors.length === 0) return 'complete';
  if (received > 0 || errors.some(error => error.code === 'FORBIDDEN' || error.code === 'CONTENT_UNAVAILABLE')) return 'partial';
  return errors.some(error => error.code === 'ENDPOINT_UNSUPPORTED' || error.code === 'NOT_FOUND') ? 'unsupported' : 'failed';
}

function coverage(courseId: string | null, resource: CoverageResource, received: number, pages: number, complete: boolean, truncated: boolean, restrictedNodes: number, errors: readonly PublicClassicApiError[], checkedAt: string): CoverageEntry {
  return {
    courseId,
    resource,
    state: coverageState(received, complete, errors),
    received,
    pages,
    truncated,
    restrictedNodes,
    checkedAt,
  };
}

function courseRaw(value: RawObject): RawObject {
  const item = rawRecord(value.course);
  return item ? item : value;
}

function nodeRaw(node: { readonly contentId: string; readonly title: string; readonly url: string | null; readonly kind: string; readonly raw: RawContentNode }, courseId: string): RawObject {
  return { ...(node.raw as RawObject), id: rawId(node.raw as RawObject, 'id', 'contentId') ?? node.contentId, contentId: node.contentId, courseId, title: node.title, kind: node.kind, ...(node.url ? { url: node.url } : {}) };
}

function isAssignmentNode(kind: string): boolean {
  return kind === 'assignment' || kind === 'test-link';
}

function isFileNode(kind: string): boolean {
  // Unknown visible handlers remain reviewable as kind=unknown files with
  // their title/source; only known folders are traversed separately.
  return kind === 'file' || kind === 'document' || kind === 'external-link' || kind === 'video' || kind === 'unknown';
}

function errorFromNormalization(error: unknown, scope: string): SnapshotV2['errors'][number] {
  return snapshotError(error, scope);
}

function rawColumnId(value: unknown): string | null { return rawId((rawRecord(value) ?? {}) as RawObject, 'columnId', 'id') ?? null; }
function rawContentId(value: unknown): string | null { return rawId((rawRecord(value) ?? {}) as RawObject, 'contentId') ?? null; }

function gradeColumnId(value: RawObject): string | null {
  const column = rawRecord(value.column);
  return rawId(value, 'columnId') ?? (column ? rawColumnId(column) : null);
}

function gradeContentId(value: RawObject): string | null {
  const column = rawRecord(value.column);
  return rawContentId(value) ?? (column ? rawContentId(column) : null);
}

function mergeGrade(assignment: AssignmentV2, grade: RawGrade, column: RawGradeColumn | undefined, context: NormalizationContext): { assignment: AssignmentV2; submissionConflict: boolean } {
  const item = grade as RawObject;
  const columnValue = (column ?? {}) as RawObject;
  const linkedColumnId = gradeColumnId(item) ?? rawColumnId(columnValue);
  const title = assignment.title || rawString(columnValue.title ?? columnValue.name) || '未命名评分项目';
  const columnIds = [...new Set([
    ...(assignment.columnIds ?? (assignment.columnId ? [assignment.columnId] : [])),
    ...(linkedColumnId ? [linkedColumnId] : []),
  ])];
  const mergedSubmission = mergeSubmissionSummaries(assignment.submission, normalizeSubmission(item, context, assignment.url ?? undefined, assignment.courseId, assignment.contentId ?? undefined));
  return { assignment: AssignmentV2Schema.parse({
    ...assignment,
    title,
    columnId: assignment.columnId ?? linkedColumnId,
    ...(columnIds.length ? { columnIds } : {}),
    submission: mergedSubmission.summary,
  }), submissionConflict: mergedSubmission.conflict };
}

function mergeColumn(assignment: AssignmentV2, candidate: AssignmentV2): AssignmentV2 {
  const existingDue = assignment.dueAt ?? assignment.dueDateOnly;
  const candidateDue = candidate.dueAt ?? candidate.dueDateOnly;
  const conflictingDue = Boolean(existingDue && candidateDue && !sameDueValue(existingDue, candidateDue));
  const useCandidateDue = !existingDue && !!candidateDue;
  const columnIds = [...new Set([
    ...(assignment.columnIds ?? (assignment.columnId ? [assignment.columnId] : [])),
    ...(candidate.columnIds ?? (candidate.columnId ? [candidate.columnId] : [])),
  ])];
  return AssignmentV2Schema.parse({
    ...assignment,
    columnId: assignment.columnId ?? candidate.columnId,
    ...(columnIds.length ? { columnIds } : {}),
    dueAt: useCandidateDue ? candidate.dueAt : assignment.dueAt,
    dueDateOnly: useCandidateDue ? candidate.dueDateOnly : assignment.dueDateOnly,
    standardDueAt: assignment.standardDueAt ?? candidate.standardDueAt,
    dueEvidence: assignment.dueEvidence === 'unknown' ? candidate.dueEvidence : assignment.dueEvidence,
    dueConflict: assignment.dueConflict || candidate.dueConflict || conflictingDue,
  });
}

function calendarDate(value: unknown, scope: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  const text = typeof value === 'string' ? value.trim() : '';
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})$/.exec(text);
  if (!match) throw new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard 日历时间缺少明确时区或格式无法解释。', { scope, retryable: false });
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (month < 1 || month > 12 || day < 1 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || !Number.isFinite(Date.parse(text))) {
    throw new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard 日历时间日期无效。', { scope, retryable: false });
  }
  return text;
}

function calendarCourseId(item: RawCalendarItem): string | null {
  const value = item as RawObject;
  // `calendarId` identifies calendar context, not a unique event or course.
  // Only an explicit courseId can safely associate a GradebookColumn event
  // with a task; rows without that binding remain source coverage data.
  return rawId(value, 'courseId') ?? null;
}

function calendarColumnId(item: RawCalendarItem): string | null {
  const value = item as RawObject;
  const type = rawString(value.type)?.toLowerCase();
  return rawId(value, 'columnId') ?? (type === 'gradebookcolumn' ? rawId(value, 'id') ?? null : null);
}

function calendarTimes(item: RawCalendarItem, scope: string): string[] {
  const value = item as RawObject;
  const times = [calendarDate(value.start, `${scope}:start`), calendarDate(value.end, `${scope}:end`)].filter((time): time is string => !!time);
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const time of times) {
    // Blackboard may serialize the same instant with Z or an explicit offset.
    // Compare the instant rather than the raw spelling before deciding that a
    // GradebookColumn has conflicting start/end evidence.
    const key = /^\d{4}-\d{2}-\d{2}$/.test(time) ? `date:${time}` : `instant:${Date.parse(time)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(time);
  }
  return unique;
}

function calendarWindow(fetchedAt: string): { since: string; until: string } {
  const center = Date.parse(fetchedAt);
  const halfWindow = 8 * 7 * 24 * 60 * 60 * 1000;
  return { since: new Date(center - halfWindow).toISOString(), until: new Date(center + halfWindow).toISOString() };
}

/** Apply only reliable GradebookColumn calendar evidence; ordinary events remain calendar-only. */
function applyCalendarDue(items: readonly RawCalendarItem[], courseId: string, assignments: AssignmentV2[], errors: PublicClassicApiError[]): void {
  const index = assignmentIndex(assignments);
  const byAssignment = new Map<number, { columnId: string; times: Set<string> }>();
  for (const item of items) {
    const value = item as RawObject;
    if (calendarCourseId(item) !== courseId || rawString(value.type)?.toLowerCase() !== 'gradebookcolumn') continue;
    const scope = `course:${courseId}:calendar`;
    const columnId = calendarColumnId(item);
    if (!columnId) {
      errors.push(publicApiError(new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard GradebookColumn 日历项缺少 columnId。', { scope, retryable: false })));
      continue;
    }
    let times: string[];
    try { times = calendarTimes(item, scope); }
    catch (error) { errors.push(publicApiError(error)); continue; }
    if (!times.length) {
      errors.push(publicApiError(new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard GradebookColumn 日历项缺少 start/end。', { scope, retryable: false })));
      continue;
    }
    const targetIndex = index.get(`${courseId}\0column\0${columnId}`);
    if (targetIndex === undefined) {
      errors.push(publicApiError(new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard 日历项无法关联当前课程评分列。', { scope, retryable: false })));
      continue;
    }
    const existing = byAssignment.get(targetIndex) ?? { columnId, times: new Set<string>() };
    for (const time of times) existing.times.add(time);
    byAssignment.set(targetIndex, existing);
  }
  for (const [targetIndex, evidence] of byAssignment) {
    const assignment = assignments[targetIndex];
    if (!assignment) continue;
    const calendarValues = [...evidence.times].sort();
    const existingDue = assignment.dueAt ?? assignment.dueDateOnly;
    let dueConflict = assignment.dueConflict;
    let dueAt = assignment.dueAt;
    let dueDateOnly = assignment.dueDateOnly;
    let dueEvidence = assignment.dueEvidence;
    if (calendarValues.length !== 1) {
      dueConflict = true;
    } else if (!existingDue) {
      dueAt = calendarValues[0]!;
      dueDateOnly = null;
      dueEvidence = 'calendar';
    } else if (existingDue && !sameDueValue(existingDue, calendarValues[0])) {
      dueConflict = true;
    }
    const columnIds = [...new Set([...(assignment.columnIds ?? (assignment.columnId ? [assignment.columnId] : [])), evidence.columnId])];
    assignments[targetIndex] = AssignmentV2Schema.parse({ ...assignment, columnIds, dueAt, dueDateOnly, dueEvidence, dueConflict });
  }
}

function attemptId(value: unknown): string | null {
  return rawId((rawRecord(value) ?? {}) as RawObject, 'attemptId', 'id') ?? null;
}

function attemptNeedsDetail(value: unknown): boolean {
  const summary = deriveSubmissionSummary(value);
  if (summary.latestAttemptState === 'in-progress' || summary.remoteSubmission === 'unknown') return true;
  // A verified completed/needs-grading attempt proves submission, but its
  // actual receipt date/number still needs the bounded detail read when the
  // expanded row did not carry those fields.
  return summary.remoteSubmission === 'submitted' && (!summary.receiptId || !summary.submittedAt);
}

async function readSubmissionHistory(api: ClassicApiClient, grade: RawGrade, courseId: string, columnId: string | null, options: ClassicSnapshotReadOptions, context: NormalizationContext): Promise<{ summary: AssignmentV2['submission']; errors: PublicClassicApiError[] }> {
  const value = grade as RawObject;
  const gradeId = rawId(value, 'gradeId', 'id');
  assertSubmissionScope(value, { courseId, userId: api.account?.userId, columnId, contentId: gradeContentId(value), gradeId });
  const current = normalizeSubmission(value, context, undefined, courseId, gradeContentId(value) ?? undefined);
  if (!columnId || !gradeId || !attemptNeedsDetail(value)) {
    return { summary: current, errors: [] };
  }
  let result;
  try {
    result = await api.attempts(options, courseId, columnId, gradeId, { limit: 100 });
  } catch (error) {
    if (isAuthenticationError(error)) throw error;
    return { summary: current, errors: [publicApiError(error)] };
  }
  const errors: PublicClassicApiError[] = [...result.errors];
  const history: RawAttempt[] = [];
  let historyScopeComplete = true;
  for (const item of result.items) {
    try {
      assertSubmissionScope(item, { courseId, userId: api.account?.userId, columnId, contentId: gradeContentId(value), gradeId });
      history.push(item);
    } catch (error) {
      // A mismatched attempt cannot contribute submission evidence. Keep the
      // rest of the history and expose the schema gap as incomplete coverage.
      historyScopeComplete = false;
      errors.push(publicApiError(error));
    }
  }
  // A list row may omit receipt metadata. Read only a small number of
  // evidence-bearing attempt details, and never treat a failed detail as an
  // empty history.
  const detailIds = new Set<string>();
  for (const item of history) {
    const id = attemptId(item);
    if (id && attemptNeedsDetail(item)) detailIds.add(id);
  }
  const currentAttempt = rawRecord(value.lastAttempt ?? value.attempt);
  const currentId = currentAttempt ? attemptId(currentAttempt) : null;
  if (currentId && attemptNeedsDetail(currentAttempt)) detailIds.add(currentId);
  if (current.latestAttemptId && attemptNeedsDetail(value)) detailIds.add(current.latestAttemptId);
  const detailCandidates = [...detailIds].slice(0, 5);
  let detailsComplete = detailIds.size <= detailCandidates.length;
  if (!detailsComplete) {
    errors.push(publicApiError(new ClassicApiError('PARTIAL_RESULTS', '相关 attempt 详情超过本次读取上限。', { scope: `course:${courseId}:grades`, retryable: false })));
  }
  for (const id of detailCandidates) {
    try {
      const detail = await api.attemptDetail(options, courseId, id);
      assertSubmissionScope(detail, { courseId, userId: api.account?.userId, columnId, contentId: gradeContentId(value), gradeId });
      const index = history.findIndex(candidate => attemptId(candidate) === id);
      if (index >= 0) history[index] = detail;
      else history.push(detail);
    } catch (error) {
      if (isAuthenticationError(error)) throw error;
      detailsComplete = false;
      errors.push(publicApiError(error));
    }
  }
  const summary = normalizeSubmission({
    ...value,
    history,
    historyComplete: result.complete && detailsComplete && historyScopeComplete,
    attemptCount: result.complete ? history.length : undefined,
  }, context, undefined, courseId, gradeContentId(value) ?? undefined);
  return { summary, errors };
}

function addAssignmentFromColumn(column: RawGradeColumn, courseId: string, context: { fetchedAt: string; source: 'internal-api' | 'public-api' | 'html-detail' | 'user-entered' }): AssignmentV2 | null {
  const item = column as RawObject;
  const contentId = rawContentId(item);
  const columnId = rawColumnId(item);
  if (!contentId || !columnId) return null;
  return normalizeAssignment({
    ...item,
    id: contentId,
    courseId,
    contentId,
    columnId,
    kind: 'other-graded',
    title: rawString(item.title ?? item.name) ?? '未命名评分项目',
  }, context);
}

function assignmentIndex(items: AssignmentV2[]): Map<string, number> {
  const output = new Map<string, number>();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    output.set(`${item.courseId}\0content\0${item.contentId ?? ''}`, index);
    for (const columnId of item.columnIds ?? (item.columnId ? [item.columnId] : [])) {
      output.set(`${item.courseId}\0column\0${columnId}`, index);
    }
  }
  return output;
}

async function readCourse(api: ClassicApiClient, course: SnapshotV2['courses'][number], options: ClassicSnapshotReadOptions, fetchedAt: string, errors: SnapshotV2['errors'], coverageEntries: CoverageEntry[], assignments: AssignmentV2[], announcements: SnapshotV2['announcements'], files: SnapshotV2['files'], calendarItems: readonly RawCalendarItem[], calendarMappingErrors: PublicClassicApiError[]): Promise<void> {
  const context = { fetchedAt, source: 'internal-api' as const, traceId: options.traceId, richText: options.richText, resourceRegistry: options.resourceRegistry, allowClassicFallback: true };
  const announcementErrors: PublicClassicApiError[] = [];
  const assignmentErrors: PublicClassicApiError[] = [];
  const fileErrors: PublicClassicApiError[] = [];
  const gradeErrors: PublicClassicApiError[] = [];
  const beforeAnnouncements = announcements.length;
  let announcementResult;
  try {
    announcementResult = await api.announcements(options, course.id, { limit: 100 });
    addPublicErrors(errors, announcementResult.errors, `course:${course.id}:announcements`);
    for (const item of announcementResult.items) {
      try { announcements.push(normalizeAnnouncement(item as RawAnnouncement, context)); }
      catch (error) {
        announcementErrors.push(publicApiError(error));
        errors.push(errorFromNormalization(error, `course:${course.id}:announcements`));
      }
    }
  } catch (error) {
    if (isAuthenticationError(error)) throw error;
    errors.push(snapshotError(error, `course:${course.id}:announcements`));
    announcementResult = { items: [], pages: 0, complete: false, truncated: false, nextPage: null, errors: [publicApiError(error)] };
  }
  coverageEntries.push(coverage(course.id, 'announcements', announcements.length - beforeAnnouncements, announcementResult.pages, announcementResult.complete, announcementResult.truncated, 0, [...announcementResult.errors, ...announcementErrors], fetchedAt));

  let tree: ContentTreeResult;
  try {
    tree = await readContentTree(api, course.id, { signal: options.signal, traceId: options.traceId, budget: options.budget, maxNodes: options.maxContentNodes, maxDepth: options.maxContentDepth });
  } catch (error) {
    if (isAuthenticationError(error)) throw error;
    errors.push(snapshotError(error, `course:${course.id}:contents`));
    tree = { nodes: [], pages: 0, complete: false, truncated: false, restrictedNodes: 0, errors: [publicApiError(error)] };
  }
  addPublicErrors(errors, tree.errors, `course:${course.id}:contents`);
  const beforeAssignments = assignments.length;
  const beforeFiles = files.length;
  const unknownNodeCount = tree.nodes.filter(node => !node.restricted && node.kind === 'unknown').length;
  const unknownNodeErrors: PublicClassicApiError[] = unknownNodeCount > 0
    ? [publicApiError(new ClassicApiError('API_SCHEMA_CHANGED', `课程包含 ${unknownNodeCount} 个未识别内容 handler；已保留为 unknown 资料项。`, { scope: `course:${course.id}:contents`, retryable: false }))]
    : [];
  if (unknownNodeErrors.length) addPublicErrors(errors, unknownNodeErrors, `course:${course.id}:contents`);
  for (const node of tree.nodes) {
    if (node.restricted) continue;
    const raw = nodeRaw(node, course.id);
    if (isAssignmentNode(node.kind)) {
      try { assignments.push(normalizeAssignment(raw, context)); }
      catch (error) {
        assignmentErrors.push(publicApiError(error));
        errors.push(errorFromNormalization(error, `course:${course.id}:assignments`));
      }
    } else if (isFileNode(node.kind)) {
      try { files.push(normalizeFile(raw, context)); }
      catch (error) {
        fileErrors.push(publicApiError(error));
        errors.push(errorFromNormalization(error, `course:${course.id}:files`));
      }
    }
  }
  coverageEntries.push(coverage(course.id, 'contents', tree.nodes.length, tree.pages, tree.complete && unknownNodeErrors.length === 0, tree.truncated, tree.restrictedNodes, [...tree.errors, ...unknownNodeErrors], fetchedAt));
  coverageEntries.push(coverage(course.id, 'assignments', assignments.length - beforeAssignments, tree.pages, tree.complete, tree.truncated, tree.restrictedNodes, [...tree.errors, ...assignmentErrors], fetchedAt));
  coverageEntries.push(coverage(course.id, 'files', files.length - beforeFiles, tree.pages, tree.complete, tree.truncated, tree.restrictedNodes, [...tree.errors, ...fileErrors], fetchedAt));

  let columns;
  try {
    columns = await api.gradeColumns(options, course.id, { limit: 100 });
    addPublicErrors(errors, columns.errors, `course:${course.id}:grades`);
    gradeErrors.push(...columns.errors);
  } catch (error) {
    if (isAuthenticationError(error)) throw error;
    errors.push(snapshotError(error, `course:${course.id}:grades`));
    const publicError = publicApiError(error);
    gradeErrors.push(publicError);
    columns = { items: [], pages: 0, complete: false, truncated: false, nextPage: null, errors: [publicError] };
  }
  const columnMap = new Map<string, RawGradeColumn>();
  let notContentLinkedColumnCount = 0;
  for (const column of columns.items) {
    const id = rawColumnId(column);
    if (id) columnMap.set(id, column);
  }
  for (const column of columns.items) {
    try {
      const columnRecord = column as RawObject;
      const columnId = rawColumnId(columnRecord);
      const contentId = rawContentId(columnRecord);
      if (!columnId) {
        const missing = publicApiError(new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard 评分列缺少可验证的 columnId，未生成作业。', { scope: `course:${course.id}:grades`, retryable: false }));
        gradeErrors.push(missing);
        errors.push(snapshotError(missing, `course:${course.id}:grades`));
        continue;
      }
      if (!contentId) {
        // contentId is optional for valid manual/calculated/other columns.
        // Keep the column for coverage and grade-column context, but do not
        // invent an assignment or infer what this column represents.
        notContentLinkedColumnCount += 1;
        continue;
      }
      const candidate = addAssignmentFromColumn(column, course.id, context);
      if (!candidate) continue;
      const index = assignmentIndex(assignments).get(`${course.id}\0content\0${candidate.contentId ?? ''}`);
      if (index === undefined) assignments.push(candidate);
      else {
        const existing = assignments[index];
        if (existing) assignments[index] = mergeColumn(existing, candidate);
      }
    } catch (error) {
      assignmentErrors.push(publicApiError(error));
      errors.push(errorFromNormalization(error, `course:${course.id}:assignments`));
    }
  }
  const beforeCalendarErrors = calendarMappingErrors.length;
  applyCalendarDue(calendarItems, course.id, assignments, calendarMappingErrors);
  for (const error of calendarMappingErrors.slice(beforeCalendarErrors)) errors.push(snapshotError(error, `course:${course.id}:calendar`));

  let grades;
  try {
    grades = await api.grades(options, course.id, undefined, { limit: 100 });
    addPublicErrors(errors, grades.errors, `course:${course.id}:grades`);
    gradeErrors.push(...grades.errors);
  } catch (error) {
    if (isAuthenticationError(error)) throw error;
    errors.push(snapshotError(error, `course:${course.id}:grades`));
    const publicError = publicApiError(error);
    gradeErrors.push(publicError);
    grades = { items: [], pages: 0, complete: false, truncated: false, nextPage: null, errors: [publicError] };
  }
  for (const grade of grades.items) {
    const value = grade as RawObject;
    const contentId = gradeContentId(value);
    const columnId = gradeColumnId(value);
    const index = assignmentIndex(assignments).get(contentId ? `${course.id}\0content\0${contentId}` : columnId ? `${course.id}\0column\0${columnId}` : '');
    if (index === undefined) continue;
    try {
      assertSubmissionScope(value, { courseId: course.id, userId: api.account?.userId, columnId, contentId, gradeId: rawId(value, 'gradeId', 'id') });
      const mergedGrade = mergeGrade(assignments[index]!, grade, columnId ? columnMap.get(columnId) : undefined, context);
      const enriched = await readSubmissionHistory(api, grade, course.id, columnId, options, context);
      const mergedHistory = mergeSubmissionSummaries(mergedGrade.assignment.submission, enriched.summary);
      assignments[index] = AssignmentV2Schema.parse({ ...mergedGrade.assignment, submission: mergedHistory.summary });
      gradeErrors.push(...enriched.errors);
      for (const error of enriched.errors) errors.push(snapshotError(error, `course:${course.id}:grades`));
      if (mergedGrade.submissionConflict || mergedHistory.conflict) {
        const conflict = publicApiError(new ClassicApiError('API_SCHEMA_CHANGED', '同一作业的多个评分列提交证据发生冲突，已保留较强证据并标记缺口。', { scope: `course:${course.id}:grades`, retryable: false }));
        gradeErrors.push(conflict);
        errors.push(snapshotError(conflict, `course:${course.id}:grades`));
      }
    }
    catch (error) {
      if (isAuthenticationError(error)) throw error;
      gradeErrors.push(publicApiError(error));
      errors.push(errorFromNormalization(error, `course:${course.id}:grades`));
    }
  }
  debugLog.event('classic.api.course.grades-summary', {
    traceId: options.traceId,
    courseId: course.id,
    columnCount: columns.items.length,
    notContentLinkedColumnCount,
    gradeItemCount: grades.items.length,
    gradeErrorCount: gradeErrors.length,
    columnsComplete: columns.complete,
    gradesComplete: grades.complete,
  });
  coverageEntries.push(coverage(course.id, 'grades', grades.items.length + columns.items.length, grades.pages + columns.pages, grades.complete && columns.complete, grades.truncated || columns.truncated, 0, gradeErrors, fetchedAt));
}

/** Read one complete API snapshot. Days filtering belongs to the UI layer. */
export async function readClassicSnapshot(api: ClassicApiClient, options: ClassicSnapshotReadOptions): Promise<ClassicSnapshotReadResult> {
  const fetchedAt = new Date().toISOString();
  const identity = await api.identity(options);
  const account = api.account;
  if (!account) throw new ClassicApiError('AUTH_REQUIRED', 'Classic 会话缺少已确认的账户上下文。', { scope: 'snapshot.identity', retryable: false });
  const identityUserId = rawId(identity, 'id', 'userId');
  if (!identityUserId || identityUserId !== account.userId) {
    try {
      const markExpired = (api.session as unknown as { markExpired?: () => void }).markExpired;
      markExpired?.call(api.session);
    } catch { /* session expiry is represented by the returned error */ }
    throw new ClassicApiError('SESSION_EXPIRED', 'Classic 身份响应与当前账户不一致，本次结果已丢弃。', { scope: 'snapshot.identity', retryable: false });
  }
  const errors: SnapshotV2['errors'] = [];
  const coverageEntries: CoverageEntry[] = [];
  const courses: SnapshotV2['courses'] = [];
  const announcements: SnapshotV2['announcements'] = [];
  const assignments: AssignmentV2[] = [];
  const files: SnapshotV2['files'] = [];
  let memberships;
  try {
    memberships = await api.memberships(options, { limit: 100 });
  } catch (error) {
    if (isAuthenticationError(error)) throw error;
    errors.push(snapshotError(error, 'courses'));
    memberships = { items: [], pages: 0, complete: false, truncated: false, nextPage: null, errors: [publicApiError(error)] };
  }
  addPublicErrors(errors, memberships.errors, 'courses');
  const maxCourses = options.maxCourses ?? 50;
  if (!Number.isInteger(maxCourses) || maxCourses < 1 || maxCourses > 500) {
    throw new ClassicApiError('BAD_INPUT', 'Classic 课程数量预算无效。', { scope: 'snapshot.courses', retryable: false });
  }
  const courseNormalizationErrors: PublicClassicApiError[] = [];
  const seenCourseIds = new Set<string>();
  for (const value of memberships.items.slice(0, maxCourses)) {
    try {
      const course = normalizeCourse(courseRaw(value), { fetchedAt, source: 'internal-api', traceId: options.traceId, allowClassicFallback: true });
      if (seenCourseIds.has(course.id)) continue;
      seenCourseIds.add(course.id);
      courses.push(course);
    }
    catch (error) {
      const publicError = publicApiError(error);
      courseNormalizationErrors.push(publicError);
      errors.push(errorFromNormalization(error, 'courses'));
    }
  }
  if (memberships.items.length > maxCourses) errors.push({ scope: 'courses', code: 'PARTIAL_RESULTS', message: '课程数量达到本次读取上限。' });
  coverageEntries.push(coverage(null, 'courses', courses.length, memberships.pages, memberships.complete && memberships.items.length <= maxCourses && courseNormalizationErrors.length === 0, memberships.truncated || memberships.items.length > maxCourses, 0, [...memberships.errors, ...courseNormalizationErrors], fetchedAt));
  let calendarResult: PaginatedResult<RawCalendarItem>;
  if (courses.length > 0) {
    const window = calendarWindow(fetchedAt);
    try {
      calendarResult = await api.calendar(options, window.since, window.until, { limit: 100 });
    } catch (error) {
      if (isAuthenticationError(error)) throw error;
      const publicError = publicApiError(error);
      calendarResult = { items: [], pages: 0, complete: false, truncated: false, nextPage: null, errors: [publicError] };
    }
  } else {
    const noCourseError = memberships.complete ? null : publicApiError(new ClassicApiError('PARTIAL_RESULTS', '课程列表未完整读取，日历范围未能关联。', { scope: 'calendar', retryable: false }));
    calendarResult = { items: [], pages: 0, complete: memberships.complete, truncated: false, nextPage: null, errors: noCourseError ? [noCourseError] : [] };
  }
  addPublicErrors(errors, calendarResult.errors, 'calendar');
  const calendarCoverageIndex = coverageEntries.length;
  // Reserve the slot before per-course coverage is appended.  The final
  // calendar coverage must not overwrite the first course's announcement
  // coverage entry when several courses are read.
  coverageEntries.push(coverage(null, 'calendar', 0, 0, false, false, 0, [], fetchedAt));
  const calendarMappingErrors: PublicClassicApiError[] = [];
  const calendarByCourse = new Map<string, RawCalendarItem[]>();
  for (const item of calendarResult.items) {
    const type = rawString((item as RawObject).type)?.toLowerCase();
    const itemCourseId = calendarCourseId(item);
    if (type === 'gradebookcolumn' && !itemCourseId) {
      calendarMappingErrors.push(publicApiError(new ClassicApiError('API_SCHEMA_CHANGED', 'Blackboard GradebookColumn 日历项缺少 courseId。', { scope: 'calendar', retryable: false })));
      continue;
    }
    if (itemCourseId && seenCourseIds.has(itemCourseId)) {
      const values = calendarByCourse.get(itemCourseId) ?? [];
      values.push(item);
      calendarByCourse.set(itemCourseId, values);
    }
  }
  for (const error of calendarMappingErrors) errors.push(snapshotError(error, 'calendar'));

  let successfulCourseReads = 0;
  for (const course of courses) {
    const coverageBefore = coverageEntries.length;
    await readCourse(api, course, options, fetchedAt, errors, coverageEntries, assignments, announcements, files, calendarByCourse.get(course.id) ?? [], calendarMappingErrors);
    const courseCoverage = coverageEntries.slice(coverageBefore).filter(entry => entry.courseId === course.id);
    if (courseCoverage.some(entry => entry.state === 'complete' || (entry.state === 'partial' && entry.received > 0))) successfulCourseReads += 1;
  }
  coverageEntries[calendarCoverageIndex] = coverage(null, 'calendar', calendarResult.items.length, calendarResult.pages, calendarResult.complete && calendarMappingErrors.length === 0, calendarResult.truncated, 0, [...calendarResult.errors, ...calendarMappingErrors], fetchedAt);
  // Recheck the real account inside the same 300-request budget.  The
  // session generation alone cannot reveal a browser-side account switch
  // while the in-memory session still holds the old account context.
  const finalIdentity = await api.identity({ ...options, allowReservedBudget: true });
  const finalUserId = rawId(finalIdentity, 'id', 'userId');
  if (!finalUserId || finalUserId !== account.userId || api.account?.userId !== account.userId) {
    try {
      const markExpired = (api.session as unknown as { markExpired?: () => void }).markExpired;
      markExpired?.call(api.session);
    } catch { /* session expiry is represented by the returned error */ }
    throw new ClassicApiError('SESSION_EXPIRED', 'Classic 身份在同步结束时发生变化，本次结果已丢弃。', { scope: 'snapshot.identity.final', retryable: false });
  }
  const hasSuccessfulCoreRange = courses.length === 0 ? memberships.complete && memberships.errors.length === 0 : successfulCourseReads > 0;
  const state: SnapshotV2['state'] = errors.length === 0 ? 'ok' : hasSuccessfulCoreRange ? 'partial' : 'error';
  const snapshot = SnapshotV2Schema.parse({ schemaVersion: 2, state, fetchedAt, timezone: 'Asia/Shanghai', source: options.source ?? 'live', courses, announcements, assignments, files, coverage: coverageEntries, errors });
  return { snapshot, accountUserId: account.userId };
}
