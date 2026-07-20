import type { EmployeeRow } from "./supabaseClient";

// Real Worksection payloads store an @-mention as the bare full name inside
// the comment/task text — no '@', no HTML link (see production samples).
// So a mention is simply the employee's full_name appearing as a substring,
// case-insensitive.
export function resolveMentions(
  rawText: string | null | undefined,
  employees: EmployeeRow[]
): EmployeeRow[] {
  if (!rawText || !rawText.trim()) return [];
  const textLower = rawText.toLowerCase();
  const found: EmployeeRow[] = [];
  for (const emp of employees) {
    const name = emp.full_name?.trim();
    if (name && textLower.includes(name.toLowerCase())) {
      found.push(emp);
    }
  }
  return found;
}
