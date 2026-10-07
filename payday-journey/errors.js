export class NotConfiguredError extends Error {
  constructor(slot, what) {
    super(`${slot}: ${what} is not configured. See payday-journey/README.md, "Plugging in a vendor".`);
    this.name = 'NotConfiguredError';
  }
}

// Vendor HTTP failures. The message never contains request or response bodies or headers,
// because those carry PII and credentials.
export class VendorHttpError extends Error {
  constructor(vendor, slot, detail, status = null) {
    super(`${vendor} ${slot} failed: ${detail}`);
    this.name = 'VendorHttpError';
    this.status = status;
  }
}

// A request that is understood but not allowed right now (wrong status, open loan, rule violated).
// The API answers these with 409; anything else is a real failure.
export class BusinessRuleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BusinessRuleError';
  }
}
