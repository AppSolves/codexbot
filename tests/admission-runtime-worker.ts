import {randomSecret,seal} from '../src/core/crypto.js';
import {clean} from './fixtures.js';
// Local workerd harness only; this module is never a production entry point.
import worker from '../src/worker/index.js';
import { Store } from '../src/worker/store.js';
import { AdmissionError } from '../src/worker/admission.js';
import { snapshot } from './fixtures.js';
export default {
  ...worker,
  async fetch(request: Request,env: Env): Promise<Response> {
    if(new URL(request.url).pathname==='/__automatic-contract') {
      const store=new Store(env.DB),candidate={...snapshot(),id:crypto.randomUUID(),installationId:11,repositoryId:22,actorId:55,triggerActor:{login:'bob',id:6},automaticGrantId:''};candidate.config.credentials.automatic_reviewer='alice';
      const envelope=await seal({},randomSecret(),'runtime-owner');await store.saveSession(22,55,envelope,11);await store.automaticConsent(22,11,55,'alice','chatgpt');candidate.automaticGrantId=(await store.automaticGrant(22,11))!.id;
      await store.create(candidate);await store.acquire(candidate);await store.transition(candidate.id,'created','running','123');await store.result(candidate.id,clean(),true,'123');const lease=await store.claimPublication(candidate.id,'123');await store.heartbeat(candidate.id,lease);
      await store.automaticConsent(22,11,55,'alice','chatgpt');let rotateDenied=false,publishDenied=false;
      try{await store.rotate(candidate,1,envelope);}catch{rotateDenied=true;}try{await store.heartbeat(candidate.id,lease);}catch{publishDenied=true;}
      return Response.json({rotateDenied,publishDenied,otherInstallation:await store.automaticGrant(22,12)});
    }
    if(new URL(request.url).pathname!=='/__admission-contract')return worker.fetch(request,env);
    const candidate=snapshot();candidate.config.quotas.cooldown_seconds=0;
    const attempts=await Promise.allSettled([new Store(env.DB).create(candidate,'',true),new Store(env.DB).create({...candidate,id:crypto.randomUUID()},'',true)]);
    const accepted=attempts.filter(item=>item.status==='fulfilled').length;
    const rejected=attempts.find(item=>item.status==='rejected');
    const {results}=await env.DB.prepare('SELECT outcome,phase FROM review_rejections').all();
    return Response.json({accepted,rejected:rejected?.status==='rejected'&&rejected.reason instanceof AdmissionError,outcomes:results});
  }
} satisfies ExportedHandler<Env>;
