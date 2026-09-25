// Migrations are bundled as text (the `Text` rule in wrangler.jsonc).
declare module "*.sql" {
  const sql: string;
  export default sql;
}
