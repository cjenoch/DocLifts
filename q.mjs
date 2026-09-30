
import postgres from 'postgres';
const c=postgres(process.env.URL,{max:1,onnotice:()=>{}});
const [t]=await c`select name, equipment_type from exercises limit 40`;
console.log('starter rows in db:',t.length);
const [bad]=await c`select conname, pg_get_constraintdef(oid) d from pg_constraint where conrelid='exercises'::regclass and contype='c'`;
console.log(JSON.stringify(bad,null,1));
const [nn]=await c`select column_name,is_nullable from information_schema.columns where table_name='exercises' and is_nullable='NO'`;
console.log('NOT NULL cols:',nn.map(x=>x.column_name).join(','));
await c.end();
