// Tiny {placeholder} interpolation helper shared by the import wizard components (same pattern as
// the local `tf` helpers in other pages, e.g. src/pages/ProductManagement.tsx).
export function tf(str: string, vars: Record<string, string | number>): string {
  return str.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
}
