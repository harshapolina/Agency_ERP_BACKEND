import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, days, startApp, type TestApp } from './helpers.js';

let t: TestApp;
let admin: Api;
let meId: string;
let pid: string;

beforeAll(async () => {
  t = await startApp();
  admin = await t.api.login('admin');
  const me = await admin.ok(admin.get('/auth/me'));
  meId = me.id ?? me._id;
});
afterAll(() => t?.close());

describe('projects', () => {
  it('creates a project with default milestones and a workspace', async () => {
    const project = await admin.ok(admin.post('/projects', { name: 'Delivery', status: 'planned', seedMilestones: true, priority: 'high' }));
    pid = project._id;
    const ws = await admin.ok(admin.get(`/projects/${pid}/workspace`));
    expect(ws).toBeTruthy();
    await admin.ok(admin.post(`/projects/${pid}/milestones`, { name: 'Extra', weight: 10 }));
    await admin.ok(admin.post(`/projects/${pid}/updates`, { title: 'Kickoff', body: 'Started', visibleToClient: true }));
    expect(JSON.stringify(await admin.ok(admin.get('/projects')))).toContain('Delivery');
  });
});

describe('tasks', () => {
  let t1: any;
  let t2: any;

  beforeAll(async () => {
    [t1, t2] = await Promise.all([
      admin.ok(admin.post('/tasks', { title: 'Design', projectId: pid, assignedTo: meId, priority: 'high', dueDate: days(1) })),
      admin.ok(admin.post('/tasks', { title: 'Build', projectId: pid, assignedTo: meId })),
    ]);
    await admin.ok(admin.post(`/tasks/${t2._id}/dependencies`, { dependsOnTaskId: t1._id }));
  });

  it('rejects dependency cycles', async () => {
    expect((await admin.post(`/tasks/${t1._id}/dependencies`, { dependsOnTaskId: t2._id })).status).toBe(400);
  });

  it('blocks a task until its dependencies are complete', async () => {
    expect((await admin.post(`/tasks/${t2._id}/status`, { status: 'in_progress' })).status).toBe(400);
  });

  it('tracks time, comments and completion, then unblocks dependants', async () => {
    await admin.ok(admin.post(`/tasks/${t1._id}/start`));
    await admin.ok(admin.post(`/tasks/${t1._id}/pause`));
    await admin.ok(admin.post(`/tasks/${t1._id}/comments`, { message: 'hello @admin@test.local' }));
    await admin.ok(admin.post(`/tasks/${t1._id}/status`, { status: 'completed' }));
    await admin.ok(admin.post(`/tasks/${t2._id}/status`, { status: 'in_progress' }));
    const details = await admin.ok(admin.get(`/tasks/${t1._id}/details`));
    expect(JSON.stringify(details)).toContain('hello');
    await admin.ok(admin.get('/tasks?view=my'));
  });
});

describe('meetings and documents', () => {
  it('records a meeting and stores a document', async () => {
    await admin.ok(admin.post('/meetings', { title: 'Sync', projectId: pid, startsAt: new Date().toISOString(), actionItems: 'Send deck' }));
    await admin.ok(admin.post('/documents', {
      title: 'Brief', projectId: pid, fileName: 'a.txt', mimeType: 'text/plain', dataBase64: Buffer.from('hi').toString('base64'), visibleToClient: true,
    }));
  });
});
