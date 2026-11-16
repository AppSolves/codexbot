import type {OAuthSession} from '../auth/oauth.js';
import {requireCondition} from '../core/errors.js';
import {client} from '../worker/github.js';

export const CREDENTIAL_REFRESH_MARGIN_MS=2*60_000;
/** A read-only installation token expires after one hour; renewal rechecks live broker authorization. */
export function renewableContextClient(initial:string,renew:()=>Promise<string>):{github:ReturnType<typeof client>;close:()=>Promise<void>}{
  let token=initial,issuedAt=Date.now(),renewal:Promise<void>|undefined;
  const revoke=async(value:string)=>{try{await client(value).rest.apps.revokeInstallationAccessToken();}catch(error){if(!(error&&typeof error==='object'&&'status' in error&&error.status===401))throw error;}};
  const github=client('');
  github.hook.before('request',async options=>{
    if(renewal)await renewal;
    if(Date.now()-issuedAt>=50*60_000){
      renewal=(async()=>{const next=await renew();requireCondition(Boolean(next)&&!/[\r\n]/.test(next),'missing_read_token');const old=token;token=next;await revoke(old);issuedAt=Date.now();})().finally(()=>{renewal=undefined;});
      await renewal;
    }
    options.headers.authorization='Bearer '+token;
  });
  return{github,close:async()=>{try{await renewal;}finally{await revoke(token);}}};
}
/** Host-only rotation; persist the new session before publishing its access token to the proxy. */
export async function maintainCredential(session:OAuthSession,renew:(session:OAuthSession)=>Promise<OAuthSession>,publish:(token:string)=>Promise<void>,signal:AbortSignal):Promise<void>{
  while(!signal.aborted){
    const next=Math.max(session.earliest_refresh_at,session.expires_at-CREDENTIAL_REFRESH_MARGIN_MS);
    requireCondition(next<session.expires_at,'oauth_refresh_window_unavailable');
    await new Promise<void>(resolve=>{
      const finish=()=>{clearTimeout(timer);signal.removeEventListener('abort',finish);resolve();};
      const timer=setTimeout(finish,Math.max(0,next-Date.now()));signal.addEventListener('abort',finish,{once:true});if(signal.aborted)finish();
    });
    if(signal.aborted)return;
    session=await renew(session);
    requireCondition(session.expires_at-Date.now()>CREDENTIAL_REFRESH_MARGIN_MS,'session_too_short_for_requested_timeout');
    if(!signal.aborted)await publish(session.access_token);
  }
}
