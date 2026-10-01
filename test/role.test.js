import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isStudent } from '../src/api.js';

const mk = (u, extra = {}) => ({
  lmsUser: { id: 7, role_id: 2, status: 1, ...u },
  parentUser: null,
  ...extra,
});

test('isStudent: пропускає лише однозначного учня', () => {
  assert.equal(isStudent(mk({}), 7), true);
  assert.equal(isStudent(mk({}, { menuSettings: [{ uid: 'student_calendar' }] }), '7'), true);
});

test('isStudent: вчитель, адміністратор, невідома роль — відмова', () => {
  assert.equal(isStudent(mk({ role_id: 3 })), false); // викладач
  assert.equal(isStudent(mk({ role_id: 7 })), false); // адміністратор
  assert.equal(isStudent(mk({ role_id: 100 })), false);
  assert.equal(isStudent(mk({ role_id: 0 })), false);
  assert.equal(isStudent(mk({ role_id: '2' })), false); // рядок — не однозначно
  assert.equal(isStudent(mk({ role_id: undefined })), false);
});

test('isStudent: порожньо, сміття, null — відмова (fail closed)', () => {
  for (const bad of [
    undefined,
    null,
    {},
    [],
    'x',
    5,
    { lmsUser: null },
    { lmsUser: 'student' },
    { globalUser: { role_id: 2 } },
  ])
    assert.equal(isStudent(bad), false);
});

test('isStudent: батьки, неактивний запис, чужий uid, меню вчителя — відмова', () => {
  assert.equal(isStudent(mk({}, { parentUser: { id: 1 } })), false);
  assert.equal(isStudent(mk({ status: 2 })), false);
  assert.equal(isStudent(mk({}), 8), false);
  assert.equal(isStudent(mk({}, { menuSettings: [{ uid: 'teacher_calendar' }] })), false);
  assert.equal(
    isStudent(mk({}, { menuSettings: [{ uid: 'student_calendar' }, { uid: 'teacher_home' }] })),
    false,
  );
});
