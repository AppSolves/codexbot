// Local workerd harness only; this module is never a production entry point.
import worker from '../src/worker/index.js';
import { Store } from '../src/worker/store.js';
import { AdmissionError } from '../src/worker/admission.js';
import { snapshot } from './fixtures.js';
export default {
  ...worker,
  async fetch(request: Request,env: Env): Promise<Response> {
    if(new URL(request.url).pathname!=='/__admission-contract')return worker.fetch(request,env);
    const candidate=snapshot();candidate.config.quotas.cooldown_seconds=0;
    const attempts=await Promise.allSettled([new Store(env.DB).create(candidate,'',true),new Store(env.DB).create({...candidate,id:crypto.randomUUID()},'',true)]);
    const accepted=attempts.filter(item=>item.status==='fulfilled').length;
    const rejected=attempts.find(item=>item.status==='rejected');
    const {results}=await env.DB.prepare('SELECT outcome,phase FROM review_rejections').all();
    return Response.json({accepted,rejected:rejected?.status==='rejected'&&rejected.reason instanceof AdmissionError,outcomes:results});
  }
} satisfies ExportedHandler<Env>;
