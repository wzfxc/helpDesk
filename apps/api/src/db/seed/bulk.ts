import type { PoolClient } from 'pg';

export type Column<Row> = [name: string, pgType: string, get: (row: Row) => unknown];

/**
 * Fast multi-row insert: one `INSERT … SELECT FROM unnest($1::type[], …)` per chunk.
 * Far fewer round-trips and parameters than VALUES lists.
 */
export async function bulkInsert<Row>(
  client: PoolClient,
  table: string,
  columns: Column<Row>[],
  rows: readonly Row[],
  chunkSize = 5000,
): Promise<void> {
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const params = columns.map(([, type, get]) =>
      chunk.map((row) => {
        const value = get(row);
        // Arrays inside arrays must be passed as postgres array literals for unnest.
        if (type === 'text[]' && Array.isArray(value)) return toPgArrayLiteral(value as string[]);
        return value;
      }),
    );
    const names = columns.map(([name]) => `"${name}"`).join(', ');
    const unnest = columns
      .map(([, type], idx) =>
        type === 'text[]' ? `$${idx + 1}::text[]` : `$${idx + 1}::${type}[]`,
      )
      .join(', ');
    const select = columns
      .map(([name, type]) => (type === 'text[]' ? `"${name}"::text[]` : `"${name}"`))
      .join(', ');
    await client.query(
      `insert into ${table} (${names}) select ${select} from unnest(${unnest}) as t(${names})`,
      params,
    );
  }
}

function toPgArrayLiteral(values: readonly string[]): string {
  return `{${values.map((v) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`;
}
