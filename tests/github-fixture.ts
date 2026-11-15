import { Octokit } from '@octokit/rest';
import { stringify } from 'yaml';
import { snapshot, HEAD, BASE, WORKFLOW, files } from './fixtures.js';
export function githubFixture() {
  const config = snapshot().config;
  const state = { privateRepository:false, head: HEAD, base: BASE, permission: 'write', permissionAfterReview: null as string | null, userId: 5, author: 'alice', mergeState: 'CLEAN',
    reviewDecision: 'APPROVED' as string | null, autoMergeAllowed: true, reviews: [] as Record<string, unknown>[], installationId: 1, suspended: false, merged: false,
    ci: 'SUCCESS', guarded: false, requiredApprovals: 1, rules: [] as Record<string, unknown>[], autoMergeOwner: null as string | null,
    humans: [{ id: 80, state: 'APPROVED', commit_id: HEAD, user: { id: 6, login: 'bob', type: 'User' } }] as Record<string, unknown>[],
    checks: [] as Record<string, unknown>[], contextTruncated: false, comments: [] as Record<string, unknown>[], runStatus: 'in_progress', runConclusion: null as string | null,
    permissionsByLogin: {} as Record<string,string>,
    runActor: { id: 42, type: 'Bot', login: 'codexbot[bot]' } };
  const calls: { method: string; path: string; body: Record<string, unknown> }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET', path = url.pathname;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
    calls.push({ method, path, body });
    const ok = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Content-Type': 'application/json' } });
    const repo = { private:state.privateRepository, id: 2, full_name: 'owner/repo', owner: { id: 3, login: 'owner' }, name: 'repo', default_branch: 'main', permissions: { admin: true } };
    if (path === '/repos/owner/repo/installation') return ok({ id: state.installationId, suspended_at: state.suspended ? 'now' : null, permissions: { workflows: 'write' } });
    if (path === '/app/installations/1/access_tokens') return ok({ token: 'fixture-installation-token', expires_at: new Date(Date.now() + 3600_000).toISOString() }, 201);
    if (path === '/repos/owner/repo') return ok(repo);
    if (path === '/repos/owner/repo/branches/main') return ok({ commit: { sha: WORKFLOW }, protected: true });
    if (path === '/repos/owner/repo/rules/branches/main') return ok(state.rules);
    if (path === '/repos/owner/repo/branches/main/protection') return ok({ required_status_checks: { checks: [{ context: 'ci', app_id: null }, ...(state.guarded ? [{ context: config.merge.guard_check, app_id: 42 }] : [])] }, required_pull_request_reviews: { required_approving_review_count: state.requiredApprovals } });
    if (path === '/repos/owner/repo/contents/.codexbot.yml') return ok({ type: 'file', size: 1000, content: Buffer.from(stringify(config)).toString('base64') });
    if (path.includes('/collaborators/') && path.endsWith('/permission')) { const login = decodeURIComponent(path.split('/').at(-2)!); return ok({ permission: state.permissionsByLogin[login] ?? state.permission, user: { id: login === 'github-actions[bot]' ? 41898282 : login === 'alice' ? state.userId : 6, login, type: login === 'github-actions[bot]' ? 'Bot' : 'User' } }); }
    if(path==='/users/bob')return ok({id:6,login:'bob',type:'User'});
    if(path==='/repos/owner/repo/environments')return ok({total_count:1,environments:[{name:'codexbot-1-5'}]});
    if(path==='/repos/owner/repo/environments/codexbot-1-5')return ok({deployment_branch_policy:{protected_branches:false,custom_branch_policies:true}});
    if(path==='/repos/owner/repo/environments/codexbot-1-5/deployment-branch-policies')return ok({total_count:1,branch_policies:[{name:'main',type:'branch'}]});
    if(path.startsWith('/repos/owner/repo/environments/codexbot-1-5/secrets/'))return ok({name:path.split('/').at(-1),created_at:'2026-01-01T00:00:00Z',updated_at:'2026-01-01T00:00:00Z'});
    if (path === '/users/alice' || path === '/user') return ok({ id: state.userId, login: 'alice', type: 'User' });
    if (path === '/repos/owner/repo/pulls/4') return ok({ number: 4, head: { sha: state.head }, base: { sha: state.base, ref: 'main', repo }, user: { id: state.author === 'alice' ? 5 : 7, login: state.author }, state: state.merged ? 'closed' : 'open', merged: state.merged, draft: false, changed_files: 1, commits: 1 });
    if (path === '/repos/owner/repo/issues/4/comments') {
      if (method === 'GET') return ok(state.comments);
      const comment = { ...body, id: 1000 + state.comments.length, user: { type: 'Bot', login: 'codexbot[bot]' }, performed_via_github_app: { id: 42 }, issue_url: 'https://api.github.com/repos/owner/repo/issues/4' };
      state.comments.push(comment); return ok(comment, 201);
    }
    if (/\/repos\/owner\/repo\/issues\/comments\/\d+$/.test(path)) {
      const comment = state.comments.find(x => String(x.id) === path.split('/').at(-1));
      if (!comment) return ok({ message: 'Not Found' }, 404);
      if (method === 'PATCH') Object.assign(comment, body);
      return ok(comment);
    }
    if (path === '/repos/owner/repo/pulls/4/files') return ok(files);
    if (path === '/repos/owner/repo/pulls/4/reviews') {
      if (method === 'GET') return ok([...state.humans, ...state.reviews]);
      const value = { ...body, id: 99 + state.reviews.length, state: body.event ? { APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED', COMMENT: 'COMMENTED' }[String(body.event)] : 'PENDING', user: { type: 'Bot', login: 'codexbot[bot]' } };
      if (!body.event && state.reviews.some(x => x.state === 'PENDING')) return ok({ message: 'Only one pending review is allowed' }, 422);
      state.reviews.push(value); return ok(value, 201);
    }
    if (/\/pulls\/4\/reviews\/\d+\/events$/.test(path)) {
      const review = state.reviews.find(x => String(x.id) === path.split('/').at(-2));
      if (!review || review.state !== 'PENDING') return ok({ message: 'Review not pending' }, 422);
      review.state = { APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED', COMMENT: 'COMMENTED' }[String(body.event)];
      if (state.permissionAfterReview) state.permission = state.permissionAfterReview;
      return ok(review);
    }
    if (/\/pulls\/4\/reviews\/\d+$/.test(path) && method === 'DELETE') {
      const index = state.reviews.findIndex(x => String(x.id) === path.split('/').at(-1) && x.state === 'PENDING');
      if (index < 0) return ok({ message: 'Not a pending review' }, 422);
      state.reviews.splice(index, 1); return ok({});
    }
    if (path === '/repos/owner/repo/actions/workflows/codexbot.yml/dispatches') return new Response(null, { status: 204 });
    const lastDispatch = calls.filter(x => x.path.endsWith('/dispatches')).at(-1)?.body.inputs as Record<string, string> | undefined;
    // Actions embeds a minimal repository, not the full Repositories API object.
    const runRepository = { id: repo.id, name: repo.name, full_name: repo.full_name, owner: repo.owner };
    const run = { id: 123, status: state.runStatus, conclusion: state.runConclusion, event: 'workflow_dispatch', head_sha: WORKFLOW, path: '.github/workflows/codexbot.yml', repository: runRepository, run_attempt: 1, actor: state.runActor, display_title: `CodexBot ${lastDispatch?.request_id} ${lastDispatch?.dispatch_attempt}` };
    if (path === '/repos/owner/repo/actions/runs/123') return ok(run);
    if (path === '/repos/owner/repo/actions/workflows/codexbot.yml/runs') return ok({ workflow_runs: lastDispatch ? [run] : [] });
    if (path.endsWith('/check-runs') && method === 'GET') return ok({ total_count: state.checks.length, check_runs: state.checks });
    if (path === '/repos/owner/repo/check-runs' && method === 'POST') {
      const check = { ...body, id: 200 + state.checks.length, app: { id: 42 }, conclusion: null }; state.checks.push(check); return ok(check, 201);
    }
    if (/\/check-runs\/\d+$/.test(path) && method === 'PATCH') { const check = state.checks.find(x => String(x.id) === path.split('/').at(-1)); Object.assign(check!, body); return ok(check); }
    if (path === '/graphql') {
      const query = String(body.query), variables = body.variables as Record<string, unknown>;
      if (query.includes('enablePullRequestAutoMerge')) {
        if (!state.autoMergeAllowed || state.mergeState === 'CLEAN') return ok({ errors: [{ message: 'Auto merge unavailable or already mergeable' }] });
        if (variables.head !== state.head) return ok({ errors: [{ message: 'Head changed' }] });
        state.autoMergeOwner = 'codexbot[bot]'; return ok({ data: { enablePullRequestAutoMerge: { pullRequest: { id: 'PR_4' } } } });
      }
      if (query.includes('disablePullRequestAutoMerge')) { state.autoMergeOwner = null; return ok({ data: { disablePullRequestAutoMerge: { pullRequest: { id: 'PR_4' } } } }); }
      if (query.includes('mutation') && query.includes('mergePullRequest')) {
        if (variables.head !== state.head || state.mergeState !== 'CLEAN' || state.ci !== 'SUCCESS') return ok({ errors: [{ message: 'Protections hold merge' }] });
        state.merged = true; return ok({ data: { mergePullRequest: { pullRequest: { merged: true } } } });
      }
      return ok({ data: { repository: { autoMergeAllowed: state.autoMergeAllowed, pullRequest: { id: 'PR_4', headRefOid: state.head, baseRefOid: state.base, baseRefName: 'main', state: state.merged ? 'MERGED' : 'OPEN', isDraft: false, mergeStateStatus: state.mergeState,
        reviewDecision: state.reviewDecision, mergeQueueEntry: null, autoMergeRequest: state.autoMergeOwner ? { enabledBy: { login: state.autoMergeOwner } } : null,
        commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { pageInfo: { hasNextPage: state.contextTruncated }, nodes: [{ __typename: 'StatusContext', context: 'ci', state: state.ci }] } } } }] } } } } });
    }
    throw new Error(`Unmocked GitHub endpoint ${method} ${path}`);
  };
  const github = new Octokit({ auth: 'fixture', request: { fetch: fetcher }, log: { debug() {}, info() {}, warn() {}, error() {} } });
  return { github, fetcher, calls, config, state };
}
