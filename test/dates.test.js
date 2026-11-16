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
