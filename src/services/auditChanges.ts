export type AuditSnapshot = Record<string, string | number | boolean | null>;
export function auditChanges(before: AuditSnapshot | null, after: AuditSnapshot | null) {
 const changes: Record<string,{before:unknown;after:unknown}> = {};
 for(const key of new Set([...Object.keys(before || {}),...Object.keys(after || {})])) {
  const oldValue=before?.[key] ?? null, newValue=after?.[key] ?? null;
  if(oldValue !== newValue) changes[key]={before:oldValue,after:newValue};
 }
 return changes;
}
