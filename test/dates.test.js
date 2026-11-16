import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cycleStart, cycleEnd, cycleLabel, salaryCycleStart, dayType, todayJakarta, isValidDate,
} from '../src/lib/dates.js';

test('cycleStart mengikuti contoh di schema.sql', () => {
  assert.equal(cycleStart('2026-12-16'), '2026-11-25');
  assert.equal(cycleStart('2026-12-25'), '2026-12-25');
  assert.equal(cycleStart('2026-12-24'), '2026-11-25');
});

test('cycleStart melewati pergantian tahun', () => {
  assert.equal(cycleStart('2027-01-10'), '2026-12-25');
  assert.equal(cycleStart('2026-01-03'), '2025-12-25');
});

test('cycleEnd dan label', () => {
  assert.equal(cycleEnd('2026-11-25'), '2026-12-24');
  assert.equal(cycleEnd('2026-12-25'), '2027-01-24');
  assert.equal(cycleLabel('2026-11-25'), '25 Nov – 24 Des 2026');
  assert.equal(cycleLabel('2026-12-25'), '25 Des – 24 Jan 2027');
});

test('gaji masuk siklus bulan gajiannya (contoh SPEC.md)', () => {
  assert.equal(salaryCycleStart('2025-08-24'), '2025-08-25');
  assert.equal(salaryCycleStart('2025-10-04'), '2025-09-25');
  assert.equal(salaryCycleStart('2025-08-25'), '2025-08-25');
  assert.equal(salaryCycleStart('2025-12-31'), '2025-12-25');
});

test('dayType: Senin–Jumat hari kerja', () => {
  assert.equal(dayType('2026-11-16'), 'weekday'); // Senin
  assert.equal(dayType('2026-11-20'), 'weekday'); // Jumat
  assert.equal(dayType('2026-11-21'), 'weekend'); // Sabtu
  assert.equal(dayType('2026-11-22'), 'weekend'); // Minggu
});

test('todayJakarta memakai UTC+7', () => {
  assert.equal(todayJakarta(new Date('2026-11-16T16:59:00Z')), '2026-11-16');
  assert.equal(todayJakarta(new Date('2026-11-16T17:00:00Z')), '2026-11-17');
});

test('isValidDate menolak tanggal mustahil', () => {
  assert.equal(isValidDate('2026-02-30'), false);
  assert.equal(isValidDate('2026-2-3'), false);
  assert.equal(isValidDate('2028-02-29'), true);
});

import { billDueDate } from '../src/lib/dates.js';

test('billDueDate selalu jatuh di dalam siklusnya', () => {
  assert.equal(billDueDate('2026-11-25', 22), '2026-12-22');
  assert.equal(billDueDate('2026-11-25', 1), '2026-12-01');
  assert.equal(billDueDate('2026-11-25', 24), '2026-12-24');
  assert.equal(billDueDate('2026-11-25', 25), '2026-11-25');
  assert.equal(billDueDate('2026-11-25', 28), '2026-11-28');
  assert.equal(billDueDate('2026-11-25', 31), '2026-11-30');
  assert.equal(billDueDate('2026-12-25', 10), '2027-01-10');
  assert.equal(billDueDate('2027-01-25', 31), '2027-01-31');
  for (let dom = 1; dom <= 31; dom++) {
    for (const start of ['2026-01-25', '2026-02-25', '2027-12-25']) {
      const d = billDueDate(start, dom);
      assert.equal(cycleStart(d), start, `${start} due ${dom} -> ${d}`);
    }
  }
});

import { addDays } from '../src/lib/dates.js';

test('addDays melewati bulan dan tahun', () => {
  assert.equal(addDays('2026-11-16', 28), '2026-12-14');
  assert.equal(addDays('2026-12-20', 28), '2027-01-17');
  assert.equal(addDays('2028-02-01', 28), '2028-02-29');
});
