// Paid Add-On license gating for OmniPulse OR (mirrors isOnlineLicenseValid in server/commerce.ts).
import { db } from "../db.js";

export interface OrLicenseStatus {
  licensed: boolean;
  license_type: "none" | "monthly" | "year" | "lifetime";
  license_expiry: string | null;
}

export function getOrLicenseStatus(tenantId: number | string): OrLicenseStatus {
  const row = db
    .prepare("SELECT or_license_type, or_license_expiry FROM tenants WHERE id = ?")
    .get(tenantId) as { or_license_type?: string | null; or_license_expiry?: string | null } | undefined;

  const rawType = (row?.or_license_type || "none") as OrLicenseStatus["license_type"];
  const expiry = row?.or_license_expiry ? String(row.or_license_expiry) : null;

  if (!row || rawType === "none") {
    return { licensed: false, license_type: "none", license_expiry: expiry };
  }
  if (rawType === "lifetime") {
    return { licensed: true, license_type: "lifetime", license_expiry: expiry };
  }
  if (!expiry) {
    return { licensed: false, license_type: rawType, license_expiry: null };
  }
  const parsed = Date.parse(
    /(Z|[+-]\d{2}:?\d{2})$/.test(expiry) ? expiry : expiry.replace(" ", "T") + "Z"
  );
  const valid = Number.isFinite(parsed) && parsed > Date.now();
  return { licensed: valid, license_type: rawType, license_expiry: expiry };
}

export function isOrLicenseValid(tenantId: number | string): boolean {
  return getOrLicenseStatus(tenantId).licensed;
}

/** Express middleware that gates all /api/or/* operational endpoints behind an active OR add-on license. */
export function requireOrLicense(req: any, res: any, next: any) {
  const tenantId = req.session?.tenantId;
  if (!tenantId) return res.status(401).json({ error: "Unauthorized" });
  const status = getOrLicenseStatus(tenantId);
  if (!status.licensed) {
    return res.status(403).json({
      error: "OmniPulse OR is a paid add-on module. Contact your administrator to activate it.",
      code: "OR_LICENSE_REQUIRED",
      or_license: status,
    });
  }
  next();
}
