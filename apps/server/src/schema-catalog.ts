import type { PoolClient } from 'pg';

export const quoteIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const quote = quoteIdentifier;
function need(condition: unknown): asserts condition {
  if (!condition) throw new Error('SCHEMA_BASELINE_REFUSED');
}
// Deliberately bounded to the application's plain tables, built-in types and btree indexes.
// Migration metadata is validated separately, never treated as application schema.
export async function applicationCatalog(client: PoolClient, schema: string): Promise<string> {
  const excluded = ['__drizzle_migrations', '__drizzle_migrations_id_seq'];
  const unsupported = await client.query(
    `SELECT
    EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relname <> ALL($2::text[]) AND (c.relkind NOT IN ('r','i') OR c.relispartition OR c.relrowsecurity OR c.relforcerowsecurity OR c.reloptions IS NOT NULL OR c.reltablespace<>0 OR c.relacl IS NOT NULL)) OR
    EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1) OR
    EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname=$1 AND NOT
      (t.typtype='c' AND EXISTS (SELECT 1 FROM pg_class c WHERE c.oid=t.typrelid AND c.relkind='r') OR
       t.typelem<>0 AND EXISTS (SELECT 1 FROM pg_type b JOIN pg_class c ON c.oid=b.typrelid WHERE b.oid=t.typelem AND b.typtype='c' AND c.relkind='r'))) OR
    EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1) OR
    EXISTS (SELECT 1 FROM pg_rewrite r JOIN pg_class c ON c.oid=r.ev_class JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1) OR
    EXISTS (SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1) OR
    EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname=$1 AND c.contype NOT IN ('p','u','n')) OR
    EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_type t ON t.oid=a.atttypid JOIN pg_namespace tn ON tn.oid=t.typnamespace
      WHERE n.nspname=$1 AND c.relkind='r' AND a.attnum>0 AND (a.attisdropped OR a.attidentity<>'' OR a.attgenerated<>'' OR a.atthasmissing OR a.attacl IS NOT NULL OR tn.nspname<>'pg_catalog' OR EXISTS (SELECT 1 FROM pg_collation co JOIN pg_namespace cn ON cn.oid=co.collnamespace WHERE co.oid=a.attcollation AND cn.nspname<>'pg_catalog'))) OR
    EXISTS (SELECT 1 FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1) OR
    EXISTS (SELECT 1 FROM pg_statistic_ext s JOIN pg_namespace n ON n.oid=s.stxnamespace WHERE n.nspname=$1) OR
    EXISTS (SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE n.nspname=$1) OR
    EXISTS (SELECT 1 FROM pg_default_acl a JOIN pg_namespace n ON n.oid=a.defaclnamespace WHERE n.nspname=$1 AND NOT
      (current_setting('neon.branch_id', true) IS NOT NULL AND
       pg_get_userbyid(a.defaclrole)='cloud_admin' AND a.defaclobjtype IN ('r','S') AND NOT EXISTS
       (SELECT 1 FROM aclexplode(a.defaclacl) acl WHERE pg_get_userbyid(acl.grantor)<>'cloud_admin' OR
        pg_get_userbyid(acl.grantee)<>'neon_superuser' OR NOT acl.is_grantable))) OR
    EXISTS (SELECT 1 FROM pg_collation c JOIN pg_namespace n ON n.oid=c.collnamespace WHERE n.nspname=$1) OR
    EXISTS (SELECT 1 FROM pg_operator o JOIN pg_namespace n ON n.oid=o.oprnamespace WHERE n.nspname=$1) OR
    EXISTS (SELECT 1 FROM pg_opclass o JOIN pg_namespace n ON n.oid=o.opcnamespace WHERE n.nspname=$1) OR
    EXISTS (SELECT 1 FROM pg_opfamily o JOIN pg_namespace n ON n.oid=o.opfnamespace WHERE n.nspname=$1) OR
    EXISTS (SELECT 1 FROM pg_conversion c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname=$1) OR
    EXISTS (SELECT 1 FROM pg_ts_config c JOIN pg_namespace n ON n.oid=c.cfgnamespace WHERE n.nspname=$1) OR
    EXISTS (SELECT 1 FROM pg_ts_dict d JOIN pg_namespace n ON n.oid=d.dictnamespace WHERE n.nspname=$1) OR
    EXISTS (SELECT 1 FROM pg_ts_parser p JOIN pg_namespace n ON n.oid=p.prsnamespace WHERE n.nspname=$1) OR
    EXISTS (SELECT 1 FROM pg_ts_template t JOIN pg_namespace n ON n.oid=t.tmplnamespace WHERE n.nspname=$1) AS unsupported`,
    [schema, excluded],
  );
  need(!unsupported.rows[0].unsupported);
  await client.query(`SET LOCAL search_path TO ${quote(schema)}, pg_catalog`);
  const queries = [
    `SELECT c.relname,c.relkind,c.relpersistence,c.relreplident,am.amname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_am am ON am.oid=c.relam WHERE n.nspname=$1 AND c.relname <> ALL($2::text[]) AND NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid WHERE i.indexrelid=c.oid AND t.relname = ANY($2::text[])) ORDER BY c.relname`,
    `SELECT c.relname,a.attnum,a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,a.attstorage,a.attcompression,co.collname,pg_get_expr(d.adbin,d.adrelid) AS default_value FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum LEFT JOIN pg_collation co ON co.oid=a.attcollation WHERE n.nspname=$1 AND c.relkind='r' AND c.relname <> ALL($2::text[]) AND a.attnum>0 ORDER BY c.relname,a.attnum`,
    `SELECT t.relname,c.conname,c.contype,c.condeferrable,c.condeferred,c.convalidated,pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=$1 AND t.relname <> ALL($2::text[]) ORDER BY t.relname,c.conname`,
    `SELECT t.relname,c.relname AS index_name,i.indisunique,i.indisprimary,i.indisvalid,i.indisready,i.indislive,i.indisreplident,i.indnullsnotdistinct,replace(pg_get_indexdef(i.indexrelid), ' ON ' || quote_ident($1) || '.', ' ON ') AS definition FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=$1 AND t.relname <> ALL($2::text[]) ORDER BY t.relname,c.relname`,
  ];
  const result = [];
  for (const sql of queries) result.push((await client.query(sql, [schema, excluded])).rows);
  return JSON.stringify(result);
}
