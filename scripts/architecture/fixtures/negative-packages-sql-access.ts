// Negative fixture: shared package SQL reaching a managed foreign schema.
// architecture:test expects detectBoundaryViolations to flag this sample.

export async function leak(db) {
  return db.query("select id from foreign.records limit 1");
}
