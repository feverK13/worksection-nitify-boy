import type { EmployeeRow } from "./supabaseClient";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Strategy 1: mentions rendered as profile links, e.g. <a href=".../profile/123">
function profileLinkIds(text: string): Set<string> {
  const ids = new Set<string>();
  for (const match of text.matchAll(/profile\/(\d+)/g)) {
    ids.add(match[1]);
  }
  return ids;
}

// Strategy 2: text patterns @Ім'я / @Ім'я_Прізвище matched (fuzzily) against full_name
function matchesTextMention(text: string, fullName: string): boolean {
  const name = fullName.trim();
  if (!name) return false;
  const variants = new Set<string>([name, name.replace(/\s+/g, "_")]);
  const firstWord = name.split(/\s+/)[0];
  if (firstWord) variants.add(firstWord);
  return [...variants].some((variant) =>
    new RegExp(`@${escapeRegExp(variant)}(?![\\p{L}\\p{N}])`, "iu").test(text)
  );
}

// The exact mention format is undocumented, so both strategies run at once
// and the results are merged (spec §5). Unmatched '@' in real data gets
// logged so the patterns can be calibrated from production payloads.
export function resolveMentions(
  rawText: string | null | undefined,
  employees: EmployeeRow[]
): EmployeeRow[] {
  if (!rawText) return [];
  const plain = rawText.replace(/<[^>]+>/g, " ");
  const linkedIds = profileLinkIds(rawText);
  const found = new Map<number, EmployeeRow>();

  for (const emp of employees) {
    if (emp.ws_user_id && linkedIds.has(emp.ws_user_id)) {
      found.set(emp.id, emp);
      continue;
    }
    if (
      emp.full_name &&
      (matchesTextMention(rawText, emp.full_name) || matchesTextMention(plain, emp.full_name))
    ) {
      found.set(emp.id, emp);
    }
  }

  if (found.size === 0 && plain.includes("@")) {
    console.log("mentionParser: '@' present but no employee matched. Raw text:", rawText);
  }
  return [...found.values()];
}
