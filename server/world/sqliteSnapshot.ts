import { Buffer } from 'node:buffer';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';

type SqliteCell =
  | { kind: 'null' }
  | { kind: 'integer'; value: string }
  | { kind: 'real'; bits: string }
  | { kind: 'text'; bytes: string }
  | { kind: 'blob'; bytes: string };

export type SqliteTableSnapshot =
  | {
      kind: 'rowid';
      rowidColumn: string;
      columns: string[];
      rows: { rowid: string; values: SqliteCell[] }[];
    }
  | {
      kind: 'without-rowid';
      columns: string[];
      rows: { values: SqliteCell[] }[];
    };

export function sqliteText(value: string): SqliteCell {
  return { kind: 'text', bytes: Buffer.from(value, 'utf8').toString('hex') };
}

/** SQL identifiers and parsed world JSON must survive the UTF-8 boundary exactly. */
export function readSqliteText(
  value: SQLOutputValue | undefined,
  bytes: SQLOutputValue | undefined
): string {
  if (
    typeof value !== 'string' ||
    !(bytes instanceof Uint8Array) ||
    !Buffer.from(value, 'utf8').equals(bytes)
  ) {
    throw new Error('Unsupported SQLite text encoding');
  }
  return value;
}

function identifier(value: string): string {
  if (value.includes('\0')) {
    throw new Error('Unsupported SQLite identifier');
  }
  return `"${value.replaceAll('"', '""')}"`;
}

/** sqlite_sequence is internal, but its counters are application identity state. */
export function readSqliteCatalog(db: DatabaseSync) {
  return db
    .prepare(
      `SELECT type,name,tbl_name,sql,
        CAST(type AS BLOB) AS typeBytes,CAST(name AS BLOB) AS nameBytes,
        CAST(tbl_name AS BLOB) AS tableBytes,CAST(sql AS BLOB) AS sqlBytes
       FROM sqlite_master
       WHERE substr(lower(name),1,7) <> 'sqlite_' OR lower(name)='sqlite_sequence'
       ORDER BY type,name`
    )
    .all()
    .map((row) => ({
      type: readSqliteText(row['type'], row['typeBytes']),
      name: readSqliteText(row['name'], row['nameBytes']),
      tbl_name: readSqliteText(row['tbl_name'], row['tableBytes']),
      sql: row['sql'] === null ? null : readSqliteText(row['sql'], row['sqlBytes']),
    }));
}

function cell(
  kind: SQLOutputValue | undefined,
  value: SQLOutputValue | undefined,
  bytes: SQLOutputValue | undefined
): SqliteCell {
  switch (kind) {
    case 'null':
      if (value === null) {
        return { kind: 'null' };
      }
      break;
    case 'integer':
      if (typeof value === 'bigint') {
        return { kind: 'integer', value: value.toString() };
      }
      break;
    case 'real':
      if (typeof value === 'number') {
        const ieee754 = Buffer.alloc(8);
        ieee754.writeDoubleBE(value);
        return { kind: 'real', bits: ieee754.toString('hex') };
      }
      break;
    case 'text':
    case 'blob':
      if (bytes instanceof Uint8Array) {
        return { kind, bytes: Buffer.from(bytes).toString('hex') };
      }
      break;
    default:
      throw new Error('Unsupported SQLite storage class');
  }
  throw new Error('Unsupported SQLite scalar value');
}

function sorted<Row>(rows: Row[]): Row[] {
  return rows.sort((left, right) => {
    const a = JSON.stringify(left);
    const b = JSON.stringify(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

export function canonicalSqliteTable(
  table: Extract<SqliteTableSnapshot, { kind: 'rowid' }>
): Extract<SqliteTableSnapshot, { kind: 'rowid' }>;
export function canonicalSqliteTable(
  table: Extract<SqliteTableSnapshot, { kind: 'without-rowid' }>
): Extract<SqliteTableSnapshot, { kind: 'without-rowid' }>;
export function canonicalSqliteTable(table: SqliteTableSnapshot): SqliteTableSnapshot;
export function canonicalSqliteTable(table: SqliteTableSnapshot): SqliteTableSnapshot {
  return table.kind === 'rowid'
    ? { ...table, rows: sorted(table.rows) }
    : { ...table, rows: sorted(table.rows) };
}

/** Capture SQL-visible values and row identity without coercing SQLite storage classes. */
export function readSqliteTable(db: DatabaseSync, name: string): SqliteTableSnapshot {
  const info = db
    .prepare("SELECT type,wr FROM pragma_table_list WHERE schema='main' AND name=?")
    .get(name);
  if (info?.['type'] !== 'table' || (info['wr'] !== 0 && info['wr'] !== 1)) {
    throw new Error('Unsupported SQLite virtual or shadow table');
  }
  const metadata = db
    .prepare(
      "SELECT name,CAST(name AS BLOB) AS bytes,hidden FROM pragma_table_xinfo(?,'main') ORDER BY cid"
    )
    .all(name);
  if (!metadata.length || metadata.some((column) => column['hidden'] !== 0)) {
    throw new Error('Unsupported SQLite generated or hidden column');
  }
  const columns = metadata.map((column) => readSqliteText(column['name'], column['bytes']));
  const names = new Set(columns.map((column) => column.toLowerCase()));
  const rowidColumn = ['rowid', '_rowid_', 'oid'].find((column) => !names.has(column));
  if (info['wr'] === 0 && !rowidColumn) {
    throw new Error('Unsupported SQLite inaccessible row identity');
  }
  const projection = columns.flatMap((column, index) => [
    `typeof(${identifier(column)}) AS "t${index}"`,
    `${identifier(column)} AS "v${index}"`,
    `CAST(${identifier(column)} AS BLOB) AS "b${index}"`,
  ]);
  const statement = db.prepare(
    `SELECT ${info['wr'] === 0 && rowidColumn ? `${identifier(rowidColumn)} AS identity,` : ''}${projection.join(',')} FROM ${identifier(name)}`
  );
  statement.setReadBigInts(true);
  const rows = statement.all();
  const values = (row: Record<string, SQLOutputValue>) =>
    columns.map((_, index) => cell(row[`t${index}`], row[`v${index}`], row[`b${index}`]));
  if (info['wr'] === 0 && rowidColumn) {
    return {
      kind: 'rowid',
      rowidColumn,
      columns,
      rows: sorted(
        rows.map((row) => {
          const id = row['identity'];
          if (typeof id !== 'bigint') {
            throw new Error('Unsupported SQLite row identity');
          }
          return { rowid: id.toString(), values: values(row) };
        })
      ),
    };
  }
  return {
    kind: 'without-rowid',
    columns,
    rows: sorted(rows.map((row) => ({ values: values(row) }))),
  };
}
