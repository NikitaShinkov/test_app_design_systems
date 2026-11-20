// antd-register: crypto.argon2 exists only in Node.js >= 24.7 and is used only for named-account passwords. Read it
// from the namespace so the server also starts on older Node versions in local-review mode (the only mode used here).
import * as nodeCrypto from 'node:crypto';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
const argon2 = nodeCrypto.argon2;
import { promisify } from 'node:util';
import {isIP} from 'node:net';
import {normalize} from './normalization.js';
import {copyAuditContext} from './audit-provenance.js';
import {serializeEventProvenance} from './audit-writer.js';

const derive = argon2 ? promisify(argon2) : async () => { throw new Error('Named accounts need Node.js 24.7 or newer (crypto.argon2).'); };
const digest = value => createHash('sha256').update(value).digest('hex');
const roles = new Set(['ADMINISTRATOR', 'SUPPLIER', 'CLIENT']);
const namedSession=Symbol('named request session');
function bindNamedSession(context,binding){Object.defineProperty(context,namedSession,{value:binding,enumerable:false});return context;}
const sessionReleaseKey=tokenHash=>(-1n-(BigInt('0x'+digest('session-release:'+tokenHash).slice(0,16))&((1n<<63n)-1n))).toString();
export async function lockNamedReleaseAccount(client,context){
  const binding=context?.[namedSession];if(!binding)return;
  // Follow the preparation/moderation lock order before taking file locks.
  // Do not lock the session yet: logout may complete while a file read waits.
  await client.query('select pg_advisory_xact_lock_shared(78742002)');
  await client.query('select user_id from replacement_register.users where user_id=$1 for share',[binding.userId]);
}
export async function currentNamedReleaseContext(client,context){
  const binding=context?.[namedSession];if(!binding)return context;
  await client.query('select pg_advisory_xact_lock_shared($1::bigint)',[sessionReleaseKey(binding.tokenHash)]);
  const row=(await client.query(`select u.*,coalesce((select json_agg(a.order_no) from replacement_register.user_order_access a where a.user_id=u.user_id),'[]') as orders
    from replacement_register.users u join replacement_register.sessions s using(user_id)
    where u.user_id=$1 and s.token_hash=$2 and s.expires_at>clock_timestamp() and u.enabled
    for share of u`,[binding.userId,binding.tokenHash])).rows[0];
  if(!row)throw httpError(401,'Sign in to continue.',{code:'AUTHENTICATION_REQUIRED'});
  if(row.must_change_password)throw httpError(403,'Change your temporary password before continuing.',{code:'PASSWORD_CHANGE_REQUIRED'});
  const user=publicUser(row);return bindNamedSession(copyAuditContext(context,{...context,...user,actor:user.displayName,authenticated:true}),binding);
}
export function httpError(status, message, extra = {}) { return Object.assign(new Error(message), { status, ...extra }); }
function accountBody(body,fields) {
  if(!body||typeof body!=='object'||Array.isArray(body))throw httpError(422,'Account fields must be an object.',{code:'ACCOUNT_FIELDS'});
  for(const key of Object.keys(body))if(!fields.includes(key))throw httpError(422,key==='login'?'The account login is immutable. Create a separate account when a different login is required.':`The account field ${key} cannot be changed.`,{code:key==='login'?'ACCOUNT_LOGIN_IMMUTABLE':'ACCOUNT_FIELD'});
}
function accountText(value,name,{required=false,limit=250}={}) {
  if(typeof value!=='string')throw httpError(422,`${name} must be text.`,{code:'ACCOUNT_FIELD'});
  const text=value.trim();if((required&&!text)||text.length>limit)throw httpError(422,`${name} ${required?'is required and ':''}must be at most ${limit} characters.`,{code:'ACCOUNT_FIELD'});return text;
}
function accountOrders(value) {
  if(!Array.isArray(value)||value.some(order=>typeof order!=='string'))throw httpError(422,'Orders must be a list of text order numbers.',{code:'ACCOUNT_ORDERS'});
  const result=new Map();for(const order of value){const text=accountText(order,'Order number');if(text&&!result.has(normalize(text)))result.set(normalize(text),text);}return [...result.values()];
}
const accountSnapshot=(row,orders)=>({userId:row.user_id,login:row.login,displayName:row.display_name,role:row.role,organization:row.organization,enabled:row.enabled,mustChangePassword:row.must_change_password,orders});
export function checkPreviewRequest(request,port) {
  const hosts=[`127.0.0.1:${port}`,`localhost:${port}`,`[::1]:${port}`];
  const origin=request.headers.origin;const allowed=hosts.map(host=>`http://${host}`);
  if(!hosts.includes(String(request.headers.host||'').toLowerCase())||(origin&&!allowed.includes(origin))||request.headers['sec-fetch-site']==='cross-site')throw httpError(403,'Local review API requests must come from this application on the same computer.',{code:'PREVIEW_ORIGIN_DENIED'});
}
export function requestAddress(request,trustProxyLoopback=false) {
  const address=request.socket?.remoteAddress||'local';
  const value=request.headers?.['x-real-ip'];
  return trustProxyLoopback&&['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address)&&typeof value==='string'&&isIP(value)?value:address;
}
export function checkPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password) > 1024) throw httpError(422, 'Use a password of at least 12 characters and at most 1024 bytes.');
}
export async function hashPassword(password) {
  checkPassword(password);
  const salt = randomBytes(16);
  const key = await derive('argon2id', { message: password, nonce: salt, memory: 65536, passes: 3, parallelism: 1, tagLength: 32 });
  return `argon2id:65536:3:1:${salt.toString('base64')}:${key.toString('base64')}`;
}
export async function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || Buffer.byteLength(password) > 1024) return false;
  const [algorithm, memory, passes, parallelism, salt, expected] = encoded.split(':');
  if (algorithm !== 'argon2id') return false;
  const key = await derive(algorithm, { message: password, nonce: Buffer.from(salt, 'base64'), memory: Number(memory), passes: Number(passes), parallelism: Number(parallelism), tagLength: 32 });
  const reference = Buffer.from(expected, 'base64');
  return key.length === reference.length && timingSafeEqual(key, reference);
}
export function publicUser(row) {
  return { userId: row.user_id, login: row.login, displayName: row.display_name, role: row.role, organization: row.organization, enabled: row.enabled, mustChangePassword: row.must_change_password, lastLoginAt: row.last_login_at, orders: row.orders || [] };
}
export function canAccess(context, item) {
  return Boolean(item) && (context.role === 'ADMINISTRATOR' || ((context.orders || []).some(order=>normalize(order)===normalize(item.orderNo)) && (context.role !== 'SUPPLIER' || (Boolean(normalize(context.organization))&&normalize(item.supplier)===normalize(context.organization)))));
}

