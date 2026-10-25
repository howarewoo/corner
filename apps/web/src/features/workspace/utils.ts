import type { Macros } from '@packages/nutrition/types';
import { Activity, Dumbbell, Leaf } from 'lucide-react';

export const macroNames: Record<keyof Macros, string> = {
  calories: 'Calories',
  protein: 'Protein',
  carbs: 'Carbs',
  fat: 'Fat',
};
export const num = (n: number, decimals = 0) =>
  Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: decimals }) : '0';
export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const formatDate = (date: string, options: Intl.DateTimeFormatOptions) =>
  new Date(`${date}T12:00:00`).toLocaleDateString('en-US', options);
export const newId = () => {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
export const activityLabel = (activity: string) =>
  /box/i.test(activity)
    ? 'Boxing day'
    : /lift|strength/i.test(activity)
      ? 'Strength day'
      : /rest|recover/i.test(activity)
        ? 'Recovery day'
        : cap(activity || 'Training');
export const activityIcon = (activity: string) =>
  /box/i.test(activity) ? Activity : /lift|strength/i.test(activity) ? Dumbbell : Leaf;
export const zero: Macros = { calories: 0, protein: 0, carbs: 0, fat: 0 };

export function download(text: string, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
