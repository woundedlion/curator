import { normalizeForLuceneLiteral } from "../metadata/normalizers";

type QueryFields = {
  title?: string;
  artist?: string;
  album?: string;
};

function clause(field: string, value: string | undefined): string | null {
  const cleaned = normalizeForLuceneLiteral(value);
  if (!cleaned) return null;
  return `${field}:"${cleaned}"`;
}

export function buildRecordingQuery(fields: QueryFields): string {
  // Intentionally omits album: release titles vary across remasters,
  // deluxe editions, and regional reissues, so requiring an exact
  // release-phrase match collapses to zero results too often. Album
  // is still used by the candidate scorer to rank ties.
  const clauses = [
    clause("recording", fields.title),
    clause("artist", fields.artist),
  ].filter((part): part is string => part !== null);
  return clauses.join(" AND ");
}