export class AuthService {
  constructor(pool, { secure = true, origin = '', sessionHours = 8, trustProxyLoopback=false,auditRuntime=null } = {}) {
    this.pool = pool; this.secure = secure; this.origin = origin; this.sessionHours = sessionHours;
    this.trustProxyLoopback=trustProxyLoopback;
    this.auditRuntime=auditRuntime;
    this.cookieName = secure ? '__Host-rr_session' : 'rr_session';
    this.loginAttempts = new Map();
  }
  cookie(token, maxAge = this.sessionHours * 3600) {
    return `${this.cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${this.secure ? '; Secure' : ''}`;
  }
  token(request) {
    return String(request.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(`${this.cookieName}=`))?.slice(this.cookieName.length + 1) || '';
  }
  checkOrigin(request) {
    if (request.headers.origin && (!this.origin || request.headers.origin !== this.origin)) throw httpError(403, 'This request origin is not allowed.');
  }
  async context(request) {
    const token = this.token(request);
    if (!/^[a-f0-9]{64}$/.test(token)) return null;
    const result = await this.pool.query(`select u.*, coalesce((select json_agg(a.order_no) from replacement_register.user_order_access a where a.user_id=u.user_id),'[]') as orders
      from replacement_register.sessions s join replacement_register.users u using(user_id)
      where token_hash=$1 and expires_at>now() and enabled=true`, [digest(token)]);
    if (!result.rowCount) return null;
    const user = publicUser(result.rows[0]);
    return bindNamedSession(copyAuditContext(request,{ ...user, actor: user.displayName, csrfToken: digest(`csrf:${token}`), authenticated: true }),Object.freeze({userId:user.userId,tokenHash:digest(token)}));
  }
  async preparationContext(userId,client=this.pool,{lock=false}={}) {
    // Account moderation holds the exclusive form of this transaction lock.
    // Wait before starting the user/orders SELECT so its statement snapshot
    // cannot retain access rows revoked while waiting for the user row lock.
    if(lock)await client.query('select pg_advisory_xact_lock_shared(78742002)');
    const row=(await client.query(`select u.*,coalesce((select json_agg(a.order_no) from replacement_register.user_order_access a where a.user_id=u.user_id),'[]') as orders from replacement_register.users u where user_id=$1${lock?' for share of u':''}`,[userId])).rows[0];
    if(!row?.enabled||row.must_change_password)throw httpError(403,'This account is disabled or must change its password. Sign in and start a new export.',{code:'PREPARATION_ACCOUNT_CHANGED'});
    const user=publicUser(row);return {...user,actor:user.displayName,authenticated:true};
  }
  checkCsrf(request, context) {
    this.checkOrigin(request);
    if (String(request.headers['x-csrf-token'] || '') !== context.csrfToken) throw httpError(403, 'Session verification failed. Refresh the page and try again.');
  }
  async audit(client, context, action, subject, detail, before=null, after=null) {
    const provenance=serializeEventProvenance(context,this.auditRuntime);
    await client.query('insert into replacement_register.audit_events(actor,actor_role,action,subject,detail,actor_user_id,request_id,before_json,after_json,provenance_json) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)', [context.actor || 'Account service', context.role || 'SYSTEM', action, subject, detail, context.userId || null, context.requestId || null,before,after,provenance]);
  }
  async requireAdministrator(client,context) {
    if(context?.role!=='ADMINISTRATOR')throw httpError(403,'Only an administrator can manage accounts.',{code:'ACCOUNT_ADMIN_REQUIRED'});
    if(context.authenticated){
      const row=(await client.query('select enabled,role,must_change_password from replacement_register.users where user_id=$1 for share',[context.userId])).rows[0];
      if(!row?.enabled||row.role!=='ADMINISTRATOR'||row.must_change_password)throw httpError(403,'Administrator access changed. Sign in again before managing accounts.',{code:'ACCOUNT_ADMIN_CHANGED'});
    }
  }
  async login(request, login, password) {
    this.checkOrigin(request);
    const address = requestAddress(request,this.trustProxyLoopback);
    const now = Date.now();
    for (const [key, entry] of this.loginAttempts) if (entry.until < now) this.loginAttempts.delete(key);
    const rate = this.loginAttempts.get(address) || { count: 0, until: now + 15 * 60000 };
    rate.count++; this.loginAttempts.set(address, rate);
    if (rate.count > 25 || this.loginAttempts.size > 10000) throw httpError(429, 'Too many login attempts. Try again later.');
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const result = await client.query('select * from replacement_register.users where login=$1 for update', [String(login || '').trim().toLowerCase()]);
      const row = result.rows[0];
      const valid = row && row.enabled && (!row.locked_until || new Date(row.locked_until) <= new Date()) && await verifyPassword(password, row.password_hash);
      if (!valid) {
        if (row) await client.query("update replacement_register.users set failed_attempts=failed_attempts+1, locked_until=case when failed_attempts>=4 then now()+interval '15 minutes' else locked_until end where user_id=$1", [row.user_id]);
        await this.audit(client, copyAuditContext(request,{requestId:request.requestId}), 'LOGIN_FAILED', row?.user_id || 'unknown', 'Invalid credentials or unavailable account');
        await client.query('commit');
        throw httpError(401, 'Invalid login or password, or the account is temporarily unavailable.');
      }
      const token = randomBytes(32).toString('hex');
      await client.query('delete from replacement_register.sessions where expires_at<=now()');
      await client.query("insert into replacement_register.sessions(token_hash,user_id,expires_at) values($1,$2,now()+$3 * interval '1 hour')", [digest(token), row.user_id, this.sessionHours]);
      await client.query('update replacement_register.users set failed_attempts=0,locked_until=null,last_login_at=now() where user_id=$1', [row.user_id]);
      await this.audit(client, copyAuditContext(request,{ actor: row.display_name, role: row.role, userId: row.user_id,authenticated:true,requestId:request.requestId }), 'LOGIN_SUCCEEDED', row.user_id, 'Named account session created');
      await client.query('commit');
      return { cookie: this.cookie(token), user: publicUser(row), csrfToken: digest(`csrf:${token}`) };
    } catch (error) { await client.query('rollback'); throw error; }
    finally { client.release(); }
  }
  async logout(request, context) {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const tokenHash=digest(this.token(request));
      await client.query('select pg_advisory_xact_lock($1::bigint)',[sessionReleaseKey(tokenHash)]);
      await client.query('delete from replacement_register.sessions where token_hash=$1', [tokenHash]);
      await this.audit(client, context, 'LOGOUT', context.userId, 'Session revoked');
      await client.query('commit');
    } catch (error) { await client.query('rollback'); throw error; }
    finally { client.release(); }
    return this.cookie('', 0);
  }
  async createUser(body, context, { bootstrap = false } = {}) {
    accountBody(body,['login','displayName','role','organization','orders','password']);
    if(!bootstrap&&context?.role!=='ADMINISTRATOR')throw httpError(403,'Only an administrator can create accounts.',{code:'ACCOUNT_ADMIN_REQUIRED'});
    const login = accountText(body.login,'Login',{required:true,limit:120}).toLowerCase();
    const displayName = accountText(body.displayName,'Display name',{required:true,limit:120});
    const role = accountText(body.role,'Role',{required:true}).toUpperCase();
    const organization = body.organization===undefined||body.organization===null?'':accountText(body.organization,'Organization');
    if (!/^[a-z0-9][a-z0-9@._+-]{2,119}$/.test(login) || !displayName || displayName.length > 120 || !roles.has(role) || (role !== 'ADMINISTRATOR' && !organization)) throw httpError(422, 'Provide a valid login, display name, role, and organization for external users.');
    if(bootstrap&&(role!=='ADMINISTRATOR'||!['ADMINISTRATOR','SYSTEM'].includes(context?.role)))throw httpError(403,'Bootstrap creates only the first administrator from local setup.',{code:'ACCOUNT_BOOTSTRAP_ROLE'});
    const orders = accountOrders(body.orders===undefined?[]:body.orders);
    const passwordHash = await hashPassword(body.password);
    const id = randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock(78742002)');
      if (bootstrap && (await client.query('select 1 from replacement_register.users limit 1')).rowCount) throw httpError(409, 'Bootstrap is disabled after the first account exists.');
      if(!bootstrap)await this.requireAdministrator(client,context);
      await client.query('insert into replacement_register.users(user_id,login,display_name,role,organization,password_hash,must_change_password) values($1,$2,$3,$4,$5,$6,$7)', [id, login, displayName, role, organization, passwordHash, !bootstrap]);
      for (const order of orders) await client.query('insert into replacement_register.user_order_access(user_id,order_no) values($1,$2)', [id, order]);
      await this.audit(client, context, 'USER_CREATED', id, JSON.stringify({ login, role, organization, orders }),null,{userId:id,login,displayName,role,organization,orders,mustChangePassword:!bootstrap,enabled:true});
      await client.query('commit');
      return { userId: id, login, displayName, role, organization, orders, mustChangePassword: !bootstrap, enabled: true };
    } catch (error) { await client.query('rollback'); if (error.code === '23505') throw httpError(409, 'This login already exists.'); throw error; }
    finally { client.release(); }
  }
  async listUsers() {
    return (await this.pool.query("select u.*,coalesce((select json_agg(a.order_no) from replacement_register.user_order_access a where a.user_id=u.user_id),'[]') as orders from replacement_register.users u order by login")).rows.map(publicUser);
  }
  async updateUser(id, body, context) {
    accountBody(body,['reason','orders','enabled','temporaryPassword','displayName','role','organization']);
    if(context?.role!=='ADMINISTRATOR')throw httpError(403,'Only an administrator can manage accounts.',{code:'ACCOUNT_ADMIN_REQUIRED'});
    const reason=accountText(body.reason,'Reason for the account change',{required:true,limit:2000});
    const orders=body.orders===undefined?undefined:accountOrders(body.orders);
    const displayName=body.displayName===undefined?undefined:accountText(body.displayName,'Display name',{required:true,limit:120});
    const role=body.role===undefined?undefined:accountText(body.role,'Role',{required:true}).toUpperCase();
    if(role&&!roles.has(role))throw httpError(422,'Select ADMINISTRATOR, SUPPLIER or CLIENT.',{code:'ACCOUNT_ROLE'});
    const organization=body.organization===undefined?undefined:accountText(body.organization,'Organization');
    if(body.enabled!==undefined&&typeof body.enabled!=='boolean')throw httpError(422,'Enabled must be true or false.',{code:'ACCOUNT_ENABLED'});
    if(body.temporaryPassword!==undefined&&typeof body.temporaryPassword!=='string')throw httpError(422,'Temporary password must be text.',{code:'ACCOUNT_PASSWORD'});
    const passwordHash = body.temporaryPassword ? await hashPassword(body.temporaryPassword) : null;
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock(78742002)');
      await this.requireAdministrator(client,context);
      const row = (await client.query('select * from replacement_register.users where user_id=$1 for update', [id])).rows[0];
      if (!row) throw httpError(404, 'Account not found.');
      const beforeOrders=(await client.query('select order_no from replacement_register.user_order_access where user_id=$1 order by order_no',[id])).rows.map(item=>item.order_no);
      const before=accountSnapshot(row,beforeOrders),next={...row,display_name:displayName??row.display_name,role:role??row.role,organization:organization??row.organization,enabled:body.enabled??row.enabled,must_change_password:passwordHash?true:row.must_change_password};
      if(next.role!=='ADMINISTRATOR'&&!next.organization)throw httpError(422,'Organization is required for Supplier and Client accounts.',{code:'ACCOUNT_ORGANIZATION'});
      if(row.enabled&&row.role==='ADMINISTRATOR'&&(!next.enabled||next.role!=='ADMINISTRATOR')&&(await client.query("select 1 from replacement_register.users where role='ADMINISTRATOR' and enabled and user_id<>$1",[id])).rowCount===0)throw httpError(409,'The last enabled administrator cannot be disabled or assigned another role.',{code:'ACCOUNT_LAST_ADMIN'});
      await client.query('update replacement_register.users set enabled=$2,password_hash=coalesce($3,password_hash),must_change_password=case when $3::text is not null then true else must_change_password end,display_name=$4,role=$5,organization=$6,failed_attempts=0,locked_until=null where user_id=$1', [id,next.enabled,passwordHash,next.display_name,next.role,next.organization]);
      if (orders !== undefined) {
        await client.query('delete from replacement_register.user_order_access where user_id=$1', [id]);
        for (const order of orders) await client.query('insert into replacement_register.user_order_access(user_id,order_no) values($1,$2)', [id, order]);
      }
      await client.query('delete from replacement_register.sessions where user_id=$1', [id]);
      const after=accountSnapshot(next,orders??beforeOrders);
      await this.audit(client, context, 'USER_UPDATED', id, JSON.stringify({reason,enabled:next.enabled,orders:after.orders,passwordReset:Boolean(passwordHash),sessionsRevoked:true}),before,after);
      await client.query('commit');
      return { ok: true, sessionsRevoked: true,user:after };
    } catch (error) { await client.query('rollback'); throw error; }
    finally { client.release(); }
  }
  async changePassword(context, currentPassword, password) {
    const passwordHash = await hashPassword(password);
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const { rows } = await client.query('select * from replacement_register.users where user_id=$1 for update', [context.userId]);
      if (!rows[0]?.enabled || !await verifyPassword(currentPassword, rows[0].password_hash)) throw httpError(401, 'Current password is incorrect or the account is unavailable.');
      await client.query('update replacement_register.users set password_hash=$2,must_change_password=false where user_id=$1', [context.userId, passwordHash]);
      await client.query('delete from replacement_register.sessions where user_id=$1', [context.userId]);
      await this.audit(client, context, 'PASSWORD_CHANGED', context.userId, 'All sessions revoked');
      await client.query('commit');
    } catch (error) { await client.query('rollback'); throw error; }
    finally { client.release(); }
  }
}
